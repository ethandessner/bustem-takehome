export interface ComfrtProduct {
  name: string;
  keywords: string[];
  priceRange: { min: number; max: number };
}

export const COMFRT_PRODUCTS: ComfrtProduct[] = [
  {
    name: "Comfrt Classic Hoodie",
    keywords: ["comfrt hoodie", "comfrt classic hoodie", "mindful hoodie", "comfrt pullover"],
    priceRange: { min: 55, max: 75 },
  },
  {
    name: "Comfrt Cloud Hoodie",
    keywords: ["comfrt cloud hoodie", "cloud hoodie", "comfrt cloud", "cloud fleece hoodie"],
    priceRange: { min: 60, max: 80 },
  },
  {
    name: "Comfrt Graphic Tee",
    keywords: ["comfrt tee", "comfrt shirt", "mindful graphic tee", "comfrt graphic", "mental health tee"],
    priceRange: { min: 30, max: 45 },
  },
  {
    name: "Comfrt Sweatpants",
    keywords: ["comfrt sweatpants", "comfrt joggers", "mindful sweatpants", "comfrt pants"],
    priceRange: { min: 55, max: 70 },
  },
  {
    name: "Comfrt Crewneck Sweatshirt",
    keywords: ["comfrt crewneck", "comfrt sweatshirt", "mindful crewneck", "comfrt crew"],
    priceRange: { min: 55, max: 70 },
  },
  {
    name: "Comfrt Matching Set",
    keywords: ["comfrt matching set", "comfrt set", "comfrt sweatsuit", "comfrt lounge set"],
    priceRange: { min: 100, max: 140 },
  },
];

export const COMFRT_BRAND_KEYWORDS = [
  "comfrt",
  "comfrt brand",
  "comfrt clothing",
  "comfrt apparel",
  "comfrt hoodie",
  "comfrt sweatshirt",
  "comfrt sweatsuit",
  "comfrt pullover",
  "comfrt matching set",
  "comfrt cloud hoodie",
];

export const COMFRT_PRICE_FLOOR = 30;

/**
 * Reference product image URLs from comfrt.com (Shopify CDN).
 *
 * These are the primary product photos pulled from the live Comfrt storefront
 * (https://comfrt.com/products.json), covering the main apparel lines that
 * counterfeiters target: hoodies, crewneck sweatshirts, and sweatpants.
 *
 * To refresh: `curl 'https://comfrt.com/products.json?limit=50'` and copy the
 * first `images[].src` for the relevant products.
 *
 * The image similarity signal gracefully returns null if a URL fails to load, so
 * stale URLs will not crash the scoring pipeline.
 */
export const COMFRT_REFERENCE_IMAGES: string[] = [
  // Sunwashed Hoodie
  "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/103_3aaa2341-c9d6-4708-b69e-c385fccc0402.jpg",
  // Halo Lightweight Oversized Hoodie
  "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/19_8.jpg",
  // VIP Exclusive Tranquil Hoodie
  "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/1-2026-06-15T093805.430.jpg",
  // VIP Exclusive Signature Hoodie
  "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/1-2026-06-15T090206.603.jpg",
  // VIP Exclusive Cloud Zip Hoodie
  "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/1_18e3d5de-aea0-472f-b246-fb2b01b49f16.jpg",
  // Sunwashed Crew (crewneck sweatshirt)
  "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/97_b07e815c-c5fa-488b-987b-a54ef45e1e99.jpg",
  // Snak Hoodie
  "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/1_e32c0076-6e6c-4992-89e6-f138f86a694f.jpg",
  // Sunwashed Straight Leg Sweatpants
  "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/139_c62773e1-e73a-4340-aa2e-d3698bcbef6b.jpg",
];
