import { resolve } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: { root: resolve(__dirname, "../..") },
  outputFileTracingRoot: resolve(__dirname, "../.."),
  transpilePackages: ["@groundskeeper/database"],
  devIndicators: false,
  poweredByHeader: false,
};
export default config;
