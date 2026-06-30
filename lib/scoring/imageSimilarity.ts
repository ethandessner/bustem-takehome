import {
  AutoProcessor,
  CLIPVisionModelWithProjection,
  RawImage,
} from "@huggingface/transformers";
import type { RequestBudget } from "../utils/requestBudget";
import { COMFRT_REFERENCE_IMAGES } from "../reference/comfrtProducts";

// ---------------------------------------------------------------------------
// CLIP image-embedding similarity
//
// We embed each image with CLIP (ViT-B/32) and compare listing images to the
// Comfrt reference images by cosine similarity of their embeddings.
//
// Unlike a perceptual hash (which only matches near-identical *pixels*), CLIP
// embeddings capture *semantic* content — so a counterfeit photographed from a
// different angle, on a different model, against a different background still
// lands close to the reference in embedding space. This is what lets us catch
// "same style of garment, different photo" rip-offs that hashing misses.
//
// The model runs locally via onnxruntime-node (no external API / key). Weights
// are downloaded once on first use and cached on disk by transformers.js.
// ---------------------------------------------------------------------------

/** CLIP checkpoint. ViT-B/32 is a good speed/quality balance for similarity. */
const MODEL_ID = "Xenova/clip-vit-base-patch32";
/** Quantized weights keep the download small (~90MB) and CPU inference fast. */
const MODEL_DTYPE = "q8" as const;

// Calibration constants, derived from measured ViT-B/32 cosine spread:
//   • unrelated (apparel vs non-apparel):        ~0.25–0.31
//   • same broad category, different garment:    ~0.70–0.83
//   • near-identical design / reused photo:      ~0.88–1.00
//
// Because *any* hoodie scores ~0.80 against a Comfrt hoodie, a low floor would
// flag all apparel. We set NOISE_FLOOR above the generic same-category band so
// only genuinely close visual matches drive the score up; a confident match
// maps to 1. These are the main tuning knobs for image precision/recall.
const NOISE_FLOOR = 0.78;
const MATCH_CEILING = 0.9;

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

/** Fetch an image with a hard timeout, so a slow/hanging URL can't pin a
 *  concurrency slot. transformers.js `RawImage.read(url)` has no timeout. */
async function fetchImage(url: string): Promise<RawImage> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ComfrtBot/1.0)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return RawImage.fromBlob(await res.blob());
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

async function embed(image: RawImage): Promise<Float32Array> {
  const { processor, model } = await getModel();
  const inputs = await processor(image);
  const output = await model(inputs);
  const data = output.image_embeds.data as Float32Array;
  return l2normalize(Float32Array.from(data));
}

let refEmbeddingsPromise: Promise<Float32Array[]> | null = null;

function getReferenceEmbeddings(): Promise<Float32Array[]> {
  if (!refEmbeddingsPromise) {
    refEmbeddingsPromise = (async () => {
      const settled = await Promise.allSettled(
        COMFRT_REFERENCE_IMAGES.map(async (url) => {
          const image = await fetchImage(url);
          return embed(image);
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

/**
 * Embeds the listing image with CLIP and returns the maximum calibrated cosine
 * similarity against the cached Comfrt reference embeddings (0–1).
 *
 * Returns null (signal skipped, never penalised) if:
 *  - imageUrl is missing
 *  - the request budget is exhausted
 *  - no reference embeddings are available
 *  - the image fetch / embedding fails
 *
 * Failure is always graceful — callers continue scoring with the other signals.
 */
export async function computeImageSimilarity(
  imageUrl: string | undefined,
  _listingId: string,
  budget: RequestBudget
): Promise<number | null> {
  if (!imageUrl) return null;
  if (!budget.canMakeRequest()) return null;

  budget.consume("image");

  try {
    const refs = await getReferenceEmbeddings();
    if (refs.length === 0) return null;

    const image = await fetchImage(imageUrl);
    const embedding = await embed(image);

    let best = -1;
    for (const ref of refs) {
      const sim = dot(embedding, ref);
      if (sim > best) best = sim;
    }

    return calibrate(best);
  } catch (err) {
    console.warn(
      "[imageSimilarity] embedding failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
