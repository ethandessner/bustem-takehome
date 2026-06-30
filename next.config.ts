import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These run only in the Node server runtime and rely on native bindings or
  // worker scripts loaded from their own package paths. Keep them external so
  // the bundler doesn't rewrite those paths and break model/worker loading.
  serverExternalPackages: [
    "@huggingface/transformers",
    "sharp",
  ],
};

export default nextConfig;
