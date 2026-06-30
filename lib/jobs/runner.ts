import type { MarketplaceResult, ScoredResult } from "../types";
import { searchAmazon } from "../search/amazon";
import { searchEbay } from "../search/ebay";
import { generateSearchQueries } from "../search/queries";
import { scoreBase, scoreResult } from "../scoring";
import { ConcurrencyLimiter } from "../utils/concurrency";
import { RequestBudget } from "../utils/requestBudget";
import { addMarketplaceError, addResult, setBudgetExhausted, updateJobStatus, updateRequestCounts, upsertResult } from "./jobStore";

/**
 * Soft limit on total outbound requests (search + image) per job.
 * 60 search requests (10 queries × 3 pages × 2 markets) plus per-listing image
 * fetches share this budget; searches run first, the rest goes to image scoring.
 */
export const REQUEST_BUDGET = 500;

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

/**
 * Base-score threshold above which we skip the (expensive) image signal.
 *
 * Image similarity is a one-directional floor — it can only RAISE a score. A
 * listing already scoring ≥ this on brand/text/risk is firmly in the "High
 * risk" tier, and the image floor (max ~95) couldn't change that tier. So we
 * reserve scarce CLIP inference time/budget for the borderline and low-base
 * listings where a copied photo can actually change the ranking (e.g. brandless
 * counterfeits reusing Comfrt product images).
 */
const IMAGE_SCORE_GATE = 75;

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

  // Image-enrichment tasks are tracked so the job can await any in-flight image
  // scoring after all searches/base-scoring complete. They run on their own
  // limiter so the slow CLIP work never blocks the instant base scoring.
  const imageTasks: Array<Promise<void>> = [];

  /**
   * Phase 2: enrich an already-posted base result with the image signal,
   * replacing it in place. Degrades to "skipped" if the deadline/budget hit
   * before the image could run, so the UI never shows a stuck "pending".
   */
  const enrichWithImage = (listing: MarketplaceResult, base: ScoredResult) =>
    scoreLimiter.run(async () => {
      if (pastDeadline()) {
        upsertResult(jobId, { ...base, imageStatus: "skipped" });
        return;
      }
      if (!budget.canMakeRequest()) {
        setBudgetExhausted(jobId);
        upsertResult(jobId, { ...base, imageStatus: "skipped" });
        return;
      }

      try {
        const enriched = await scoreResult(listing, budget);
        upsertResult(jobId, enriched);
      } catch (err) {
        console.warn(
          `[runner] Image scoring failed for listing ${listing.id}:`,
          err instanceof Error ? err.message : err
        );
        upsertResult(jobId, { ...base, imageStatus: "failed" });
      }
    });

  /**
   * Phase 1: score the three instant signals and post the result immediately,
   * so every scraped listing appears right away regardless of image throughput.
   * Only listings where the image could change the ranking get queued for the
   * slow CLIP pass.
   */
  const scoreListing = (listing: MarketplaceResult) => {
    const base = scoreBase(listing, listing.imageUrl ? "pending" : "skipped");

    const willScoreImage =
      !!listing.imageUrl && base.totalScore < IMAGE_SCORE_GATE;

    addResult(
      jobId,
      willScoreImage ? base : { ...base, imageStatus: "skipped" }
    );

    if (willScoreImage) {
      imageTasks.push(enrichWithImage(listing, base));
    }
  };

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

          // Dedup at schedule time, then score+post the base signals instantly
          // and (if worthwhile) queue the slow image pass. Base results appear
          // immediately while later search pages are still being fetched.
          for (const listing of listings) {
            const seenSet =
              listing.marketplace === "amazon" ? seenAmazon : seenEbay;
            if (seenSet.has(listing.id)) continue;
            seenSet.add(listing.id);
            scoreListing(listing);
          }
        })
      )
    );

    // All searches and base scoring done; wait for any in-flight/queued image
    // enrichment to finish (those past the deadline resolve immediately).
    await Promise.all(imageTasks);

    updateJobStatus(jobId, "complete");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    updateJobStatus(jobId, "error", message);
  }
}
