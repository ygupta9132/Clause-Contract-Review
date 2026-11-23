import Link from "next/link";

/**
 * A custom 404, declared dynamic for a build reason rather than a product one.
 *
 * Next prerenders its built-in /_not-found at build time. That page renders inside the root
 * layout, which contains ClerkProvider, so the build would need a valid Clerk publishable key
 * before it would produce a 404 page - and the build then fails for anyone who has not put
 * their real key in .env first.
 */
export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <div className="empty" style={{ maxWidth: 520, margin: "40px auto" }}>
      <div className="eyebrow">404</div>
      <h2 style={{ marginTop: 8 }}>Page not found</h2>
      <p className="sub" style={{ marginTop: 8 }}>
        That page does not exist. If you followed a link to a contract, it may have been deleted,
        or it belongs to another account.
      </p>
      <Link className="btn primary" href="/contracts" style={{ marginTop: 18 }}>
        My contracts
      </Link>
    </div>
  );
}
