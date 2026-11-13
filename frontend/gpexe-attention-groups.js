// U6a-2: the sessions that need a person, grouped by what is in the way - pure rules, no DOM and no requests.
// One group per kind of problem, with one sentence, a count and ONE button; the sessions themselves are folded
// inside the group. Every group is built from facts the list already carries (the row's reasons, the blocked
// code, the snapshot, the link state), never from a request. The group decides which session is "first", and
// the review opened from it steps through the same group (J20 section 8).
import { inboxBucket, isUncertain, notConfirmedForImport, reviewMadeBeforeLinkChange, rowReasons } from "./gpexe-import-data.js";
import { undoBusy } from "./gpexe-undo-data.js";

const UNLINKED = new Set(["no_linked_athlete", "athletes_not_linked"]);

// The group keys, in the order they are shown. A result that is not confirmed comes first: it says "check before
// doing anything else"; then what unblocks the most.
export const ATTENTION_ORDER = ["unknown", "unlinked", "stale", "fresh", "review", "data"];

// One title, one button and a sentence for one session or several.
export const ATTENTION_TEXT = {
  unknown: { title: "Result not confirmed", button: "Check the result",
    one: "The answer to an import did not arrive. Check the result before doing anything else.",
    many: "The answers to some imports did not arrive. Check each result before doing anything else." },
  unlinked: { title: "Athletes not linked", button: "Link athletes",
    one: "Link the GPEXE athletes of this session to the athletes of your team.",
    many: "Link the GPEXE athletes of these sessions to the athletes of your team." },
  stale: { title: "Review out of date", button: "Update the review",
    one: "Athlete links changed after this session was reviewed. Update its review before importing.",
    many: "Athlete links changed after these sessions were reviewed. Update each review before importing." },
  fresh: { title: "Needs a new search", button: "Find new sessions",
    one: "Search again to read this session from GPEXE before importing.",
    many: "Search again to read these sessions from GPEXE before importing." },
  review: { title: "Needs a look", button: "Open the session",
    one: "Something in this session needs a look before it can be imported.",
    many: "Something in these sessions needs a look before they can be imported." },
  data: { title: "Problem in the GPEXE data", button: "See why",
    one: "OptiMove can't import this session as it is. See why, and whether anything needs doing.",
    many: "OptiMove can't import these sessions as they are. See why, and whether anything needs doing." },
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
  return ATTENTION_ORDER.filter((key) => by.has(key)).map((key) => {
    const items = by.get(key);
    const t = ATTENTION_TEXT[key];
    return { key, title: t.title, button: t.button, sentence: items.length === 1 ? t.one : t.many, count: items.length, items, first: items[0] };
  });
}

// The sessions of one group, in the list's order, as they are now (an imported or fixed session leaves its group).
export function groupItems(key, list, gx) {
  return attentionGroups(list, gx).find((grp) => grp.key === key)?.items || [];
}

// The group a review steps through is the list of sessions the group held when it was opened (detail.groupIds): a link
// made in one session moves the others to "Review out of date", and they must stay reachable. Next is the first session
// after this one in that list that still needs a person; null when none is left.
export function nextInGroup(detail, list, gx) {
  const ids = Array.isArray(detail?.groupIds) ? detail.groupIds : [];
  const at = ids.indexOf(detail?.id);
  if (at < 0) return null;
  const byId = new Map(list.map((c) => [c.id, c]));
  for (const id of ids.slice(at + 1)) {
    const c = byId.get(id);
    if (c && inboxBucket(c, gx) === "attention") return c;
  }
  return null;
}

// Something of the open review must still be seen: an approval or its check, an update, a link, an undo in flight or
// not confirmed, attendance states being saved, or sent and still offering Check the result (J20-C). Next session waits
// for it. A states group "can't be checked from here" (unknown with a code) offers nothing more and does not hold it.
export function reviewMustStay(gx, detail = gx?.detail) {
  if (!detail) return false;
  if (detail.approving || detail.verifying || detail.updating || gx.linkBusy || undoBusy(gx)) return true;
  const st = detail.states;
  if (st?.saving) return true;
  return Object.values(st?.groups || {}).some((v) => v.status === "sent" || (v.status === "unknown" && !v.code));
}
