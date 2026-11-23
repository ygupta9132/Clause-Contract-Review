import { auth } from "@clerk/nextjs/server";
import { SignInButton, SignUpButton } from "@clerk/nextjs";
import Link from "next/link";

import { CHECKLIST } from "@/checklist";
import { CHECKLIST_ICONS } from "./checklist-icons";
import ScrollToHash from "./scroll-to-hash";

// Rendered per request, not at build time. This page reads the session, and every page in this
// app renders inside ClerkProvider, which refuses to initialise with a placeholder key. Static
// generation would therefore make `next build` depend on real Clerk credentials.
export const dynamic = "force-dynamic";


export default async function Home() {
  const { userId } = await auth();
  const signedIn = Boolean(userId);

  /**
   * This page used to redirect a signed-in user straight to /contracts, which made the
   * "How it works" link on that page a no-op: it pointed here, and here sent them back.
   *
   * Signing in still lands on /contracts - Clerk's fallback redirect does that - so the
   * redirect here was only ever duplicating it, at the cost of making the explainer
   * unreachable for anyone with an account. Now the page stays, and only the call to action
   * changes with the session.
   */
  return (
    <section className="hero">
      <ScrollToHash />
      <div className="eyebrow">Contract intelligence, made clear</div>
      <h1>
        Understand every clause.
        <br />
        <span style={{ color: "var(--accent)" }}>Know what you are signing.</span>
      </h1>
      <p>
        Upload a contract and review its important terms against a clear eight-point checklist.
        Every finding is grounded in the document, with the original clause close at hand. If the
        contract does not cover something, it says so rather than guessing.
      </p>

      <div className="actions">
        {signedIn ? (
          <Link className="btn primary" href="/contracts">
            Review a contract
          </Link>
        ) : (
          <>
            <SignUpButton mode="modal">
              <button className="btn primary">Review a contract</button>
            </SignUpButton>
            <SignInButton mode="modal">
              <button className="btn">View my contracts</button>
            </SignInButton>
          </>
        )}
      </div>

      <div className="label">WHAT GETS CHECKED</div>
      <div className="grid">
        {CHECKLIST.map((item) => (
          <div className="tile" key={item.key}>
            {CHECKLIST_ICONS[item.key]}
            <b>{item.label}</b>
            <small>{item.description}</small>
          </div>
        ))}
      </div>

      <div className="label" id="how-it-works">
        HOW A REVIEW WORKS
      </div>
      <div className="grid">
        <div className="tile">
          <i className="step" aria-hidden>1</i>
          <b>Upload</b>
          <small>
            PDF, DOCX or TXT up to 20 MB. The upload returns straight away and the work happens in
            the background, so a large file never ties up the page.
          </small>
        </div>
        <div className="tile">
          <i className="step" aria-hidden>2</i>
          <b>Split into clauses</b>
          <small>
            The document is divided on its own clause headings rather than every N characters, so
            a clause and its conditions stay in one piece.
          </small>
        </div>
        <div className="tile">
          <i className="step" aria-hidden>3</i>
          <b>Check each item</b>
          <small>
            Each of the eight items is searched for separately, using wording written to match how
            the clause actually reads rather than its label.
          </small>
        </div>
        <div className="tile">
          <i className="step" aria-hidden>4</i>
          <b>Verify the quote</b>
          <small>
            Every quote is checked against the contract text before you see it. Anything that
            cannot be found is reported as unclear, never shown as a quotation.
          </small>
        </div>
      </div>
    </section>
  );
}
