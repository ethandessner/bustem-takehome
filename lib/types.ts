export type Marketplace = "amazon" | "ebay";

export type JobStatus = "pending" | "running" | "complete" | "error";

export interface RequestCounts {
  amazon: number;
  ebay: number;
  image: number;
  other: number;
}

export interface SearchJob {
  id: string;
  status: JobStatus;
  startedAt: number;
  completedAt?: number;
  results: ScoredResult[];
  requestCounts: RequestCounts;
  /** Soft cap on total outbound requests for this job */
  requestBudget: number;
  /** Number of failed search requests per marketplace */
  marketplaceErrors: { amazon: number; ebay: number };
  /** True when the job stopped early because the request budget was exhausted */
  budgetExhausted: boolean;
  error?: string;
}

export interface MarketplaceResult {
  /** ASIN for Amazon, item_id for eBay */
  id: string;
  marketplace: Marketplace;
  title: string;
  /** 0 means price was not available */
  price: number;
  currency: string;
  sellerName: string;
  listingUrl: string;
  imageUrl?: string;
  description?: string;
  brand?: string;
  fetchedAt: number;
}

export interface SignalScores {
  /** 0–1 — exact/fuzzy brand-name detection. Base weight: 0.45 */
  brandMention: number;
  /** 0–1 — token overlap with known Comfrt product names. Base weight: 0.30 */
  textSimilarity: number;
  /** 0–1 — calibrated CLIP embedding similarity vs reference images; null if fetch failed.
   *  Applied as a one-directional floor (raises score only), not a weighted term. */
  imageSimilarity: number | null;
  /** 0–1 — price anomaly + suspicious title/seller signals combined. Base weight: 0.25 */
  riskHeuristic: number;
}

export interface ScoreReason {
  signal: keyof SignalScores;
  score: number;
  explanation: string;
}

/**
 * Lifecycle of the (expensive) image-similarity signal for a result:
 *  - "pending" — base signals are scored and posted; CLIP embedding is queued
 *  - "scored"  — image embedding completed and is reflected in the score
 *  - "skipped" — image not run (no image URL, base score already conclusive,
 *                or the budget/deadline was reached before it could run)
 *  - "failed"  — image fetch/embedding was attempted but errored
 */
export type ImageStatus = "pending" | "scored" | "skipped" | "failed";

export interface ScoredResult {
  result: MarketplaceResult;
  /** 0–100 infringement probability (scaled from 0–1 weighted average) */
  totalScore: number;
  signals: SignalScores;
  reasons: ScoreReason[];
  scoredAt: number;
  /** Tracks whether the image signal has run; drives progressive enrichment UI */
  imageStatus: ImageStatus;
}
