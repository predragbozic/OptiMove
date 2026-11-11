// U6a-2: the sessions that need a person, grouped by what is in the way - pure rules, no DOM and no requests.
// One group per kind of problem, with one sentence, a count and ONE button; the sessions themselves are folded
// inside the group. Every group is built from facts the list already carries (the row's reasons, the blocked
// code, the snapshot, the link state), never from a request. The group decides which session is "first", and
// the review opened from it steps through the same group (J20 section 8).
import { inboxBucket, isUncertain, notConfirmedForImport, reviewMadeBeforeLinkChange, rowReasons } from "./gpexe-import-data.js";

const UNLINKED = new Set(["no_linked_athlete", "athletes_not_linked"]);

// The group keys, in the order they are shown. A result that is not confirmed comes first: it says "check before
// doing anything else"; then what unblocks the most.
export const ATTENTION_ORDER = ["unknown", "unlinked", "stale", "fresh", "review", "data"];

export const ATTENTION_TEXT = {
  unknown: { title: "Result not confirmed", sentence: "The answer to an import did not arrive. Check the result before doing anything else." },
  unlinked: { title: "Athletes not linked", sentence: "Some athletes in these sessions are not linked to a team athlete yet. Open a session and link them from their rows." },
  stale: { title: "Review out of date", sentence: "Athlete links changed after these sessions were reviewed. Open a session and update its review before importing." },
  fresh: { title: "Needs a new search", sentence: "The last search did not confirm these sessions, or their GPEXE data is no longer kept. Find new sessions again for their dates." },
  review: { title: "Needs a manual review", sentence: "Something in these sessions needs a look before they can be imported. Open one to see what and why." },
  data: { title: "Problem in the GPEXE data", sentence: "OptiMove cannot import these sessions as they are. Open one to see what is in the way." },
};

// Which group one session belongs to. The order of the checks is the order of what must happen first.
export function attentionKind(c, gx) {
  if (isUncertain(c, gx)) return "unknown";
  if (c.status === "blocked") return "data";
  if (!c.snapshot?.available || notConfirmedForImport(c)) return "fresh";
  if (reviewMadeBeforeLinkChange(c, gx)) return "stale";
  if (rowReasons(c).some((r) => UNLINKED.has(r.code))) return "unlinked";
  return "review";
}

// The groups of a list: [{ key, title, sentence, count, items, first }], in ATTENTION_ORDER, empty groups left out.
export function attentionGroups(list, gx) {
  const by = new Map();
  for (const c of list) {
    if (inboxBucket(c, gx) !== "attention") continue;
    const key = attentionKind(c, gx);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(c);
  }
  return ATTENTION_ORDER.filter((key) => by.has(key)).map((key) => ({ key, ...ATTENTION_TEXT[key], count: by.get(key).length, items: by.get(key), first: by.get(key)[0] }));
}

// The sessions of one group, in the list's order, as they are now (an imported or fixed session leaves its group).
export function groupItems(key, list, gx) {
  return attentionGroups(list, gx).find((grp) => grp.key === key)?.items || [];
}

// The session after `candidateId` in the group as it is now; the first one when `candidateId` left the group.
// null when nothing else is left in it.
export function nextInGroup(key, candidateId, list, gx) {
  const items = groupItems(key, list, gx);
  const at = items.findIndex((c) => c.id === candidateId);
  if (at < 0) return items[0] || null;
  return items[at + 1] || null;
}
