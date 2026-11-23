/**
 * Does this quote actually appear in the contract?
 *
 * Requirement 8 of the task: the backend checks every quote against the contract text and marks
 * the item "unclear" when it does not match. This is the guard that makes the rest trustworthy -
 * a model that paraphrases a clause, tidies its punctuation, or invents a plausible one gets
 * caught here rather than shown to the user as a quotation.
 *
 * The comparison is normalised, not byte-exact, because a faithful quote still differs from the
 * source in ways that do not change its meaning:
 *   - PDF extraction turns layout into single spaces and line breaks in its own way
 *   - models normalise curly quotes, en dashes and non-breaking spaces
 *   - a long quote is often given with an ellipsis in the middle
 *
 * What it will not forgive is different words. Normalisation only touches whitespace, quotation
 * marks, dashes and case.
 */

export type QuoteMatch = { start: number; end: number; text: string };

/**
 * Normalise, and keep a map from each normalised character back to its index in the original.
 * The map is what lets a match report real offsets, so the UI can highlight the true span.
 */
function normaliseWithMap(input: string): { norm: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let lastWasSpace = true; // leading whitespace is dropped

  for (let i = 0; i < input.length; i++) {
    let ch = input[i];

    /**
     * Unify the characters that differ between a PDF, a model and a keyboard.
     *
     * All quotation marks collapse to one character, including single versus double. Models
     * swap them freely - a contract defining `1.1 "Services" means...` comes back quoted as
     * `1.1 'Services' means...`, usually to avoid escaping inside their own output. That is a
     * punctuation difference, not a different word, so it must not fail verification.
     *
     * Both sides get the same treatment, so an apostrophe inside a word is normalised
     * identically in the quote and in the contract and still matches.
     */
    if (
      ch === "‘" || ch === "’" || ch === "ʼ" || ch === "´" ||
      ch === "'" || ch === "`" || ch === "“" || ch === "”"
    ) {
      ch = '"';
    }
    else if (ch === "–" || ch === "—" || ch === "−") ch = "-";
    else if (ch === " " || ch === " " || ch === " ") ch = " ";
    else if (ch === "­" || ch === "​") continue; // soft hyphen, zero-width space

    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      out.push(" ");
      map.push(i);
      lastWasSpace = true;
      continue;
    }

    out.push(ch.toLowerCase());
    map.push(i);
    lastWasSpace = false;
  }

  // Drop a single trailing space so "clause " and "clause" match.
  if (out.length && out[out.length - 1] === " ") {
    out.pop();
    map.pop();
  }

  return { norm: out.join(""), map };
}

function normalise(input: string): string {
  return normaliseWithMap(input).norm;
}

/** Quotes are often given abridged: "Either party may terminate ... on thirty days notice". */
function splitOnEllipsis(quote: string): string[] {
  return quote
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Locate a quote in the contract. Returns the span in ORIGINAL coordinates, or null when the
 * quote is not really there.
 */
export function findQuote(fullText: string, quote: string): QuoteMatch | null {
  if (!quote || quote.trim().length < 12) return null; // too short to be evidence

  const { norm: haystack, map } = normaliseWithMap(fullText);
  const segments = splitOnEllipsis(quote);
  if (!segments.length) return null;

  let searchFrom = 0;
  let firstStart = -1;
  let lastEnd = -1;

  for (const segment of segments) {
    const needle = normalise(segment);
    // A fragment left by an ellipsis can be tiny; ignore those rather than matching noise.
    if (needle.length < 8) continue;

    const at = haystack.indexOf(needle, searchFrom);
    if (at === -1) return null;

    if (firstStart === -1) firstStart = at;
    lastEnd = at + needle.length;
    searchFrom = lastEnd;
  }

  if (firstStart === -1 || lastEnd === -1) return null;

  const start = map[firstStart];
  // map[i] is the index of the i-th normalised character; the end is one past the last one.
  const end = (map[lastEnd - 1] ?? start) + 1;

  return { start, end, text: fullText.slice(start, end) };
}

/** Convenience for the review pipeline and for tests. */
export function quoteAppears(fullText: string, quote: string): boolean {
  return findQuote(fullText, quote) !== null;
}
