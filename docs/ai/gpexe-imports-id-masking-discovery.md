# GPEXE athlete id on administrator Imports screens: discovery and as built

Owner order of 2026-10-07, after PR #144 (merge commit `bb3cfdd`). PR #144 hid the GPEXE athlete id on Link
athletes only. This step applies the rule to every administrator Imports screen.

**The rule.** Outside an explicitly closed Technical details section, an administrator sees:
- a GPEXE name ("Name not provided" when GPEXE gave none);
- "Name not loaded (GPEXE athlete N)" when the team has stored identities but this athlete has none;
- "GPEXE athlete N" when the team has no stored identity at all.

N is the athlete's position in the GPEXE athlete list on screen (the server orders it). It is stable for that
list and never stored. The id appears nowhere else: not in a title, row, summary, button, confirmation, warning,
error, notice, aria-label or screen-reader text.

**A coach** keeps the screens as before (the id in the text). A coach never requests an identity and gets no sign
that a snapshot exists. Backend authorization, Link / Unlink semantics, v32 and the identity service are unchanged.

## Where the id was shown outside Technical details (code read on `bb3cfdd`)

| # | Screen | Place (`frontend/…`) | Before | Now, for an administrator |
|---|---|---|---|---|
| 1 | Imports page | list "GPEXE athletes linked to this team" (`gpexe-import-view.js`, `renderLinksHtml`) | "GPEXE athlete 104" next to the OptiMove name | "GPEXE: <label>"; id in Technical details |
| 2 | Imports page | last-link notice (`renderLastLinkHtml`) | "GPEXE athlete 104 is now linked to …" | "The GPEXE athlete <label> is now linked to …" |
| 3 | Link athletes | row title of an athlete without a stored identity (`renderMapRowHtml`, `gpexeLabel`) | "GPEXE athlete 104" (PR #144 already masked loaded names) | "Name not loaded (GPEXE athlete N)" or "GPEXE athlete N"; id in Technical details |
| 4 | Link athletes | linked-row side line | "GPEXE athlete 104" | "GPEXE: <label>" |
| 5 | Link athletes | select `aria-label` | "Link GPEXE athlete 104 to" | "Link the GPEXE athlete <label>[, Born …][, last seen …] to" |
| 6 | Link athletes | confirmation pairs and results | "GPEXE athlete 104 → …" | label; id in Technical details |
| 7 | Link athletes | staged-choice errors (`stagedTeamMapping`, `gpexe-import-data.js`) | "… for GPEXE athlete 104 …", "… for GPEXE athletes 104 and 105 …" | label with the last session; "chosen for two GPEXE athletes" |
| 8 | Imports page / Link athletes | the unlink question (`unlinkQuestion`, `gpexe-import-actions.js`, `window.confirm`) | "Unlink GPEXE athlete 104 from …" | "Unlink the GPEXE athlete "<label>" from …" |
| 9 | Session review | athlete row title of an unlinked athlete (`athleteName`) | "GPEXE athlete 104" | label; id in the row's Technical details |
| 10 | Session review | link context sentence (`renderLinkContextHtml`) | "Recorded by GPEXE for athlete 104 …" | "Recorded by GPEXE for the GPEXE athlete <label> …" |
| 11 | Session review | single-link controls (`renderLinkHtml`): the find sentence, the select label, the confirmation pair and sentence, and "Every athlete … already linked" | "Find athlete 104 …", "Link GPEXE athlete 104 to", "athlete 104's results …", "If athlete 104 …" | label or "this GPEXE athlete"; id in Technical details |
| 12 | Session review | blocked-session step `relink_athlete` (`coachStep`) | "Link GPEXE athlete 104 again to …" | "Link the GPEXE athlete <label> again to …" (the server's own step stays in Technical details) |
| 13 | Session review | changes to imported results of an athlete without an OptiMove name (`renderChangesHtml`) | "GPEXE athlete 104" | label; id in Technical details |

Not affected, because they carry no GPEXE athlete id:
- the server's user-facing messages in previews (`notImported`, GPS reasons, change messages);
- batch results, the sessions calendar, the next-step line and notices;
- `data-*` attributes, which are not shown and not read by assistive technology.

## How the identities reach every screen
An administrator's Imports view reads the stored identities with the team (`GET …/athlete-identities`, no GPEXE
request), not only while Link athletes is open.
- They are read again when Link athletes opens and after a link change.
- Closing Link athletes keeps them for the other Imports screens.
- Leaving Imports, a team switch, a workspace switch and signing out drop them (in memory only, as before).
- A coach's view never asks.

## Tests and mutations
- `frontend/tests/gpexe-imports-id-masking.actions.test.mjs` covers both administrator bases (club admin and
  platform admin) and the coach. It splits every render into Technical details and the rest (text plus aria-label,
  title, alt and placeholder), and asserts:
  - every id only inside Technical details, for a valid name, "Name not provided", not loaded or expired, and a
    24-hour suppression;
  - linked and unlinked athletes, the last link result, confirmations, results and errors;
  - the unlink question;
  - the session review;
  - the no-snapshot ordinals, both with an empty snapshot and with the identity read refused (404).
- A mutation per masking guard (17) is killed: `scratchpad/mask-mutations.mjs` in the PR record.
