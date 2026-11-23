import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist and mammoth are CommonJS-ish libraries with their own worker and fs usage.
  // Leaving them external stops Next from trying to bundle them into the server build, which
  // is what produces the "Cannot find module pdf.worker" class of error at run time.
  // bullmq is here as well as the document parsers: it lazily requires an optional Valkey
  // client that is not installed, and webpack reports that as a missing module even though
  // nothing calls it.
  serverExternalPackages: ["pdfjs-dist", "mammoth", "bullmq"],

  /**
   * The upload route accepts files up to 20 MB, and middleware runs on /api/*, so Next buffers
   * the request body for the middleware to see. That buffer defaults to 10 MB, which silently
   * truncated anything larger - the handler then saw a malformed multipart body and reported
   * "send the file as multipart/form-data", which is both wrong and impossible to act on.
   *
   * 25 MB leaves headroom above the 20 MB limit for multipart boundaries and headers. The real
   * limit is still enforced in the route.
   */
  experimental: {
    middlewareClientMaxBodySize: 25 * 1024 * 1024,
    serverActions: {
      // The route handler enforces the real limit; this only stops Next rejecting the body first.
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
