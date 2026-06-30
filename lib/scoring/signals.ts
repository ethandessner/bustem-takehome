import type { MarketplaceResult, ScoreReason, SignalScores } from "../types";
import { COMFRT_PRODUCTS } from "../reference/comfrtProducts";
import { stringSimilarity } from "./textSimilarity";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEGITIMATE_BRANDS = [
  "nike",
  "champion",
  "lululemon",
  "supreme",
  "gildan",
  "adidas",
  "under armour",
  "columbia",
  "patagonia",
  "north face",
  "carhartt",
];

const SUSPICIOUS_TITLE_TERMS = [
  "dupe",
  "inspired",
  "inspired by",
  "viral",
  "luxury",
  "replica",
  "comfrt style",
  "comfrt inspired",
  "like comfrt",
  "similar to comfrt",
  "comfrt look",
  "comfrt knock",
];

const SUSPICIOUS_SELLER_PATTERNS = [
  "dropship",
  "replica",
  "outlet",
  "bazaar",
  "import",
  "wholesale",
  "bulk",
  "factory",
  "reseller",
  "warehouse",
];

const APPAREL_TERMS_RE =
  /hoodie|sweatshirt|tee|shirt|sweatpants|jogger|crewneck|pullover|sweatsuit|fleece/i;

// ---------------------------------------------------------------------------
// Levenshtein distance (used for fuzzy brand matching)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Single-row DP approach (O(n) space)
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ---------------------------------------------------------------------------
// Signal 1: Brand / title match
// ---------------------------------------------------------------------------

/**
 * Detects Comfrt brand references in the listing title and brand field.
 *
 * Scoring tiers:
 *  1.0 — exact "comfrt" in title
 *  0.8 — "comfrt" in brand/description but not title
 *  0.65 — fuzzy match (edit distance 1 from "comfrt") in a title token
 *  0.3  — fuzzy match (edit distance 2 from "comfrt") in a title token
 *  0.0  — listing belongs to a known legitimate brand
 */
export function computeBrandMention(listing: MarketplaceResult): {
  score: number;
  reason: ScoreReason;
} {
  const titleLower = listing.title.toLowerCase();
  const allText =
    `${listing.title} ${listing.brand ?? ""} ${listing.description ?? ""}`.toLowerCase();

  // Legitimate brand check short-circuits first
  if (LEGITIMATE_BRANDS.some((b) => allText.includes(b))) {
    return {
      score: 0,
      reason: {
        signal: "brandMention",
        score: 0,
        explanation: "Listing belongs to a known legitimate brand.",
      },
    };
  }

  // Exact brand name in title
  if (titleLower.includes("comfrt")) {
    return {
      score: 1.0,
      reason: {
        signal: "brandMention",
        score: 1.0,
        explanation: 'Exact brand name "comfrt" found in listing title.',
      },
    };
  }

  // Brand name in other fields (brand tag, description)
  if (allText.includes("comfrt")) {
    return {
      score: 0.8,
      reason: {
        signal: "brandMention",
        score: 0.8,
        explanation: '"comfrt" found in brand or description field.',
      },
    };
  }

  // Fuzzy token search in title — catches typos like "comfrrt", "c0mfrt"
  const tokens = titleLower.split(/\s+/).filter((t) => t.length >= 4 && t.length <= 9);
  for (const token of tokens) {
    const dist = levenshtein(token, "comfrt");
    if (dist === 1) {
      return {
        score: 0.65,
        reason: {
          signal: "brandMention",
          score: 0.65,
          explanation: `Likely typo/variant "${token}" in title (edit distance 1 from "comfrt").`,
        },
      };
    }
    if (dist === 2) {
      return {
        score: 0.3,
        reason: {
          signal: "brandMention",
          score: 0.3,
          explanation: `Possible variant "${token}" in title (edit distance 2 from "comfrt").`,
        },
      };
    }
  }

  return {
    score: 0,
    reason: {
      signal: "brandMention",
      score: 0,
      explanation: "No Comfrt brand terms detected in title or fields.",
    },
  };
}

// ---------------------------------------------------------------------------
// Signal 2: Text similarity
// ---------------------------------------------------------------------------

/**
 * Compares the listing title against every known Comfrt product name and
 * keyword using Jaccard token-overlap similarity.  Returns the best match.
 */
export function computeTextSimilarity(listing: MarketplaceResult): {
  score: number;
  reason: ScoreReason;
} {
  let maxSim = 0;
  let matchedLabel = "";

  for (const product of COMFRT_PRODUCTS) {
    const nameSim = stringSimilarity(listing.title, product.name);
    if (nameSim > maxSim) {
      maxSim = nameSim;
      matchedLabel = product.name;
    }
    for (const kw of product.keywords) {
      const kwSim = stringSimilarity(listing.title, kw);
      if (kwSim > maxSim) {
        maxSim = kwSim;
        matchedLabel = kw;
      }
    }
  }

  return {
    score: maxSim,
    reason: {
      signal: "textSimilarity",
      score: maxSim,
      explanation:
        maxSim > 0.15
          ? `Title is ${Math.round(maxSim * 100)}% similar to "${matchedLabel}".`
          : "Title has low token overlap with known Comfrt product names.",
    },
  };
}

// ---------------------------------------------------------------------------
// Signal 4: Risk heuristics
// ---------------------------------------------------------------------------

/**
 * Combines price-anomaly and suspicious-language signals into a single risk
 * score.  Designed to be transparent — the explanation lists every trigger.
 *
 * Inputs considered:
 *  - Price vs. expected Comfrt retail range ($30–$140 depending on product)
 *  - Suspicious words in title/description ("dupe", "inspired", "replica", …)
 *  - Suspicious seller name patterns ("dropship", "wholesale", "factory", …)
 *  - Unverified seller indicator (digits in seller name)
 */
export function computeRiskHeuristic(listing: MarketplaceResult): {
  score: number;
  reason: ScoreReason;
} {
  const allText =
    `${listing.title} ${listing.description ?? ""} ${listing.sellerName}`.toLowerCase();
  const sellerLower = listing.sellerName.toLowerCase();

  let score = 0;
  const triggers: string[] = [];

  // Price anomaly — only flag when the item looks like Comfrt apparel
  if (APPAREL_TERMS_RE.test(listing.title) && listing.price > 0) {
    if (listing.price < 20) {
      score = Math.max(score, 0.85);
      triggers.push(
        `price $${listing.price.toFixed(2)} is far below Comfrt retail ($30–$140)`
      );
    } else if (listing.price < 30) {
      score = Math.max(score, 0.55);
      triggers.push(
        `price $${listing.price.toFixed(2)} is below typical Comfrt retail`
      );
    }
  }

  // Suspicious terms in title or description
  for (const term of SUSPICIOUS_TITLE_TERMS) {
    if (allText.includes(term)) {
      score = Math.max(score, 0.75);
      triggers.push(`suspicious term "${term}" found in listing`);
      break; // one trigger is enough per category
    }
  }

  // Suspicious seller name
  const matchedSeller = SUSPICIOUS_SELLER_PATTERNS.find((p) =>
    sellerLower.includes(p)
  );
  if (matchedSeller) {
    score = Math.max(score, 0.70);
    triggers.push(
      `seller "${listing.sellerName}" matches suspicious pattern "${matchedSeller}"`
    );
  } else if (/\d/.test(listing.sellerName)) {
    // Digits-only heuristic (weaker signal — newer/unverified accounts)
    score = Math.max(score, 0.35);
    triggers.push(`seller "${listing.sellerName}" appears unverified (digits in name)`);
  }

  if (triggers.length === 0) {
    return {
      score: 0,
      reason: {
        signal: "riskHeuristic",
        score: 0,
        explanation: "No significant risk signals detected.",
      },
    };
  }

  return {
    score,
    reason: {
      signal: "riskHeuristic",
      score,
      explanation: triggers.join("; "),
    },
  };
}

// ---------------------------------------------------------------------------
// Weighted aggregation
// ---------------------------------------------------------------------------

/**
 * Weights for the "symmetric" signals — ones where a LOW value is itself
 * informative (low brand/text overlap and no risk triggers genuinely point
 * toward a legitimate or unrelated listing). These three form the base score
 * and are renormalised to sum to 1.
 *
 * imageSimilarity is deliberately NOT a weighted term here — see below.
 */
const WEIGHTS = {
  brandMention: 0.45,
  textSimilarity: 0.30,
  riskHeuristic: 0.25,
} as const;

/**
 * Image similarity (perceptual hash) is ASYMMETRIC evidence:
 *  - A HIGH value is strong proof the listing reuses/copies a Comfrt photo.
 *  - A LOW value is uninformative — counterfeiters shoot their own photos, so a
 *    low hash does NOT mean the listing is legitimate.
 *
 * Therefore image similarity must never DILUTE the base score; it only ever
 * RAISES it, acting as a floor proportional to the strength of the visual
 * match. This is what lets a brandless counterfeit (brand/text ~0) still be
 * flagged, while a genuine listing whose photo simply doesn't hash-match keeps
 * its brand/text/risk-driven score instead of being dragged down.
 */
const IMAGE_FLOOR_SCALE = 95;

/**
 * Combines the signals into a final 0–100 infringement score.
 *
 * Base = weighted average of brand / text / risk (renormalised to sum to 1).
 * Image similarity then applies a one-directional floor: it can only raise the
 * score, never lower it.
 */
export function aggregateScore(
  signals: SignalScores,
  reasons: ScoreReason[]
): { totalScore: number; reasons: ScoreReason[] } {
  const baseKeys = ["brandMention", "textSimilarity", "riskHeuristic"] as const;

  let total = 0;
  let usedWeight = 0;
  for (const key of baseKeys) {
    total += signals[key] * WEIGHTS[key];
    usedWeight += WEIGHTS[key];
  }

  let totalScore = usedWeight > 0 ? Math.round((total / usedWeight) * 100) : 0;

  const allReasons = [...reasons];

  if (signals.imageSimilarity === null) {
    allReasons.push({
      signal: "imageSimilarity",
      score: 0,
      explanation: "Image fetch failed or budget exhausted — signal skipped (does not lower the score).",
    });
  } else {
    const imgPct = Math.round(signals.imageSimilarity * 100);
    allReasons.push({
      signal: "imageSimilarity",
      score: signals.imageSimilarity,
      explanation: `Visual hash comparison: ${imgPct}% similarity to closest Comfrt reference image.`,
    });

    // One-directional floor: image evidence only raises the score.
    const imageFloor = Math.round(signals.imageSimilarity * IMAGE_FLOOR_SCALE);
    if (imageFloor > totalScore) {
      allReasons.push({
        signal: "imageSimilarity",
        score: signals.imageSimilarity,
        explanation: `Visual match (${imgPct}%) to a Comfrt product image raised the score to ${imageFloor}, outweighing weak brand/text signals.`,
      });
      totalScore = imageFloor;
    }
  }

  return { totalScore, reasons: allReasons };
}
