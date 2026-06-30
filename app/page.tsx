"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Marketplace, RequestCounts, ScoredResult, SearchJob } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function scoreRing(score: number): string {
  if (score >= 75) return "bg-red-600 text-white";
  if (score >= 45) return "bg-orange-500 text-white";
  return "bg-emerald-600 text-white";
}

function scoreCardBg(score: number): string {
  if (score >= 75) return "bg-red-50 border-red-200";
  if (score >= 45) return "bg-orange-50 border-orange-200";
  return "bg-emerald-50 border-emerald-200";
}

function scoreLabel(score: number): string {
  if (score >= 75) return "High risk";
  if (score >= 45) return "Medium";
  return "Low risk";
}

function marketplaceBadge(mp: Marketplace) {
  return mp === "amazon"
    ? "bg-yellow-100 text-yellow-800 border border-yellow-300"
    : "bg-blue-100 text-blue-800 border border-blue-300";
}

const SIGNAL_LABELS: Record<string, string> = {
  brandMention: "Brand Mention",
  textSimilarity: "Text Similarity",
  imageSimilarity: "Image Similarity",
  riskHeuristic: "Risk Heuristic",
};

const SIGNAL_WEIGHTS: Record<string, string> = {
  brandMention: "45%",
  textSimilarity: "30%",
  imageSimilarity: "floor",
  riskHeuristic: "25%",
};

const SIGNAL_CONTEXT: Record<string, string> = {
  brandMention:    "Base weight 45%. Tiers: 0 = not found · 30 = distant fuzzy match · 65 = close typo · 80 = in description · 100 = exact in title",
  textSimilarity:  "Base weight 30%. Jaccard word-token overlap vs Comfrt product names. Short titles max out ~40–50%; 15%+ is a meaningful match.",
  imageSimilarity: "One-directional floor (raises score only, never lowers). Calibrated CLIP embedding tuned as a near-duplicate detector: 0 = generic apparel, 100 = reused/near-identical Comfrt photo.",
  riskHeuristic:   "Base weight 25%. Rule-triggered tiers: 0 = no flags · 35 = unverified seller · 55 = below-retail price · 70–85 = suspicious seller / terms",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortKey = "score-desc" | "score-asc" | "marketplace" | "price-asc";
type MarketplaceFilter = "all" | Marketplace;
type DisplayStatus = "idle" | "running" | "completed" | "failed";

function toDisplayStatus(job: SearchJob | null): DisplayStatus {
  if (!job) return "idle";
  if (job.status === "complete") return "completed";
  if (job.status === "error") return "failed";
  return "running"; // pending or running both render as "running"
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: DisplayStatus }) {
  const configs: Record<DisplayStatus, { label: string; cls: string }> = {
    idle:      { label: "Idle",      cls: "bg-gray-100 text-gray-600" },
    running:   { label: "Running",   cls: "bg-blue-100 text-blue-700 animate-pulse" },
    completed: { label: "Completed", cls: "bg-green-100 text-green-700" },
    failed:    { label: "Failed",    cls: "bg-red-100 text-red-700" },
  };
  const { label, cls } = configs[status];
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${cls}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SignalBar
// ---------------------------------------------------------------------------

function SignalBar({ value, label, weight, context }: { value: number | null; label: string; weight?: string; context?: string }) {
  const pct = value === null ? 0 : Math.round(value * 100);
  const color = pct >= 75 ? "bg-red-500" : pct >= 45 ? "bg-orange-400" : "bg-emerald-500";

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="w-32 shrink-0 text-gray-600">{label}</span>
        {weight && <span className="text-gray-500 text-[10px] w-7 text-right">{weight}</span>}
        <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
          {value !== null ? (
            <div
              className={`h-full rounded-full ${color} transition-all`}
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="h-full rounded-full bg-gray-300 w-full opacity-40" />
          )}
        </div>
        <span className="w-10 text-right text-gray-700 font-mono">
          {value === null ? "n/a" : `${pct}%`}
        </span>
      </div>
      {context && (
        <p className="text-[10px] text-gray-400 pl-38 leading-snug">{context}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ResultCard
// ---------------------------------------------------------------------------

function ResultCard({ item }: { item: ScoredResult }) {
  const [expanded, setExpanded] = useState(false);
  const { result, totalScore, signals, reasons, imageStatus } = item;

  // Pick the 2 most informative reasons to preview in the collapsed card.
  // Filter out trivial/null signals, then sort by score descending.
  const previewReasons = reasons
    .filter((r) => r.score > 0.1 && r.signal !== "imageSimilarity")
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  return (
    <div className={`border rounded-xl overflow-hidden transition-shadow hover:shadow-sm ${scoreCardBg(totalScore)}`}>
      {/* ── Collapsed row ── */}
      <div className="px-4 py-3 flex items-start gap-3">
        {/* Thumbnail */}
        <div className="shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-gray-100 border border-gray-200 flex items-center justify-center">
          {result.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={result.imageUrl}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <span className="text-gray-300 text-[10px] text-center leading-tight px-1">No image</span>
          )}
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-3">
            <p className="font-medium text-sm leading-snug flex-1 min-w-0 line-clamp-2 text-gray-900">
              {result.title}
            </p>
            {/* Score circle */}
            <div className="shrink-0 flex flex-col items-center gap-0.5">
              <span
                className={`w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold ${scoreRing(totalScore)}`}
              >
                {totalScore}
              </span>
              <span className="text-[10px] text-gray-500 leading-none">{scoreLabel(totalScore)}</span>
            </div>
          </div>

          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs">
            <span className={`px-1.5 py-0.5 rounded text-xs font-medium capitalize ${marketplaceBadge(result.marketplace)}`}>
              {result.marketplace}
            </span>
            {result.price > 0 ? (
              <span className="text-gray-700 font-medium">${result.price.toFixed(2)}</span>
            ) : (
              <span className="text-gray-500 italic">Price N/A</span>
            )}
            <span className="text-gray-600 truncate max-w-56">{result.sellerName}</span>
            {imageStatus === "pending" && (
              <span className="text-blue-600 text-[11px] animate-pulse">⏳ scoring image…</span>
            )}
          </div>

          {/* Top-contributing reasons preview */}
          {previewReasons.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {previewReasons.map((r, i) => (
                <li key={i} className="text-xs text-gray-700 flex gap-1">
                  <span className="shrink-0 text-gray-500">›</span>
                  <span className="line-clamp-1">{r.explanation}</span>
                </li>
              ))}
            </ul>
          )}

          {/* Action row */}
          <div className="flex items-center gap-4 mt-2">
            <a
              href={result.listingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:underline font-medium"
              onClick={(e) => e.stopPropagation()}
            >
              View listing →
            </a>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              {expanded ? "▲ Hide signals" : "▼ Show signals"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Expanded: raw signal debug view ── */}
      {expanded && (
        <div className="border-t px-4 py-3 space-y-3 bg-white/70">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-gray-700">Raw Signal Values</p>
            {/* Column headers */}
            <div className="flex items-center gap-2 text-[10px] text-gray-400 pb-0.5">
              <span className="w-32 shrink-0">Signal</span>
              <span className="w-7 text-right">Weight</span>
              <span className="flex-1" />
              <span className="w-10 text-right">Score</span>
            </div>
            {(Object.keys(SIGNAL_LABELS) as (keyof typeof SIGNAL_LABELS)[]).map((key) => (
              <SignalBar
                key={key}
                label={SIGNAL_LABELS[key]}
                weight={SIGNAL_WEIGHTS[key]}
                context={SIGNAL_CONTEXT[key]}
                value={signals[key as keyof typeof signals] as number | null}
              />
            ))}
            {signals.imageSimilarity === null && imageStatus === "pending" && (
              <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1.5 mt-1">
                ⏳ Scoring image similarity… this result will update automatically when the CLIP embedding finishes.
              </p>
            )}
            {signals.imageSimilarity === null && imageStatus === "skipped" && (
              <p className="text-[11px] text-gray-600 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 mt-1">
                Image similarity skipped — {result.imageUrl
                  ? "brand/text/risk signals were already conclusive, so CLIP time was reserved for borderline listings"
                  : "no listing image was available"}. Image similarity can only raise a score, so skipping it never lowers this one.
              </p>
            )}
            {signals.imageSimilarity === null && imageStatus === "failed" && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-1">
                ⚠ Image similarity unavailable — the image could not be fetched. The score is based on brand, text, and risk signals only; image similarity can only raise a score, so a missing image never lowers it.
              </p>
            )}
          </div>

          <div>
            <p className="text-xs font-semibold text-gray-700 mb-1.5">All Scoring Reasons</p>
            <ul className="space-y-1">
              {reasons.map((r, i) => (
                <li key={i} className="text-xs text-gray-600 flex gap-1.5">
                  <span className="shrink-0 text-gray-400 font-medium min-w-28">{SIGNAL_LABELS[r.signal] ?? r.signal}:</span>
                  <span>{r.explanation}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Home() {
  const [job, setJob] = useState<SearchJob | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const [sortKey, setSortKey] = useState<SortKey>("score-desc");
  const [marketplaceFilter, setMarketplaceFilter] = useState<MarketplaceFilter>("all");
  const [minScore, setMinScore] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    pollRef.current = null;
    timerRef.current = null;
  }, []);

  const startPolling = useCallback(
    async (id: string) => {
      stopPolling();
      startTimeRef.current = Date.now();

      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current);
      }, 500);

      // Fetch immediately so the job state (and disabled button) is set before
      // isStarting resets to false — no gap where the button is clickable again.
      try {
        const res = await fetch(`/api/jobs/${id}`);
        if (res.ok) {
          const data: SearchJob = await res.json();
          setJob(data);
          if (data.status === "complete" || data.status === "error") {
            stopPolling();
            return;
          }
        }
      } catch {
        // Continue to interval polling even if the immediate fetch fails
      }

      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/jobs/${id}`);
          if (!res.ok) return;
          const data: SearchJob = await res.json();
          setJob(data);
          if (data.status === "complete" || data.status === "error") {
            stopPolling();
          }
        } catch {
          // Network error — retry next interval silently
        }
      }, 1500);
    },
    [stopPolling]
  );

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  async function startSearch() {
    setIsStarting(true);
    setJob(null);
    setElapsedMs(0);
    setSortKey("score-desc");
    setMarketplaceFilter("all");
    setMinScore(0);
    stopPolling();

    try {
      const res = await fetch("/api/jobs/start", { method: "POST" });
      const { jobId: id } = await res.json();
      startPolling(id);
    } finally {
      setIsStarting(false);
    }
  }

  const displayStatus = toDisplayStatus(job);
  const isRunning = displayStatus === "running";
  const results = job?.results ?? [];

  const filtered = results.filter((r) => {
    if (marketplaceFilter !== "all" && r.result.marketplace !== marketplaceFilter) return false;
    if (r.totalScore < minScore) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    switch (sortKey) {
      case "score-desc":    return b.totalScore - a.totalScore;
      case "score-asc":     return a.totalScore - b.totalScore;
      case "marketplace": {
        const byMarket = a.result.marketplace.localeCompare(b.result.marketplace);
        return byMarket !== 0 ? byMarket : b.totalScore - a.totalScore;
      }
      case "price-asc":     return a.result.price - b.result.price;
    }
  });

  const counts: RequestCounts = job?.requestCounts ?? { amazon: 0, ebay: 0, image: 0, other: 0 };
  const totalRequests = counts.amazon + counts.ebay + counts.image + counts.other;

  const elapsedDisplay = job
    ? formatElapsed(
        isRunning
          ? elapsedMs
          : (job.completedAt ?? job.startedAt) - job.startedAt
      )
    : "00:00";

  const hasMarketplaceErrors =
    job && (job.marketplaceErrors.amazon > 0 || job.marketplaceErrors.ebay > 0);

  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      {/* ── Header ── */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <h1 className="text-xl font-semibold text-gray-900">Comfrt Infringement Detector</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Scans Amazon &amp; eBay for suspected fake Comfrt listings using brand, text, image, and risk signals
          </p>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-6 space-y-4">
        {/* ── Job control panel ── */}
        <section className="bg-white border border-gray-200 rounded-xl px-5 py-4 space-y-3">
          {/* Button + status row */}
          <div className="flex flex-wrap items-center gap-4">
            <button
              onClick={startSearch}
              disabled={isStarting || isRunning}
              className="px-5 py-2.5 bg-gray-900 text-white text-sm font-semibold rounded-lg disabled:opacity-50 hover:bg-gray-700 active:bg-gray-800 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              {isStarting ? "Starting…" : isRunning ? "Running…" : "Start Search Job"}
            </button>

            <div className="flex items-center gap-3">
              <StatusBadge status={displayStatus} />
              {job && (
                <span className="font-mono text-sm text-gray-600 bg-gray-100 px-2.5 py-1 rounded-md">
                  ⏱ {elapsedDisplay}
                </span>
              )}
            </div>
          </div>

          {/* Request metrics */}
          {job && (
            <div className="border-t pt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-600">
              <div className="flex items-center gap-1.5">
                <span className="text-gray-400">Requests:</span>
                <span className="font-semibold text-gray-800">{totalRequests} / {job.requestBudget}</span>
                <div className="w-24 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gray-400 rounded-full"
                    style={{ width: `${Math.min(100, (totalRequests / job.requestBudget) * 100)}%` }}
                  />
                </div>
              </div>
              <span>Amazon <strong className="text-gray-800">{counts.amazon}</strong></span>
              <span>eBay <strong className="text-gray-800">{counts.ebay}</strong></span>
              <span>Images <strong className="text-gray-800">{counts.image}</strong></span>
              {counts.other > 0 && <span>Other <strong className="text-gray-800">{counts.other}</strong></span>}
              {job.budgetExhausted && (
                <span className="text-amber-700 font-medium">⚠ Request budget reached — results may be partial</span>
              )}
            </div>
          )}
        </section>

        {/* ── Error / warning banners ── */}
        {job?.status === "error" && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            <strong>Job failed:</strong> {job.error ?? "Unknown error"}
          </div>
        )}

        {hasMarketplaceErrors && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
            <strong>Marketplace fetch errors:</strong>{" "}
            {[
              job!.marketplaceErrors.amazon > 0 && `Amazon (${job!.marketplaceErrors.amazon} failed query${job!.marketplaceErrors.amazon !== 1 ? "s" : ""})`,
              job!.marketplaceErrors.ebay > 0   && `eBay (${job!.marketplaceErrors.ebay} failed query${job!.marketplaceErrors.ebay !== 1 ? "s" : ""})`,
            ]
              .filter(Boolean)
              .join(", ")}
            {" — "}partial results shown. This is normal when ScraperAPI rate-limits individual queries.
          </div>
        )}

        {/* ── Filters ── */}
        {results.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg px-4 py-3 flex flex-wrap items-center gap-4">
            {/* Sort */}
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500 text-xs">Sort:</span>
              {(
                [
                  ["score-desc", "Score ↓"],
                  ["score-asc",  "Score ↑"],
                  ["marketplace","Marketplace"],
                  ["price-asc",  "Price ↑"],
                ] as [SortKey, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSortKey(key)}
                  className={`px-2 py-0.5 rounded text-xs cursor-pointer ${
                    sortKey === key
                      ? "bg-gray-900 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Marketplace filter */}
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500 text-xs">Market:</span>
              {(["all", "amazon", "ebay"] as MarketplaceFilter[]).map((mp) => (
                <button
                  key={mp}
                  onClick={() => setMarketplaceFilter(mp)}
                  className={`px-2 py-0.5 rounded text-xs capitalize cursor-pointer ${
                    marketplaceFilter === mp
                      ? "bg-gray-900 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {mp}
                </button>
              ))}
            </div>

            {/* Min score slider */}
            <div className="flex items-center gap-2">
              <span className="text-gray-500 text-xs">Min score:</span>
              <input
                type="range"
                min={0}
                max={100}
                value={minScore}
                onChange={(e) => setMinScore(Number(e.target.value))}
                className="w-24 accent-gray-900"
              />
              <span className="text-gray-700 font-mono text-xs w-6 text-right">{minScore}</span>
            </div>
          </div>
        )}

        {/* ── Results list ── */}
        {sorted.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 mb-2 px-0.5">
              {sorted.length} result{sorted.length !== 1 ? "s" : ""}
              {results.length !== sorted.length ? ` of ${results.length} total` : ""}
              {isRunning && " — updating live…"}
            </p>
            <div className="space-y-2">
              {sorted.map((item) => (
                <ResultCard key={item.result.id} item={item} />
              ))}
            </div>
          </div>
        )}

        {/* ── Empty / loading states ── */}

        {isRunning && results.length === 0 && (
          <div className="text-center py-16 space-y-2">
            <p className="text-3xl">🔍</p>
            <p className="text-gray-500 text-sm font-medium">Scanning Amazon and eBay…</p>
            <p className="text-gray-400 text-xs">Results will appear here as they arrive</p>
          </div>
        )}

        {displayStatus === "idle" && (
          <div className="text-center py-20 space-y-3">
            <p className="text-gray-500 text-sm">
              Click <strong className="text-gray-700">Start Search Job</strong> to scan for suspected fake Comfrt listings.
            </p>
            <p className="text-gray-400 text-xs max-w-sm mx-auto leading-relaxed">
              Runs 24 search queries across Amazon and eBay, then scores each unique
              listing using brand mention, text similarity, image hashing, and risk heuristics.
            </p>
          </div>
        )}

        {displayStatus === "completed" && results.length === 0 && (
          <div className="text-center py-16 space-y-2">
            <p className="text-3xl">✅</p>
            <p className="text-gray-500 text-sm font-medium">No results found.</p>
            <p className="text-gray-400 text-xs">All listings passed the signal thresholds for this job run.</p>
          </div>
        )}

        {displayStatus === "completed" && results.length > 0 && sorted.length === 0 && (
          <div className="text-center py-10 space-y-1">
            <p className="text-gray-500 text-sm">No results match the current filters.</p>
            <p className="text-gray-400 text-xs">Try lowering the minimum score or changing the marketplace filter.</p>
          </div>
        )}
      </main>
    </div>
  );
}
