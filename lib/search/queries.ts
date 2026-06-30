import type { Marketplace } from "../types";

export interface SearchQuery {
  marketplace: Marketplace;
  query: string;
  /** 1-indexed page number */
  page: number;
  maxResults: number;
}

/**
 * Distinct search terms targeting Comfrt brand infringement.
 * Covers the main product lines and brand name variants commonly used by
 * counterfeit sellers to surface in marketplace search results.
 */
export const DISTINCT_QUERIES = [
  // Product-line terms — broad coverage of the catalog counterfeiters copy
  "comfrt hoodie",
  "comfrt sweatshirt",
  "comfrt sweatsuit",
  "comfrt pullover",
  "comfrt matching set",
  "comfrt cloud hoodie",
  "comfrt crewneck",
  "comfrt joggers",
  // Infringement-intent terms — surface the long tail of knock-offs that
  // sellers tag with "dupe"/"inspired" rather than the exact brand name
  "comfrt dupe",
  "comfrt inspired hoodie",
] as const;

const MARKETPLACES: Marketplace[] = ["amazon", "ebay"];
const PAGES_PER_QUERY = 3;

/**
 * Generates the full set of search queries: each distinct query × each
 * marketplace × each page. Total: 10 queries × 2 markets × 3 pages = 60 requests.
 */
export function generateSearchQueries(): SearchQuery[] {
  const queries: SearchQuery[] = [];

  for (const query of DISTINCT_QUERIES) {
    for (const marketplace of MARKETPLACES) {
      for (let page = 1; page <= PAGES_PER_QUERY; page++) {
        queries.push({ marketplace, query, page, maxResults: 10 });
      }
    }
  }

  return queries;
}
