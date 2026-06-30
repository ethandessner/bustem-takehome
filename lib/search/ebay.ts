import type { MarketplaceResult } from "../types";

const SCRAPER_API_KEY = "4558fb24345f6ac0aa999ef5d14f5ea9";
const BASE_URL = "https://api.scraperapi.com/structured/ebay/search/v2";
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// ScraperAPI response shapes
//
// The structured eBay v2 endpoint returns a different shape than the Amazon
// endpoint. Items live under `results` (not `organic_results`), the title is
// `product_title`, the URL is `product_url`, the image is `image`, and the
// price is an object (`{ value, currency }` or a `{ from, to }` range) rather
// than a string. There is no dedicated item-id field — the numeric item id is
// embedded in `product_url` (e.g. https://www.ebay.com/itm/168247687486).
// ---------------------------------------------------------------------------

interface EbayPriceValue {
  value?: number;
  currency?: string;
}

interface EbayItemPrice {
  value?: number;
  currency?: string;
  from?: EbayPriceValue;
  to?: EbayPriceValue;
}

interface EbayRawItem {
  product_title?: string;
  image?: string;
  product_url?: string;
  item_price?: EbayItemPrice | string | number | null;
  condition?: string;
  seller_name?: string;
  extra_info?: string;
  shipping_cost?: string;
  shipping_location?: string;
}

interface EbaySearchResponse {
  results?: EbayRawItem[];
  error?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePrice(
  raw: EbayItemPrice | string | number | null | undefined
): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "number") return isFinite(raw) ? raw : 0;
  if (typeof raw === "string") {
    // Strip currency symbols and commas; handle ranges like "19.99 to 29.99"
    const cleaned = raw.replace(/[^0-9.]/g, " ").trim().split(/\s+/)[0];
    const n = parseFloat(cleaned);
    return isFinite(n) ? n : 0;
  }
  // Object form: prefer a direct value, otherwise fall back to the low end of
  // a price range so risk heuristics see the most aggressive (lowest) price.
  const value = raw.value ?? raw.from?.value;
  return typeof value === "number" && isFinite(value) ? value : 0;
}

/** Extract the numeric eBay item id from a listing URL (used as the dedup key). */
function extractItemId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/itm\/(\d+)/);
  return match ? match[1] : null;
}

function normalizeResult(raw: EbayRawItem): MarketplaceResult | null {
  const id = extractItemId(raw.product_url);
  if (!id || !raw.product_title) return null;
  return {
    id,
    marketplace: "ebay",
    title: raw.product_title,
    price: parsePrice(raw.item_price),
    currency: "USD",
    sellerName: raw.seller_name ?? "Unknown",
    listingUrl: raw.product_url ?? `https://www.ebay.com/itm/${id}`,
    imageUrl: raw.image ?? undefined,
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

  const rawItems: EbayRawItem[] = data.results ?? [];

  return rawItems.flatMap((r) => {
    const normalized = normalizeResult(r);
    return normalized ? [normalized] : [];
  });
}
