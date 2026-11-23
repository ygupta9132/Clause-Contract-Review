import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Everything is private except the landing page and the Clerk sign-in and sign-up routes.
 *
 * This is an allowlist, not a blocklist. A new route is protected by default; forgetting to add
 * it here makes it inaccessible, which is the safe direction to fail. The opposite arrangement -
 * listing the routes that need protecting - means a forgotten entry is a public endpoint.
 *
 * The middleware is a first gate, not the only one. Every API route still resolves the user from
 * the verified session itself and scopes its queries, because middleware matching is a pattern
 * match and patterns can be wrong.
 */
const isPublicRoute = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Everything except Next internals and static files, unless they carry a query string.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run on API routes.
    "/(api|trpc)(.*)",
  ],
};
