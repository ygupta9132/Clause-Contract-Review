"use client";

import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";

/**
 * The header's auth controls, as a client component.
 *
 * Rendered on the server, `<Show>` resolves against the request at render time, so signing in
 * through the modal left the header still offering "Sign in" until the next full page load.
 * On the client it tracks Clerk's live session state and switches the moment the user signs in
 * or out, which is what someone expects from a header.
 */
export default function HeaderNav() {
  return (
    <nav className="nav">
      <Show when="signed-in">
        <Link href="/contracts">My contracts</Link>
        <UserButton />
      </Show>
      <Show when="signed-out">
        <SignInButton mode="modal">
          <button className="btn primary">Sign in</button>
        </SignInButton>
      </Show>
    </nav>
  );
}
