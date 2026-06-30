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
export const REQUEST_BUDGET = 120;

/** Max simultaneous in-flight requests (search + image combined). */
const MAX_CONCURRENT = 5;

export async function runJob(jobId: string): Promise<void> {
  updateJobStatus(jobId, "running");

  const budget = new RequestBudget(REQUEST_BUDGET, (counts) => {
    updateRequestCounts(jobId, counts);
  });

  const limiter = new ConcurrencyLimiter(MAX_CONCURRENT);

  // Deduplicate by marketplace-specific ID to avoid scoring the same item twice
  const seenAmazon = new Set<string>(); // ASINs
  const seenEbay = new Set<string>();   // eBay item IDs

  const queries = generateSearchQueries();

  // Scoring tasks are scheduled on the same limiter as searches but are NOT
  // awaited inside a search task. Awaiting them there would hold the search's
  // concurrency slot while waiting for scoring slots on the same limiter,
  // deadlocking once all slots are occupied by waiting search tasks.
  const scoringTasks: Array<Promise<void>> = [];

  const scoreListing = (listing: MarketplaceResult) =>
    limiter.run(async () => {
      const seenSet =
        listing.marketplace === "amazon" ? seenAmazon : seenEbay;

      if (seenSet.has(listing.id)) return;
      seenSet.add(listing.id);

      if (!budget.canMakeRequest()) {
        setBudgetExhausted(jobId);
        return;
      }

      try {
        const scored = await scoreResult(listing, budget);
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
        limiter.run(async () => {
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

          // Schedule scoring without holding this search's slot, so freed
          // slots can be claimed by scoring tasks as searches complete.
          for (const listing of listings) {
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
