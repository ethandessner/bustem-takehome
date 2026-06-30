# Comfrt Infringement Detector — Bustem Take-Home

A Next.js app that runs a real-time infringement-detection pipeline for fake **Comfrt** listings on Amazon and eBay. Built as a 2–3 hour take-home exercise.

---

## Install & Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and click **Start Search Job**.

> **Requires Node 18+.** The app calls [ScraperAPI](https://www.scraperapi.com/) for structured Amazon and eBay results. An API key is embedded in `lib/search/amazon.ts` and `lib/search/ebay.ts` for convenience — in a real project this would live in `.env.local`.
>
> On the first run, the CLIP image model (~90 MB, quantized) is downloaded once by `@huggingface/transformers` and cached on disk. Subsequent runs reuse the cache.

---

## How a search job works

1. **Start** — clicking "Start Search Job" sends `POST /api/jobs/start`, which creates a job record and fires the runner as a background async task (fire-and-forget, not blocking the HTTP response).

2. **Poll** — the browser fetches the job immediately, then polls `GET /api/jobs/[jobId]` every 1.5 s and re-renders as results arrive.

3. **Run** — the runner executes search queries and per-listing scoring on **two separate concurrency lanes** (see below), deduplicates listings, and **streams each result into the job store the moment it is scored and ranked** — not in a batch at the end.

4. **Complete** — the job transitions to `complete` when all queries finish, the request budget is exhausted, or the wall-clock deadline is reached. The UI stops polling.

The job store is a plain `Map` on `globalThis`, which survives Next.js hot reloads in development.

---

## What queries are used

Six distinct search terms are generated from known Comfrt product names:

| Query | Purpose |
|---|---|
| `comfrt hoodie` | Classic Hoodie variants |
| `comfrt sweatshirt` | Crewneck variants |
| `comfrt sweatsuit` | Matching set / two-piece |
| `comfrt pullover` | Pullover variants |
| `comfrt matching set` | Lounge set variants |
| `comfrt cloud hoodie` | Cloud Hoodie line |

Each query runs on **both Amazon and eBay**, across **page 1 and page 2**, producing **24 total search requests** per job. See `lib/search/queries.ts`.

---

## How deduplication works

The runner maintains two `Set`s per job — one for Amazon ASINs and one for eBay item IDs (the eBay item id is parsed out of the listing's `/itm/<id>` URL, since the structured endpoint has no dedicated id field). When a listing appears in multiple query results (e.g. the same hoodie surfaces for both "comfrt hoodie" and "comfrt pullover"), it is scored exactly once. Subsequent encounters are skipped at schedule time, so duplicates never even consume a scoring slot.

---

## Scoring signals

Each listing is scored with four independent signals. The final score is a 0–100 number (the 0–1 infringement probability × 100).

| Signal | Role | How it works |
|---|---|---|
| **Brand Mention** | Base weight **45%** | Exact "comfrt" in title → 1.0; in brand/description → 0.8; fuzzy match by Levenshtein edit-distance 1 → 0.65, distance 2 → 0.3; known legitimate brand (Nike, Adidas, etc.) → 0.0 |
| **Text Similarity** | Base weight **30%** | Jaccard token-overlap between the listing title and every known Comfrt product name and keyword. Returns the best match (0–1). |
| **Risk Heuristic** | Base weight **25%** | Combines price anomaly (apparel < $20 → 0.85, < $30 → 0.55), suspicious title terms ("dupe", "replica", "inspired by", …) → 0.75, suspicious seller patterns ("dropship", "wholesale", "factory", …) → 0.70, and digits-in-seller-name → 0.35. The explanation lists every trigger. |
| **Image Similarity** | One-directional **floor** | Embeds the listing image with **CLIP (ViT-B/32)** via `@huggingface/transformers`, then takes the max cosine similarity against the cached Comfrt reference-image embeddings. Calibrated so only genuinely close visual matches score high (see below). Returns `null` if the image can't be fetched. |

### Final score calculation

```
base  = (brandMention×0.45 + textSimilarity×0.30 + riskHeuristic×0.25)   // renormalised to sum to 1
score = max(base, imageSimilarity × 0.95)                                // image only RAISES the score
```

Brand, text, and risk form a renormalised weighted average — these are *symmetric* signals where a low value genuinely points toward a legitimate listing. **Image similarity is treated asymmetrically:** a high value is strong proof a listing reuses a Comfrt photo, but a low value is uninformative (counterfeiters shoot their own photos). So image similarity is applied as a one-directional **floor** — it can only push the score *up*, never dilute it. This lets a brandless counterfeit with a copied photo still get flagged, while a genuine listing whose photo simply doesn't match keeps its brand/text/risk score instead of being dragged down.

If `imageSimilarity` is `null` (fetch failed or budget/deadline reached), it's simply skipped — the base score stands, and the UI notes that the image signal was unavailable.

**Why CLIP instead of a perceptual hash?** A pHash/dHash only matches near-identical *pixels*. CLIP embeddings capture *semantic* content, so a counterfeit shot from a different angle, on a different model, against a different background still lands close to the reference in embedding space. Because any hoodie scores ~0.80 cosine against a Comfrt hoodie, the raw cosine is calibrated with a noise floor of 0.78 and a match ceiling of 0.90 (`lib/scoring/imageSimilarity.ts`) so only genuinely close matches drive the score up.

**Interpreting scores:**
- **≥ 75** — High risk (likely infringing)
- **45–74** — Medium risk (warrants review)
- **< 45** — Low risk (probably legitimate)

### Explainability

Every result exposes three things in the UI: the final score, the top human-readable contributing reasons (previewed on the card), and the raw per-signal values with weights in the expandable "Show signals" view for inspection/debugging.

---

## Orchestration constraints

**Two concurrency lanes.** Searches and scoring run on independent semaphores (`lib/utils/concurrency.ts`): up to **4** in-flight searches and **6** in-flight scoring tasks. Keeping them separate is what makes results stream — scoring a freshly scraped listing starts immediately rather than waiting behind every remaining search — and it avoids the deadlock a single shared lane would create.

**Soft request budget.** A cap of **250 total outbound requests** per job (24 search + image fetches for scoring) is enforced via a counter (`lib/utils/requestBudget.ts`). When reached, remaining listings are skipped and the UI shows a "Request budget reached" notice. Adjust via `REQUEST_BUDGET` in `lib/jobs/runner.ts`.

**Wall-clock deadline.** A soft **4-minute** deadline (`JOB_DEADLINE_MS`) stops scheduling new search/scoring work once elapsed, so a large budget can't let a job run indefinitely. In-flight tasks finish (their own 15 s fetch timeouts bound the overrun).

**Graceful degradation.** Any single failure is contained: a failed search increments a per-marketplace error counter and is skipped; a failed image fetch returns `null` so the listing is still scored on brand/text/risk. The UI surfaces total elapsed time and request counts broken down by platform (Amazon / eBay / Images / Other).

---

## Known limitations and tradeoffs

**Hardcoded API key** — The ScraperAPI key is in source. For a real deployment it should be an environment variable and rotated regularly.

**In-memory job store** — Jobs are lost on server restart. A Redis or Postgres-backed store would be needed for production (see `ARCHITECTURE.md`).

**No auth** — Any user can start a job and exhaust the request budget. A real system would require authentication and per-user rate limiting.

**Reference image URLs** — The reference image URLs in `lib/reference/comfrtProducts.ts` were collected manually from the Comfrt Shopify storefront. If they rotate, the affected reference embedding is dropped at load time and image similarity degrades gracefully. New URLs can be obtained from `https://comfrt.com/products.json`.

**CLIP runs in-process** — Embedding inference runs on the Node.js event loop. At high concurrency or with slow upstreams this can delay poll responses. A real system would run scoring in a separate worker (see `ARCHITECTURE.md`).

**No feedback loop** — Scores are not validated against human review, so false-positive/negative rates are unknown. `ARCHITECTURE.md` describes how a labeling + recalibration loop would work at scale.
