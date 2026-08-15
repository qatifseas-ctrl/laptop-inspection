import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Allow the static HTML page at /static-app/index.html to be served as a static asset
  // (kept for offline/fallback use; the main app is at /)
};

export default nextConfig;
