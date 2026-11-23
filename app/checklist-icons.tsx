/**
 * One icon per checklist item.
 *
 * These were unicode glyphs. That looked fine in the mock and broke in the browser: U+2311,
 * used for confidentiality, has no glyph in most UI fonts and rendered as a tofu box, and the
 * characters that do exist vary enough in size and weight between fonts that a row of them
 * never reads as a set.
 *
 * Inline SVG instead: one viewBox, one stroke weight, `currentColor` so they follow the accent.
 */
const BASE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const CHECKLIST_ICONS: Record<string, React.ReactNode> = {
  // Two people: who is bound.
  parties: (
    <svg {...BASE}>
      <circle cx="8.5" cy="8" r="3" />
      <circle cx="17" cy="9.5" r="2.4" />
      <path d="M3 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16 14.2c2.6.2 5 1.9 5 4.8" />
    </svg>
  ),
  // Calendar: when it begins, how long it runs.
  start_date_and_term: (
    <svg {...BASE}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  ),
  // Banknote: amounts and invoicing.
  payment_terms: (
    <svg {...BASE}>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 12h.01M18 12h.01" />
    </svg>
  ),
  // Door with an arrow out: how either side leaves.
  termination: (
    <svg {...BASE}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8" />
      <path d="M17 8l4 4-4 4M21 12h-10" />
    </svg>
  ),
  // Shield: caps and exclusions.
  limitation_of_liability: (
    <svg {...BASE}>
      <path d="M12 3l7.5 3v5.4c0 4.5-3.1 8.1-7.5 9.6-4.4-1.5-7.5-5.1-7.5-9.6V6z" />
      <path d="M9.2 12.2l2 2 3.6-3.9" />
    </svg>
  ),
  // Padlock: what must be kept secret.
  confidentiality: (
    <svg {...BASE}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
      <path d="M12 14.5v2.2" />
    </svg>
  ),
  // Scales: which law applies.
  governing_law: (
    <svg {...BASE}>
      <path d="M12 3.5v17M7 20.5h10M12 6.5l-6.5 2M12 6.5l6.5 2" />
      <path d="M5.5 8.5L3 14h5zM18.5 8.5L16 14h5z" />
    </svg>
  ),
  // Cycle: whether it renews by itself.
  auto_renewal: (
    <svg {...BASE}>
      <path d="M20.5 11a8.5 8.5 0 0 0-14.8-5.1L3.5 8" />
      <path d="M3.5 13a8.5 8.5 0 0 0 14.8 5.1l2.2-2.1" />
      <path d="M3.5 3.5V8H8M20.5 20.5V16H16" />
    </svg>
  ),
};
