import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist and mammoth are CommonJS-ish libraries with their own worker and fs usage.
  // Leaving them external stops Next from trying to bundle them into the server build, which
  // is what produces the "Cannot find module pdf.worker" class of error at run time.
  // bullmq is here as well as the document parsers: it lazily requires an optional Valkey
  // client that is not installed, and webpack reports that as a missing module even though
  // nothing calls it.
  serverExternalPackages: ["pdfjs-dist", "mammoth", "bullmq"],
};

export default nextConfig;
