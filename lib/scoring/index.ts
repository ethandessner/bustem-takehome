import type { MarketplaceResult, ScoredResult, SignalScores } from "../types";
import type { RequestBudget } from "../utils/requestBudget";
import { computeImageSimilarity } from "./imageSimilarity";
import {
  aggregateScore,
  computeBrandMention,
  computeRiskHeuristic,
  computeTextSimilarity,
} from "./signals";

/**
 * Score a single marketplace listing with four independent signals:
 *   1. brandMention   — exact + fuzzy brand-name detection  (weight 0.30)
 *   2. textSimilarity — Jaccard overlap vs Comfrt products   (weight 0.20)
 *   3. imageSimilarity — dHash vs reference images           (weight 0.35)
 *   4. riskHeuristic  — price anomaly + suspicious language  (weight 0.15)
 *
 * Image similarity failures degrade gracefully: the signal is null and its
 * weight is redistributed to the remaining three signals.
 */
export async function scoreResult(
  listing: MarketplaceResult,
  budget: RequestBudget
): Promise<ScoredResult> {
  const brandResult = computeBrandMention(listing);
  const textResult = computeTextSimilarity(listing);
  const riskResult = computeRiskHeuristic(listing);

  // Image similarity may fail — gracefully returns null
  let imageSim: number | null = null;
  try {
    imageSim = await computeImageSimilarity(listing.imageUrl, listing.id, budget);
  } catch {
    // Signal failed — continue scoring with remaining signals
  }

  const signals: SignalScores = {
    brandMention: brandResult.score,
    textSimilarity: textResult.score,
    imageSimilarity: imageSim,
    riskHeuristic: riskResult.score,
  };

  const { totalScore, reasons } = aggregateScore(signals, [
    brandResult.reason,
    textResult.reason,
    riskResult.reason,
  ]);

  return {
    result: listing,
    totalScore,
    signals,
    reasons,
    scoredAt: Date.now(),
  };
}
