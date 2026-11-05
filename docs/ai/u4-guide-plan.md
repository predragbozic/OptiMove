# U4 — the five-step guide and "Use OptiMove variables" (plan, ★, no migration)

Part of J19 (`docs/ai/gps-import-flow-contract.md`, section 3, U4). **Status: Proposed, documentation only; no code before the *Rukovodilac*'s GO.** Verified against `origin/main` `7f6232bc` (U3 deployed). No production read, no GPEXE request.

## 1. Goal

A first-time administrator is led through the five steps - **1 Connect the account, 2 Approve and bind the pair, 3 Find sessions, 4 Link athletes, 5 Import** - without knowing which screen holds what. A sixth action, **Use OptiMove variables**, switches on the system mappings for the team's binding with one confirmation. Nothing new is written by the guide itself: every button is an existing action on an existing route.

## 2. What exists (verified in code)

| Step | Existing screen / route | State is already read by |
|---|---|---|
| 1 Connect | Settings > Source connections (`/api/training-load/sources/gpexe/connections…`, F3c3) | the connection list (`state`: `not_connected`, `linked_untested`, `verified`, `needs_reconnect`, …) |
| 2 Bind | the same screen (`POST …/bindings`, F3c2e); the approved pair in Settings > Data sources | the connection's `bindings` (`state`, `teamId`) and the team status `settings` |
| 3 Find sessions | Imports > *Find new sessions* (`POST …/checks`) | `status.lastCheck`, the candidates list |
| 4 Link athletes | Imports > *Link athletes* (+ U3 suggested pairs) | `source-athletes` (`status` unlinked / linked) |
| 5 Import | Imports > Ready sessions > Approve / batch | the candidates' buckets; the team's import switch (U2, `teamImportSwitch`) |
| Variables | Mappings screen: *Switch on for teams* (`POST /api/training-load/sources/metrics/activations`, S1: `requestKey`, `mappingId`, `versionId`, `bindings: [{bindingId, requirement}]` (1-50), `reason`) | `GET …/activations?bindingId=…&state=open`; the active system mapping versions from `GET …/mappings` |

Phase 8's *Switch on for teams* card already knows every refusal sentence of S1 (archived team, already on, already gets this field, already has this variable at this level); U4 reuses those sentences, it does not invent new ones.

## 3. The design

### 3.1 The guide (frontend only)

- A panel at the top of **Imports** (one per team), for the audiences that can act on a step: a platform admin and the club's admin see all five steps with buttons; the team's coach sees steps 3-5 and, for 1-2, the one sentence "An administrator connects the GPEXE account and approves the team" (no trace of the connection screen). A step's button is an existing action (it opens the existing screen at the right place, or runs the existing action) - never a copy of its logic.
- **Done / next / waiting** per step, derived by one pure function `guideSteps(facts)` in a new `frontend/gpexe-guide-steps.js` (unit-tested without a DOM):

| Step | Done when | Next when |
|---|---|---|
| 1 | an active connection of the team's club is `verified` | none, or `needs_reconnect` (say so) |
| 2 | the team has an active binding to a `verified` connection | step 1 done, no binding |
| 3 | the team has a `succeeded` check (`lastCheck`) | step 2 done |
| 4 | the source-athletes list has no `unlinked` athlete (and at least one linked) | step 3 done |
| 5 | at least one candidate is `imported` | step 4 done; shows "Import switch is off for this team" with the U2 sentence when `teamImportSwitch` is off |

- The panel folds to one line "GPEXE setup complete" once all five are done and the variables are on, and stays openable. A step whose read failed shows "Could not be checked" and is never counted as done.
- Reads: everything above is already loaded by the Imports view; the only new reads are the connection list (administrators) and the activation state (section 3.2).

### 3.2 *Use OptiMove variables* (the one action that is new)

- **What it does:** for the team's active binding, starts every **active system mapping version that is not yet on for that binding**, one `POST /activations` per mapping version, in a fixed order (ascending mapping id), each with its **own `requestKey`** and the same reason ("Switched on from the setup guide"). It **stops at the first refusal** and shows that refusal's existing sentence; nothing already switched on is undone (every activation can be ended on the Mappings screen).
- **Review before sending:** one in-page confirmation (not a native dialog) naming the source (the connection's host label), the team and its GPEXE team, and the list of variables that will be switched on ("<variable> from <field>, version N"), with the one sentence of phase 8: "Imports use it from the next Find new sessions." One primary button "Switch on N variables".
- **Lost answer:** a request whose answer is lost is "Result not confirmed" with *Check result*, which repeats the **same** `requestKey` (S1 is idempotent per key); it is never resent by itself, and no later mapping is started while a result is unconfirmed (the Phase 3b / F2 pattern).
- **State:** a variable counts as on when `GET /activations?bindingId=<id>&state=open` has an open activation of that version; the guide's "variables" line is done when every active system version of the list is on, and says "N variables are not switched on yet" otherwise.
- **Audience and rights:** unchanged server-side - the route decides (platform admin; the club's admin in the club workspace); a coach never sees the button. If J18's board is built later, this button is re-pointed to it (J19 U4 note).

### 3.3 Not changed

Every route, the S1 contract, the import switch (U2), the check, linking (U3), the mapper and the importer. No migration, no new route.

## 4. Tests

- `guideSteps` unit tests: every row of the table above, a failed read (never "done"), a `needs_reconnect` connection, an ended binding, a team with the switch off, a coach's view (steps 1-2 as one sentence).
- Actions through the real handlers with a fake fetch (like `gpexe-imports-*.actions.test.mjs`): the confirmation lists exactly the not-yet-on active system versions; one request per mapping with its own key; stop at the first refusal with its sentence and nothing after it sent; a lost answer -> *Check result* with the same key, no second mapping started; a double click sends one request; a coach never gets the button.
- Mutations: the stop-at-first-refusal, the own-key-per-mapping, the already-on filter, the audience.
- Reviewers: `code-reviewer`, `ux-design-reviewer`, `mobile-qa` (J19 U4 row). No security review (no authz change); a ★ GO of the *Rukovodilac*.

## 5. Risks

- **Wrong requirement chosen for the user** (Q2). The button must name a requirement; the server has no default (C23).
- **Half-switched-on state** after a refusal midway: visible and honest in the panel ("3 of 5 variables are on"), each already-on one is a normal activation.
- **A guide that disagrees with the screens** (stale reads): every step re-reads on open and after any write of the panel; a step is never "done" from a failed read.

## 6. Questions for the *Rukovodilac*

- **Q1:** the panel at the top of Imports, per team, for administrators (recommended), or a separate Setup screen in Settings?
- **Q2:** the requirement the button sends: **Required** for all (recommended: the importer treats both alike since 9-B; Required names a gap as "required value missing"), or **Optional**, or a one-choice selector in the confirmation (more clicks, more honest)?
- **Q3:** "the system mappings" = every *active* system mapping version visible to the viewer's workspace (recommended), or a fixed list of the nine seeded fields?
- **Q4:** may the coach see steps 3-5 with buttons (recommended: they are the coach's work after the pilot, D3), with steps 1-2 as one sentence?
- **Q5:** the guide folds away once done (recommended) or always shows?
