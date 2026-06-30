import type { MarketplaceResult } from "../types";

const SCRAPER_API_KEY = "4558fb24345f6ac0aa999ef5d14f5ea9";
const BASE_URL = "https://api.scraperapi.com/structured/ebay/search/v2";
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// ScraperAPI response shapes
// ---------------------------------------------------------------------------

interface EbayRawItem {
  item_id?: string;
  title?: string;
  price?: string | number | null;
  currency_symbol?: string;
  image_url?: string;
  item_url?: string;
  seller_name?: string;
  condition?: string;
  buying_format?: string;
  shipping?: string;
}

interface EbaySearchResponse {
  organic_results?: EbayRawItem[];
  error?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePrice(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  if (typeof raw === "number") return isFinite(raw) ? raw : 0;
  // Strip currency symbols and commas; handle ranges like "19.99 to 29.99"
  const cleaned = String(raw).replace(/[^0-9.]/g, " ").trim().split(/\s+/)[0];
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}

function normalizeResult(raw: EbayRawItem): MarketplaceResult | null {
  if (!raw.item_id || !raw.title) return null;
  return {
    id: raw.item_id,
    marketplace: "ebay",
    title: raw.title,
    price: parsePrice(raw.price),
    currency: "USD",
    sellerName: raw.seller_name ?? "Unknown",
    listingUrl: raw.item_url ?? `https://www.ebay.com/itm/${raw.item_id}`,
    imageUrl: raw.image_url ?? undefined,
    fetchedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch one page of eBay search results via ScraperAPI's structured endpoint.
 * Throws on HTTP/network errors so the caller can log and skip.
 */
export async function searchEbay(
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
      `eBay search HTTP ${response.status} for query "${query}" page ${page}`
    );
  }

  const data: EbaySearchResponse = await response.json();

  if (data.error || data.message) {
    throw new Error(`eBay search API error: ${data.error ?? data.message}`);
  }

  const rawItems: EbayRawItem[] = data.organic_results ?? [];

  return rawItems.flatMap((r) => {
    const normalized = normalizeResult(r);
    return normalized ? [normalized] : [];
  });
}
