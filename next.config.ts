import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "lighthouse",
    "crawlee",
    "pg",
    "@prisma/client",
    "@prisma/adapter-pg",
  ],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
