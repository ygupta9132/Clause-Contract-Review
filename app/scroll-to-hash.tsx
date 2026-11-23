"use client";

import { useEffect } from "react";

/**
 * Scroll to the element named in the URL hash.
 *
 * The App Router restores the previous scroll position when you return to a route it has
 * already rendered, and that restoration wins over the `#fragment` in the link. So "How it
 * works", pointing at `/#how-it-works`, arrived on the right page at the wrong position and
 * looked like a link that did nothing.
 *
 * Running once on mount is not enough: the restoration lands *after* the first frame, and web
 * fonts shift the layout again a moment later. So the scroll is applied a few times over the
 * first half second and then stops - cheap, and it wins whatever order the two happen in.
 */
const HEADER_OFFSET = 92;
const ATTEMPTS_MS = [0, 80, 220, 450];

export default function ScrollToHash() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;

    const timers = ATTEMPTS_MS.map((delay) =>
      window.setTimeout(() => {
        const el = document.getElementById(id);
        if (!el) return;
        const top = el.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET;
        // `instant` on the later passes, so a correction does not animate twice.
        window.scrollTo({ top, behavior: delay === 0 ? "smooth" : "instant" });
      }, delay),
    );

    return () => timers.forEach(clearTimeout);
  }, []);

  return null;
}
