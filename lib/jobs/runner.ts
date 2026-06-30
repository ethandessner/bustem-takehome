import type { MarketplaceResult } from "../types";
import { searchAmazon } from "../search/amazon";
import { searchEbay } from "../search/ebay";
import { generateSearchQueries } from "../search/queries";
import { scoreResult } from "../scoring";
import { ConcurrencyLimiter } from "../utils/concurrency";
import { RequestBudget } from "../utils/requestBudget";
import { addMarketplaceError, addResult, setBudgetExhausted, updateJobStatus, updateRequestCounts } from "./jobStore";

/**
 * Soft limit on total outbound requests (search + image) per job.
 * 24 search requests (6 queries × 2 pages × 2 markets) + up to ~96 image
 * requests fits within this budget for a typical run.
 */
export const REQUEST_BUDGET = 250;

/**
 * Searches and scoring run on SEPARATE concurrency lanes so that scoring can
 * begin the instant a search returns, rather than waiting for every search to
 * finish first. A single shared FIFO limiter would enqueue all searches ahead
 * of any scoring task, batching all results to the end of the run. Two
 * independent lanes also sidesteps the deadlock a shared limiter would create
 * (a search task awaiting a scoring slot while holding its own slot).
 */
const SEARCH_CONCURRENCY = 4;
const SCORE_CONCURRENCY = 6;

/**
 * Soft wall-clock deadline for a job. The spec asks jobs to run for "up to 3–5
 * minutes"; we stop scheduling new search/scoring work once this elapses so a
 * large budget can't let a job run indefinitely. In-flight tasks are allowed to
 * finish (their own fetch timeouts bound the overrun).
 */
const JOB_DEADLINE_MS = 4 * 60_000;

export async function runJob(jobId: string): Promise<void> {
  updateJobStatus(jobId, "running");

  const deadline = Date.now() + JOB_DEADLINE_MS;
  const pastDeadline = () => Date.now() > deadline;

  const budget = new RequestBudget(REQUEST_BUDGET, (counts) => {
    updateRequestCounts(jobId, counts);
  });

  const searchLimiter = new ConcurrencyLimiter(SEARCH_CONCURRENCY);
  const scoreLimiter = new ConcurrencyLimiter(SCORE_CONCURRENCY);

  // Deduplicate by marketplace-specific ID to avoid scoring the same item twice
  const seenAmazon = new Set<string>(); // ASINs
  const seenEbay = new Set<string>();   // eBay item IDs

  const queries = generateSearchQueries();

  // Scoring tasks are tracked so the job can await any in-flight scoring after
  // all searches complete. They run on their own limiter, so pushing a task
  // here lets it start immediately (interleaved with ongoing searches) and the
  // result is posted the moment that single listing finishes scoring.
  const scoringTasks: Array<Promise<void>> = [];

  const scoreListing = (listing: MarketplaceResult) =>
    scoreLimiter.run(async () => {
      if (pastDeadline()) return;
      if (!budget.canMakeRequest()) {
        setBudgetExhausted(jobId);
        return;
      }

      try {
        const scored = await scoreResult(listing, budget);
        // Post each result as soon as it is scored and ranked.
        addResult(jobId, scored);
      } catch (err) {
        console.warn(
          `[runner] Scoring failed for listing ${listing.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    });

  try {
    await Promise.all(
      queries.map((query) =>
        searchLimiter.run(async () => {
          if (pastDeadline()) return;
          if (!budget.canMakeRequest()) {
            setBudgetExhausted(jobId);
            return;
          }

          const type = query.marketplace === "amazon" ? "amazon" : "ebay";
          budget.consume(type);

          let listings: MarketplaceResult[] = [];
          try {
            listings =
              query.marketplace === "amazon"
                ? await searchAmazon(query.query, query.page)
                : await searchEbay(query.query, query.page);
          } catch (err) {
            console.warn(
              `[runner] Search failed: "${query.query}" p${query.page} on ${query.marketplace}:`,
              err instanceof Error ? err.message : err
            );
            addMarketplaceError(jobId, query.marketplace);
            return;
          }

          // Dedup at schedule time and kick off scoring immediately. Scoring
          // runs on its own lane, so freshly scraped listings start scoring
          // while later search pages are still being fetched.
          for (const listing of listings) {
            const seenSet =
              listing.marketplace === "amazon" ? seenAmazon : seenEbay;
            if (seenSet.has(listing.id)) continue;
            seenSet.add(listing.id);
            scoringTasks.push(scoreListing(listing));
          }
        })
      )
    );

    // All searches done; wait for any in-flight/queued scoring to finish.
    await Promise.all(scoringTasks);

    updateJobStatus(jobId, "complete");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    updateJobStatus(jobId, "error", message);
  }
}
