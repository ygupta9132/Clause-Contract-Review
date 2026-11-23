/**
 * The fixed review checklist.
 *
 * Each item carries its own retrieval query and keyword set. That is the main reason the review
 * is accurate: a single embedding of the words "limitation of liability" pulls back the wrong
 * paragraphs in a contract that phrases it as "neither party shall be liable for indirect
 * damages". The query text below is written to read like the clause, not like the label, and the
 * keywords give the lexical half of the hybrid search something concrete to match.
 *
 * `negativeKeywords` exist because a few of these items are easy to confuse with each other -
 * "term" matches "terminate", and auto-renewal lives inside the term clause but is a separate
 * finding.
 */
export type ChecklistItem = {
  key: string;
  label: string;
  /** Shown in the UI under the label. */
  description: string;
  /** Embedded to find candidate clauses. Written as the clause would read. */
  query: string;
  /** Lexical signals, lowercase. Used to boost retrieval and to break ties. */
  keywords: string[];
  negativeKeywords?: string[];
  /** Extra instruction handed to the model for this item only. */
  guidance: string;
};

export const CHECKLIST: ChecklistItem[] = [
  {
    key: "parties",
    label: "Parties",
    description: "Who is bound by this contract",
    query:
      "This Agreement is made between the parties, the company and the counterparty, their legal names, addresses and registered offices.",
    keywords: [
      "between",
      "party",
      "parties",
      "entered into",
      "by and between",
      "registered office",
      "hereinafter referred",
      "company",
      "client",
      "customer",
      "supplier",
      "vendor",
    ],
    guidance:
      "Name both parties exactly as the contract names them, including any defined short names such as (the \"Supplier\").",
  },
  {
    key: "start_date_and_term",
    label: "Start date and term",
    description: "When it begins and how long it runs",
    query:
      "This Agreement commences on the effective date and continues for an initial term of twelve months, expiring on the end date.",
    keywords: [
      "effective date",
      "commencement",
      "commences",
      "term of this agreement",
      "initial term",
      "shall continue",
      "expiry",
      "expires",
      "duration",
      "period of",
    ],
    negativeKeywords: ["terminate", "termination"],
    guidance:
      "Report the start date and the length of the term. If the contract states one but not the other, say which is missing in the summary and still mark it found.",
  },
  {
    key: "payment_terms",
    label: "Payment terms",
    description: "Amounts, invoicing and when money is due",
    query:
      "Fees are payable within thirty days of the date of invoice. Charges, rates, taxes and late payment interest.",
    keywords: [
      "payment",
      "fees",
      "invoice",
      "payable",
      "net 30",
      "days of receipt",
      "charges",
      "price",
      "remuneration",
      "late payment",
      "interest",
      "gst",
      "vat",
      "tax",
    ],
    guidance:
      "Cover the amount or rate and the payment window if both are present. Prefer the clause that states when payment is due.",
  },
  {
    key: "termination",
    label: "Termination",
    description: "How either side can end it",
    query:
      "Either party may terminate this Agreement by giving thirty days prior written notice, or immediately on a material breach that is not remedied.",
    keywords: [
      "terminate",
      "termination",
      "written notice",
      "notice period",
      "material breach",
      "cure period",
      "for convenience",
      "with cause",
      "end this agreement",
    ],
    guidance:
      "State who may terminate, on what grounds, and how much notice is required. If termination for convenience and for cause are separate, summarise both.",
  },
  {
    key: "limitation_of_liability",
    label: "Limitation of liability",
    description: "Caps and exclusions on what can be claimed",
    query:
      "Neither party shall be liable for indirect, incidental or consequential damages, and total aggregate liability shall not exceed the fees paid in the preceding twelve months.",
    keywords: [
      "liability",
      "liable",
      "aggregate liability",
      "shall not exceed",
      "indirect",
      "consequential",
      "incidental",
      "loss of profits",
      "cap",
      "damages",
      "exclusion",
    ],
    guidance:
      "Report the cap if there is one, and what is excluded. A clause that only excludes indirect damages without capping direct liability is still a finding: say so.",
  },
  {
    key: "confidentiality",
    label: "Confidentiality",
    description: "What must be kept secret, and for how long",
    query:
      "Each party shall keep confidential information disclosed by the other party secret, and shall not disclose it to third parties, for a period of years after termination.",
    keywords: [
      "confidential",
      "confidentiality",
      "non-disclosure",
      "proprietary information",
      "trade secret",
      "disclose",
      "recipient",
      "disclosing party",
    ],
    guidance:
      "State what is covered, and the survival period if one is given. The obligation and its " +
      "duration are usually in separate sub-clauses: a confidentiality clause with no visible " +
      "survival period is still 'found'. Say in the summary that the duration was not stated.",
  },
  {
    key: "governing_law",
    label: "Governing law",
    description: "Which law applies and where disputes go",
    query:
      "This Agreement shall be governed by and construed in accordance with the laws of the jurisdiction, and the courts shall have exclusive jurisdiction.",
    keywords: [
      "governed by",
      "governing law",
      "construed in accordance",
      "jurisdiction",
      "courts of",
      "venue",
      "arbitration",
      "dispute resolution",
      "laws of",
    ],
    guidance:
      "Name the governing law. If a separate clause names a court or an arbitration seat, include it in the summary.",
  },
  {
    key: "auto_renewal",
    label: "Auto-renewal",
    description: "Whether it renews by itself",
    query:
      "This Agreement shall automatically renew for successive twelve month periods unless either party gives written notice of non-renewal before the end of the then current term.",
    keywords: [
      "automatically renew",
      "auto-renew",
      "renewal",
      "renew for successive",
      "rollover",
      "unless either party gives notice",
      "non-renewal",
      "evergreen",
    ],
    guidance:
      "Auto-renewal is often a sentence inside the term clause rather than its own heading. If the contract says the term simply expires, that is 'not found', not 'unclear'.",
  },
];

export const CHECKLIST_BY_KEY = new Map(CHECKLIST.map((i) => [i.key, i]));
