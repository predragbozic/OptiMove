// U3: the matching rule for suggested athlete pairs (pure, no I/O).
//
// A name is normalized by Unicode NFKC, case-folding, removing diacritics,
// trimming and collapsing whitespace; names are compared as a SET of tokens
// (so "Ana Maric" equals "Maric Ana"). A pair is `exact` only when the
// normalized names are equal AND both dates of birth are present and equal AND
// the match is one-to-one (exactly one GPEXE athlete and one team athlete in
// the name group). Same name with two different present dates is a
// `dateConflict`; every other shared-name case is `ambiguous`. Nothing here is
// ever auto-selected; the caller decides what to show.
export function normalizeNameTokens(name) {
  if (typeof name !== "string") return [];
  const folded = name.normalize("NFKC").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/đ/g, "d").normalize("NFC");
  const tokens = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return [...new Set(tokens)].sort();
}

export function nameKey(name) {
  const tokens = normalizeNameTokens(name);
  return tokens.length ? tokens.join(" ") : null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function day(value) { return typeof value === "string" && DAY.test(value) ? value : null; }

// gpexe: [{ gpexeAthleteId, name, birthDate }]; athletes: [{ athleteId, name, birthDate }]
// (both already restricted by the caller to the team's unlinked ones).
export function computePairSuggestions(gpexe, athletes) {
  const groups = new Map();
  const slot = (key) => { if (!groups.has(key)) groups.set(key, { g: [], a: [] }); return groups.get(key); };
  for (const g of gpexe) { const k = nameKey(g.name); if (k) slot(k).g.push(g); }
  for (const a of athletes) { const k = nameKey(a.name); if (k) slot(k).a.push(a); }
  const exact = [];
  const ambiguous = [];
  const dateConflicts = [];
  for (const { g, a } of groups.values()) {
    if (!g.length || !a.length) continue;
    if (g.length === 1 && a.length === 1) {
      const gd = day(g[0].birthDate);
      const ad = day(a[0].birthDate);
      if (gd && ad && gd === ad) { exact.push({ gpexe: g[0], athlete: a[0] }); continue; }
      if (gd && ad) { dateConflicts.push({ gpexe: g[0], athlete: a[0] }); continue; }
    }
    for (const one of g) ambiguous.push({ gpexe: one, candidates: a });
  }
  return { exact, ambiguous, dateConflicts };
}
