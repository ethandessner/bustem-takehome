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

---

## How a search job works

1. **Start** — clicking "Start Search Job" sends `POST /api/jobs/start`, which creates a job record and fires the runner as a background async task (fire-and-forget, not blocking the HTTP response).

2. **Poll** — the browser polls `GET /api/jobs/[jobId]` every 1.5 s and re-renders the page as results arrive.

3. **Run** — the runner executes all search queries concurrently (up to 5 in-flight at once), deduplicates listings, scores each one, and streams results into the in-memory job store.

4. **Complete** — when all queries finish (or the request budget is exhausted), the job transitions to `complete`. The UI stops polling.

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

The runner maintains two `Set`s per job — one for Amazon ASINs and one for eBay item IDs. When a listing appears in multiple query results (e.g. the same hoodie surfaces for both "comfrt hoodie" and "comfrt pullover"), it is scored exactly once. Subsequent encounters are silently skipped.

---

## Scoring signals

Each listing is scored 0–100 across four independent signals, then combined with a weighted average:

| Signal | Weight | How it works |
|---|---|---|
| **Brand Mention** | 30% | Exact string match for "comfrt" in title → 1.0; in brand/description → 0.8; fuzzy (edit-distance 1) → 0.65; fuzzy (edit-distance 2) → 0.3; known legitimate brand (Nike, Adidas, etc.) → 0.0 |
| **Text Similarity** | 20% | Jaccard token-overlap between the listing title and every known Comfrt product name and keyword. Returns the best match score (0–1). |
| **Image Similarity** | 35% | Fetches the listing image, computes a 64-bit difference hash (dHash via `sharp`), then measures Hamming distance against 8 reference Comfrt product images. Returns the best similarity (0–1), or `null` if the image could not be fetched. |
| **Risk Heuristic** | 15% | Combines three sub-signals: (1) price anomaly — apparel priced below $20 → 0.85, below $30 → 0.55; (2) suspicious title terms — "dupe", "replica", "inspired by", etc. → 0.75; (3) suspicious seller patterns — "dropship", "wholesale", "factory", etc. → 0.70; digits in seller name → 0.35. |

### Final score calculation

```
score = brandMention×0.30 + textSimilarity×0.20 + imageSimilarity×0.35 + riskHeuristic×0.15
```

If `imageSimilarity` is `null` (fetch failed or budget exhausted), its 35% weight is redistributed proportionally among the other three signals so the total always sums to 100%. The final score is multiplied by 100 and rounded to the nearest integer.

**Interpreting scores:**
- **≥ 75** — High risk (likely infringing)
- **45–74** — Medium risk (warrants review)
- **< 45** — Low risk (probably legitimate)

---

## Request budget

The runner enforces a soft cap of **200 total outbound requests** per job (24 search + up to ~176 image fetches). When the budget is reached, remaining listings are skipped and the UI shows a "Request budget reached" notice. This prevents runaway costs on a shared API key.

Concurrency is capped at **5 simultaneous in-flight requests** via a queue-based semaphore (`lib/utils/concurrency.ts`).

---

## Known limitations and tradeoffs

**Hardcoded API key** — The ScraperAPI key is in source. For a real deployment it should be an environment variable and rotated regularly.

**In-memory job store** — Jobs are lost on server restart. A Redis or Postgres-backed store would be needed for production.

**No auth** — Any user can start a job and exhaust the request budget. A real system would require authentication and per-user rate limiting.

**Reference image URLs** — The 8 Shopify CDN URLs in `lib/reference/comfrtProducts.ts` were collected manually. If they rotate (CDN cache busting, product updates), image similarity silently degrades to `null` and the weight is redistributed. New URLs can be obtained by right-clicking product images on [comfrt.com](https://comfrt.com).

**dHash sensitivity** — Difference hashing is fast and works well for identical or near-identical images, but can return false negatives when sellers use different product photos (different angle, background, crop). A cloud Vision API or embedding-based similarity would be more robust.

**No feedback loop** — Scores are not validated against human review. False-positive and false-negative rates are unknown. See `ARCHITECTURE.md` for how a feedback loop would work at scale.

**Single process** — The background runner blocks the Node.js event loop proportionally. At high concurrency or with slow upstream APIs this can cause 1.5 s poll responses to queue up. A real system would run the runner in a separate worker process or queue.
