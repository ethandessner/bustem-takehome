import type { MarketplaceResult } from "../types";

const SCRAPER_API_KEY = "4558fb24345f6ac0aa999ef5d14f5ea9";
const BASE_URL = "https://api.scraperapi.com/structured/amazon/search/v1";
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// ScraperAPI response shapes
// ---------------------------------------------------------------------------

interface AmazonRawResult {
  asin?: string;
  name?: string;
  price?: string | number | null;
  currency_symbol?: string;
  image?: string;
  url?: string;
  stars?: number;
  num_reviews?: number;
  sponsored?: boolean;
  seller_name?: string;
}

interface AmazonSearchResponse {
  results?: AmazonRawResult[];
  sponsored_results?: AmazonRawResult[];
  error?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePrice(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  if (typeof raw === "number") return isFinite(raw) ? raw : 0;
  const cleaned = String(raw).replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}

function normalizeResult(raw: AmazonRawResult): MarketplaceResult | null {
  if (!raw.asin || !raw.name) return null;
  return {
    id: raw.asin,
    marketplace: "amazon",
    title: raw.name,
    price: parsePrice(raw.price),
    currency: "USD",
    sellerName: raw.seller_name ?? "",
    listingUrl: raw.url ?? `https://www.amazon.com/dp/${raw.asin}`,
    imageUrl: raw.image ?? undefined,
    fetchedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch one page of Amazon search results via ScraperAPI's structured endpoint.
 * Throws on HTTP/network errors so the caller can log and skip.
 */
export async function searchAmazon(
  query: string,
  page = 1
): Promise<MarketplaceResult[]> {
  const url = new URL(BASE_URL);
  url.searchParams.set("api_key", SCRAPER_API_KEY);
  url.searchParams.set("query", query);
  url.searchParams.set("tld", "com");
  if (page > 1) url.searchParams.set("page", String(page));

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Amazon search HTTP ${response.status} for query "${query}" page ${page}`
    );
  }

  const data: AmazonSearchResponse = await response.json();

  if (data.error || data.message) {
    throw new Error(
      `Amazon search API error: ${data.error ?? data.message}`
    );
  }

  const rawItems: AmazonRawResult[] = [
    ...(data.results ?? []),
    // Include sponsored results — they may be infringing too
    ...(data.sponsored_results ?? []),
  ];

  return rawItems.flatMap((r) => {
    const normalized = normalizeResult(r);
    return normalized ? [normalized] : [];
  });
}
