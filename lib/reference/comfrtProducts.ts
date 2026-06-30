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
  // "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/103_3aaa2341-c9d6-4708-b69e-c385fccc0402.jpg",
  // // Halo Lightweight Oversized Hoodie
  // "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/19_8.jpg",
  // // VIP Exclusive Tranquil Hoodie
  // "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/1-2026-06-15T093805.430.jpg",
  // // VIP Exclusive Signature Hoodie
  // "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/1-2026-06-15T090206.603.jpg",
  // // VIP Exclusive Cloud Zip Hoodie
  // "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/1_18e3d5de-aea0-472f-b246-fb2b01b49f16.jpg",
  // // Sunwashed Crew (crewneck sweatshirt)
  // "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/97_b07e815c-c5fa-488b-987b-a54ef45e1e99.jpg",
  // // Snak Hoodie
  // "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/1_e32c0076-6e6c-4992-89e6-f138f86a694f.jpg",
  // // Sunwashed Straight Leg Sweatpants
  // "https://cdn.shopify.com/s/files/1/0569/4029/8284/files/139_c62773e1-e73a-4340-aa2e-d3698bcbef6b.jpg",

  // Minimalist Hoodie Red
  "https://comfrt.com/fast-image/comfrt/files/1_-_2026-06-10T101635.454.jpg?v=1781111883",

  // Airplane Mode Travel Hoodie
  "https://comfrt.com/fast-image/comfrt/files/1_a95323f5-a423-4b31-ad63-672a6a95e5c5.jpg?v=1764174206",

  // Travel Essentials Hoodie
  "https://comfrt.com/fast-image/comfrt/files/1_20_fb3e7ca1-5fbf-4b67-a4f5-1778f1be12aa.jpg?v=1746211742",

  // Signature Hoodie
  "http://comfrt.com/fast-image/comfrt/files/1_-_2026-05-05T151755.052.jpg?v=1778019541",

  // Cloud Zip Hoodie
  "https://comfrt.com/fast-image/comfrt/files/121_e329423d-0685-4ac1-bf52-4f1fcd7c8f96.jpg?v=1781556798",

  // Airplane Mode Travel Hoodie
  "https://comfrt.com/fast-image/comfrt/files/2_83.jpg?v=1764113204",

  // Sunwashed Hoodie
  "https://comfrt.com/fast-image/comfrt/files/31_1_650f177d-e5df-4a3d-a462-7519db330490.jpg?v=1781204157",

  // Pastel Zip Hoodie
  "https://comfrt.com/fast-image/comfrt/files/1_5700a7d8-cccc-417c-8154-babe2ab43c82.jpg?v=1744987557"
];
