import sharp from "sharp";
import type { RequestBudget } from "../utils/requestBudget";
import { COMFRT_REFERENCE_IMAGES } from "../reference/comfrtProducts";

// ---------------------------------------------------------------------------
// Perceptual hashing (dHash + aHash)
//
// We combine two complementary perceptual hashes for a stronger, less noisy
// match than a single 64-bit dHash:
//
//   • dHash (difference hash) — captures gradient/edge structure. Resize to
//     (N+1)×N grayscale, compare each pixel to its right neighbour → N×N bits.
//   • aHash (average hash)    — captures coarse tonal layout. Resize to N×N
//     grayscale, compare each pixel to the frame mean → N×N bits.
//
// Using N=16 gives 256 bits per hash (512 combined), which discriminates far
// better than the old 64-bit dHash. The two hash bit-arrays are concatenated
// and compared with a single Hamming distance.
//
// Raw Hamming similarity has a high noise floor: two *unrelated* images still
// agree on ~50% of bits by chance. We therefore calibrate the raw similarity
// (see calibrateSimilarity) so the noise baseline maps to ~0 and only genuine
// visual matches produce a high signal.
// ---------------------------------------------------------------------------

/** Hash grid dimension (N×N bits per hash). */
const HASH_N = 16;
const HASH_BITS = HASH_N * HASH_N;

/** Concatenated dHash+aHash bits as a Uint8Array of 0/1 values. */
type PerceptualHash = Uint8Array;

/**
 * Raw similarity below this is treated as noise (unrelated images agree on
 * ~50% of bits by chance) and calibrated to 0.
 */
const NOISE_FLOOR = 0.6;
/** Raw similarity at/above this is treated as a confident visual match → 1. */
const MATCH_CEILING = 0.9;

/** Rescale raw Hamming similarity so the noise floor maps to 0 and a confident match to 1. */
function calibrateSimilarity(raw: number): number {
  const scaled = (raw - NOISE_FLOOR) / (MATCH_CEILING - NOISE_FLOOR);
  return Math.max(0, Math.min(1, scaled));
}

async function bufferToHash(buffer: Buffer): Promise<PerceptualHash> {
  const base = sharp(buffer).grayscale();

  // dHash: (N+1)×N, compare horizontally adjacent pixels.
  const { data: dData } = await base
    .clone()
    .resize(HASH_N + 1, HASH_N, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // aHash: N×N, compare each pixel to the frame mean.
  const { data: aData } = await base
    .clone()
    .resize(HASH_N, HASH_N, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hash = new Uint8Array(HASH_BITS * 2);
  let idx = 0;

  for (let row = 0; row < HASH_N; row++) {
    for (let col = 0; col < HASH_N; col++) {
      const pixIdx = row * (HASH_N + 1) + col;
      hash[idx++] = dData[pixIdx] > dData[pixIdx + 1] ? 1 : 0;
    }
  }

  let sum = 0;
  for (let i = 0; i < HASH_BITS; i++) sum += aData[i];
  const mean = sum / HASH_BITS;
  for (let i = 0; i < HASH_BITS; i++) {
    hash[idx++] = aData[i] > mean ? 1 : 0;
  }

  return hash;
}

function hammingDistance(a: PerceptualHash, b: PerceptualHash): number {
  let count = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) count++;
  }
  return count;
}

/** Calibrated similarity: 1 = confident visual match, 0 = noise/unrelated. */
function hashSimilarity(a: PerceptualHash, b: PerceptualHash): number {
  const raw = 1 - hammingDistance(a, b) / a.length;
  return calibrateSimilarity(raw);
}

// ---------------------------------------------------------------------------
// Reference hash cache — computed lazily, once per process lifetime
// ---------------------------------------------------------------------------

/** Map from reference image URL to its perceptual hash (or null if it failed to load). */
const referenceHashCache = new Map<string, PerceptualHash | null>();

/** Singleton promise so concurrent first-calls don't duplicate the work. */
let initPromise: Promise<void> | null = null;

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ComfrtBot/1.0)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function initReferenceHashes(): Promise<void> {
  await Promise.allSettled(
    COMFRT_REFERENCE_IMAGES.map(async (url) => {
      try {
        const buf = await fetchBuffer(url);
        const hash = await bufferToHash(buf);
        referenceHashCache.set(url, hash);
      } catch {
        // Image unavailable — mark as null; will be skipped during comparison
        referenceHashCache.set(url, null);
      }
    })
  );
}

function getValidRefHashes(): PerceptualHash[] {
  return [...referenceHashCache.values()].filter((h): h is PerceptualHash => h !== null);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches the listing image, computes its perceptual hash (dHash+aHash), and
 * returns the maximum calibrated similarity against all cached reference Comfrt
 * product hashes (0–1).
 *
 * Returns null if:
 *  - imageUrl is missing
 *  - the request budget is exhausted
 *  - the image fetch or hash computation fails
 *
 * Failure is always graceful — callers should continue scoring with the
 * remaining signals when this returns null.
 */
export async function computeImageSimilarity(
  imageUrl: string | undefined,
  _listingId: string,
  budget: RequestBudget
): Promise<number | null> {
  if (!imageUrl) return null;
  if (!budget.canMakeRequest()) return null;

  budget.consume("image");

  // Lazily initialise reference hashes (no extra budget cost — done once)
  if (!initPromise) {
    initPromise = initReferenceHashes();
  }
  await initPromise;

  const refHashes = getValidRefHashes();
  if (refHashes.length === 0) {
    // No reference images loaded — skip this signal rather than returning 0
    return null;
  }

  let listingBuffer: Buffer;
  try {
    listingBuffer = await fetchBuffer(imageUrl);
  } catch {
    return null;
  }

  let listingHash: PerceptualHash;
  try {
    listingHash = await bufferToHash(listingBuffer);
  } catch {
    return null;
  }

  const maxSimilarity = refHashes.reduce(
    (best, refHash) => Math.max(best, hashSimilarity(listingHash, refHash)),
    0
  );

  return maxSimilarity;
}
