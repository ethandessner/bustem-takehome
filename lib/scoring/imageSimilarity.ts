import {
  AutoProcessor,
  CLIPVisionModelWithProjection,
  RawImage,
} from "@huggingface/transformers";
import type { RequestBudget } from "../utils/requestBudget";
import { COMFRT_REFERENCE_IMAGES } from "../reference/comfrtProducts";

// ---------------------------------------------------------------------------
// Image analysis: CLIP embedding similarity
//
// The listing image is fetched and embedded with CLIP (ViT-B/32); the max
// cosine similarity against the Comfrt reference images becomes the signal.
// CLIP captures semantic visual content, so a reused/near-duplicate product
// photo lands close to a reference even across crops/backgrounds.
//
// The model runs locally via onnxruntime-node (no external API / key). Weights
// are downloaded once on first use and cached on disk by transformers.js.
// ---------------------------------------------------------------------------

/** CLIP checkpoint. ViT-B/32 is a good speed/quality balance for similarity. */
const MODEL_ID = "Xenova/clip-vit-base-patch32";
/** Quantized weights keep the download small (~90MB) and CPU inference fast. */
const MODEL_DTYPE = "q8" as const;

// Calibration constants, derived from a measured ViT-B/32 cosine sample against
// THIS reference set (on-model studio shots):
//   • generic non-Comfrt hoodies (true negatives):  ~0.63–0.85  (max 0.85)
//   • genuine Comfrt products, different photo:      ~0.74–0.87
//   • reused / near-identical Comfrt photo:          ~0.90–1.00
//
// The negative and "same-brand-different-photo" bands overlap heavily — CLIP
// cannot reliably tell a Comfrt hoodie from any grey hoodie-on-a-model. So we
// treat image similarity as a NEAR-DUPLICATE detector: the noise floor sits at
// the top of the measured negative band so generic apparel maps low, while a
// reused/near-identical product photo (cosine ~0.88–0.95) drives the score up.
//
// Calibration note: a 0.80 floor keeps a worst-case generic hoodie (~0.85
// cosine) around 40 — below the 75 "high match" line — while a genuinely reused
// photo (~0.90) lands near 79 and an exact reuse (~0.92+) saturates at 100. An
// earlier 0.86 floor was over-tight: it compressed real near-duplicates from
// ~94% down into the 20–75% range, hiding the very copies we want to surface.
// Brand/text carry "is it Comfrt"; image carries "is this literally Comfrt's
// photo". These two constants are the main tuning knobs.
const NOISE_FLOOR = 0.80;
const MATCH_CEILING = 0.92;

function calibrate(cosine: number): number {
  const scaled = (cosine - NOISE_FLOOR) / (MATCH_CEILING - NOISE_FLOOR);
  return Math.max(0, Math.min(1, scaled));
}

// ---------------------------------------------------------------------------
// Model + reference-embedding singletons (computed once per process)
// ---------------------------------------------------------------------------

type ClipBundle = {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof CLIPVisionModelWithProjection.from_pretrained>>;
};

let modelPromise: Promise<ClipBundle> | null = null;

function getModel(): Promise<ClipBundle> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const [processor, model] = await Promise.all([
        AutoProcessor.from_pretrained(MODEL_ID),
        CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
          dtype: MODEL_DTYPE,
        }),
      ]);
      return { processor, model };
    })();
  }
  return modelPromise;
}

/** Fetch raw image bytes with a hard timeout so a slow URL can't pin a slot. */
async function fetchImageBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ComfrtBot/1.0)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

function l2normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** Cosine similarity of two L2-normalised vectors (i.e. their dot product). */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

async function embedImage(image: RawImage): Promise<Float32Array> {
  const { processor, model } = await getModel();
  const inputs = await processor(image);
  const output = await model(inputs);
  const data = output.image_embeds.data as Float32Array;
  return l2normalize(Float32Array.from(data));
}

async function embedFromBytes(bytes: Uint8Array): Promise<Float32Array> {
  const image = await RawImage.fromBlob(new Blob([bytes as BlobPart]));
  return embedImage(image);
}

let refEmbeddingsPromise: Promise<Float32Array[]> | null = null;

function getReferenceEmbeddings(): Promise<Float32Array[]> {
  if (!refEmbeddingsPromise) {
    refEmbeddingsPromise = (async () => {
      const settled = await Promise.allSettled(
        COMFRT_REFERENCE_IMAGES.map(async (url) => {
          const bytes = await fetchImageBytes(url);
          return embedFromBytes(bytes);
        })
      );
      const ok: Float32Array[] = [];
      for (const r of settled) {
        if (r.status === "fulfilled") ok.push(r.value);
        else console.warn("[imageSimilarity] reference embed failed:", r.reason);
      }
      return ok;
    })();
  }
  return refEmbeddingsPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ImageAnalysis {
  /** Calibrated CLIP similarity 0–1, or null if it could not be computed */
  imageSimilarity: number | null;
  /** True if the image was successfully fetched (so the signal was attempted) */
  fetched: boolean;
}

/**
 * Fetch a listing image and compute its CLIP similarity to the references.
 *
 * Consumes a single image request from the budget. Failures degrade
 * gracefully: a failed fetch/embedding yields a null signal (fetched=false).
 */
export async function analyzeListingImage(
  imageUrl: string | undefined,
  _listingId: string,
  budget: RequestBudget
): Promise<ImageAnalysis> {
  if (!imageUrl || !budget.canMakeRequest()) {
    return { imageSimilarity: null, fetched: false };
  }

  budget.consume("image");

  let bytes: Uint8Array;
  try {
    bytes = await fetchImageBytes(imageUrl);
  } catch (err) {
    console.warn(
      "[imageSimilarity] image fetch failed:",
      err instanceof Error ? err.message : err
    );
    return { imageSimilarity: null, fetched: false };
  }

  let imageSimilarity: number | null = null;
  try {
    const refs = await getReferenceEmbeddings();
    if (refs.length > 0) {
      const embedding = await embedFromBytes(bytes);
      let best = -1;
      for (const ref of refs) best = Math.max(best, dot(embedding, ref));
      imageSimilarity = calibrate(best);
    }
  } catch (err) {
    console.warn(
      "[imageSimilarity] CLIP embedding failed:",
      err instanceof Error ? err.message : err
    );
  }

  return { imageSimilarity, fetched: true };
}
