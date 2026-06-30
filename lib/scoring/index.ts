import type {
  MarketplaceResult,
  ScoreReason,
  ScoredResult,
  SignalScores,
} from "../types";
import type { RequestBudget } from "../utils/requestBudget";
import { analyzeListingImage } from "./imageSimilarity";
import {
  aggregateScore,
  computeBrandMention,
  computeRiskHeuristic,
  computeTextSimilarity,
} from "./signals";

/**
 * Scoring uses four independent signals:
 *   1. brandMention   — exact + fuzzy brand-name detection (base weight 0.45)
 *   2. textSimilarity — Jaccard overlap vs Comfrt products  (base weight 0.30)
 *   3. riskHeuristic  — price anomaly + suspicious language (base weight 0.25)
 *   4. imageSimilarity — CLIP embedding similarity vs reference images
 *      (applied as a one-directional floor — only ever raises the score)
 *
 * The first three are synchronous and effectively instant. Image similarity is
 * the only slow, network- + CPU-bound signal, so it is computed separately so
 * the cheap base score can be posted immediately and enriched later.
 */

interface BaseSignals {
  parts: Omit<SignalScores, "imageSimilarity">;
  reasons: ScoreReason[];
}

/** Compute the three synchronous (cheap) signals for a listing. */
function computeBaseSignals(listing: MarketplaceResult): BaseSignals {
  const brandResult = computeBrandMention(listing);
  const textResult = computeTextSimilarity(listing);
  const riskResult = computeRiskHeuristic(listing);

  return {
    parts: {
      brandMention: brandResult.score,
      textSimilarity: textResult.score,
      riskHeuristic: riskResult.score,
    },
    reasons: [brandResult.reason, textResult.reason, riskResult.reason],
  };
}

function assemble(
  listing: MarketplaceResult,
  base: BaseSignals,
  imageSimilarity: number | null,
  imageStatus: ScoredResult["imageStatus"]
): ScoredResult {
  const signals: SignalScores = { ...base.parts, imageSimilarity };
  const { totalScore, reasons } = aggregateScore(signals, base.reasons);

  return {
    result: listing,
    totalScore,
    signals,
    reasons,
    scoredAt: Date.now(),
    imageStatus,
  };
}

/**
 * Score a listing using only the three instant signals (brand, text, risk).
 * Image similarity is left null; `imageStatus` indicates whether it is expected
 * to be filled in later ("pending") or will never run ("skipped").
 *
 * This is synchronous and cheap, so every scraped listing can be posted to the
 * UI immediately rather than waiting behind slow CLIP inference.
 */
export function scoreBase(
  listing: MarketplaceResult,
  imageStatus: "pending" | "skipped"
): ScoredResult {
  return assemble(listing, computeBaseSignals(listing), null, imageStatus);
}

/**
 * Re-score a listing including the image-similarity signal. Recomputing the
 * (instant) base signals here keeps the call self-contained; the cost is
 * negligible next to the CLIP embedding.
 *
 * Image similarity failures degrade gracefully (signal stays null), and because
 * image acts as a one-directional floor, a missing image never lowers the score.
 */
export async function scoreResult(
  listing: MarketplaceResult,
  budget: RequestBudget
): Promise<ScoredResult> {
  const base = computeBaseSignals(listing);

  const { imageSimilarity, fetched } = await analyzeListingImage(
    listing.imageUrl,
    listing.id,
    budget
  );

  return assemble(listing, base, imageSimilarity, fetched ? "scored" : "failed");
}
