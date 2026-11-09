import { splitSentences } from "./guards";

export type ClaimStatus = "Verified" | "Needs source" | "Cut";

export interface Claim {
  id: string;
  sectionKey: string;
  text: string;
  status: ClaimStatus;
  source: string;
}

const CLAIM_SIGNALS =
  /\d|\bpercent\b|\bstud(y|ies)\b|\bresearch(ers)?\b|\bsurvey(s|ed)?\b|\baccording to\b|\breport(s|ed)?\b|\bscientists?\b|\bdata\b|\bstatistic(s|ally)?\b|\bproven\b|\bevidence\b|\bexperts?\b|\buniversity\b|\bjournal\b/i;

/**
 * The fact-check list (sop.md Stage 3 step 8) seeding the claim ledger
 * (publishing-system-v2.md). Every sentence with a number, statistic, or named
 * reference becomes a claim marked "Needs source" until the operator verifies it.
 */
export function extractClaims(sectionKey: string, markdown: string, startAt = 1): Claim[] {
  const claims: Claim[] = [];
  let n = startAt;
  for (const s of splitSentences(markdown)) {
    if (CLAIM_SIGNALS.test(s)) claims.push({ id: `C${n++}`, sectionKey, text: s, status: "Needs source", source: "" });
  }
  return claims;
}

/** Keep operator decisions (status and source) for claims whose text is unchanged. */
export function mergeClaims(existing: Claim[], fresh: Claim[]): Claim[] {
  const known = new Map(existing.map((c) => [`${c.sectionKey}|${c.text}`, c]));
  return fresh.map((c, i) => {
    const prior = known.get(`${c.sectionKey}|${c.text}`);
    return prior ? { ...c, id: `C${i + 1}`, status: prior.status, source: prior.source } : { ...c, id: `C${i + 1}` };
  });
}

export function renderClaimLedger(claims: Claim[], sectionKey?: string): string {
  const list = sectionKey ? claims.filter((c) => c.sectionKey === sectionKey) : claims;
  if (!list.length) return "";
  return list.map((c) => `${c.id} [${c.status}]${c.source ? ` (source: ${c.source})` : ""}: ${c.text}`).join("\n");
}
