// U6a: the sessions that need a person, grouped by what is in the way - pure rules, no DOM and no requests.
// One group per kind of problem, with one sentence, a count and ONE button; the sessions themselves are folded
// inside the group. Every group is built from facts the list already carries (the row's reasons, the blocked
// code, the snapshot and the link state), never from a request.
import { inboxBucket, isUncertain, notConfirmedForImport, reviewMadeBeforeLinkChange, rowReasons } from "./gpexe-import-data.js";

const UNLINKED = new Set(["no_linked_athlete", "athletes_not_linked"]);

// The group keys, in the order they are shown: the step that unblocks the most comes first.
// A result that is not confirmed comes first: it says "check before doing anything else".
export const ATTENTION_ORDER = ["unknown", "unlinked", "fresh", "review", "data"];

export const ATTENTION_TEXT = {
  unlinked: { title: "Athletes not linked", sentence: "These sessions have GPEXE athletes that are not linked to a team athlete yet. Link them, then find new sessions.", button: "Link athletes", action: "training-load-gpexe-map-open" },
  fresh: { title: "Needs a new search", sentence: "These sessions were not confirmed by the last search, or their athlete links changed after they were reviewed. Find new sessions again for their dates.", button: "Find new sessions", action: "training-load-gpexe-check" },
  review: { title: "Needs a manual review", sentence: "In these sessions something needs a look before the session can be imported. Open one to see what and why.", button: "Open", action: "training-load-gpexe-open" },
  data: { title: "Problem in the GPEXE data", sentence: "OptiMove cannot import these sessions as they are. Open one to see what is in the way.", button: "Details", action: "training-load-gpexe-open" },
  unknown: { title: "Result not confirmed", sentence: "The answer to an import did not arrive. Check the result before doing anything else.", button: "Open", action: "training-load-gpexe-open" },
};

// Which group one session belongs to. The order of the checks is the order of what must happen first.
export function attentionKind(c, gx) {
  if (isUncertain(c, gx)) return "unknown";
  if (c.status === "blocked") return "data";
  if (!c.snapshot?.available || notConfirmedForImport(c) || reviewMadeBeforeLinkChange(c, gx)) return "fresh";
  const reasons = rowReasons(c);
  if (reasons.some((r) => UNLINKED.has(r.code))) return "unlinked";
  return "review";
}

// The groups of a list of attention sessions: [{ key, ...text, count, items, first }], empty groups left out.
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
