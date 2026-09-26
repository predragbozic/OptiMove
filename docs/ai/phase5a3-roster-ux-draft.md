# Phase 5a3 — Activity roster: UX contract

Status: **final**, 2026-09-26. Reviewed by `ux-design-reviewer`: round 1 NOT READY, findings folded in, one narrow re-review READY. Built on:
- the Phase 5a contract (`docs/ai/phase5a-discovery-and-contract.md`, sections 2, 5 and 11) and the API of PR #122 (`GET …/roster`) and PR #123 (`PUT`/`DELETE …/roster/:athleteId/decision`, `POST …/roster/decisions`, `…/roster/complete`, `…/roster/reopen`);
- the Imports rules already adopted (below);
- the GPEXE session wizard the owner shared, **as a reference for speed only**: one list of athletes, a checkbox per row, select-all, a next step that stays in reach, details revealed only when needed. Its layout and words are not copied: no stepper, no "tracks", "drills selection", "indexing", no ambiguous options such as "Average".

The screen is **source-neutral**: it works the same for GPEXE and for any later source. A source is only ever named through the display name the roster answer gives for it (today "GPEXE"); no text below depends on one source's own codes or steps.

Every action in this draft is one the merged 5a2 API can carry out; what it cannot do is listed in section 10, not drawn on the screen.

Out of scope: manual values and estimates (5b), and roster status in Activities and Dashboards (5c). They appear nowhere, not even disabled.

Goal: **the coach finishes a roster with as few clicks as possible.** A "click" below is one click or tap. Typing a note and scrolling are not counted.

---

## 0. Rules this contract applies

From Imports (Phases 2–4b) and the Phase 5a contract:
1. **Plain words in the main flow.** No ids, API codes, SQLSTATEs, table names, "adapter", "observation", "decision kind", "revision", "fingerprint", "canonical", "alias". They live only under a folded **Technical details**, per row and per session.
2. **A missing value is "—", never 0.** Empty is never zero ("0 need a state" is written "Nobody needs a state").
3. **Nothing is preselected or assumed.** No athlete is ticked by default; no state is set by default.
4. **A button says what happens** ("Apply to 4 athletes", "Complete session"), and a confirmation names the scope.
5. **Three different outcomes, three different messages:** saved; refused; not confirmed. The rule is stated once, in section 7 ("Outcome of a write").
6. **Groups by what the coach has to do**, as the Imports inbox does: **Needs a state** (blocks Complete) → **Needs review** (does not block) → **Done**.
7. **The source is named as the coach knows it** ("GPEXE"), never as a system part.
8. **Phones (360–390 px):** cards instead of a table, one sticky bottom bar (section 1, "Sticky bar on a phone"), rows and buttons at least 44 px, inputs 16 px.
9. **Each state is saved as soon as it is chosen** (contract 5.1). No "Save roster" button.

---

## 1. Opening the session

### Where the roster opens (3 ways)
| Way in | Desktop | 375 px | Clicks to the roster |
|---|---|---|---|
| Activities → a team session in the week → the session panel opens on the **Roster** tab when anybody on the roster needs a state, otherwise on **Overview** as today | click the session | tap the session | **1** |
| Activities → session panel already open → **Roster** tab | click the tab | tap the tab | **1** |
| Imports → result row of an imported session → **Open roster** | click | tap | **1** |

The Roster tab exists only for team sessions (other sessions: no tab; the API would answer "not applicable").

How the default tab is chosen: when a team session's panel opens, the roster is read (`GET …/roster`) and the panel shows the **Roster** tab if `counts.needsState > 0`, otherwise **Overview** as today. The tab label carries the count once it is known: `Roster · 3 need a state` / `Roster · Complete` / `Roster · Needs review` / `Roster`.

From Imports: the single-approval answer already carries the session (`import.activityId`); a batch result line and a row of the Imported group reach it through the existing approval read (`GET …/approvals/:approvalId`, one request on click). **Open roster** is shown only where the session is known; for a result that is not confirmed ("Result not confirmed") it is not shown.

After **Complete session** the panel offers **Back to activities** (owner decision). A "next session to finish" shortcut waits until the Activities list can return roster status (section 10, L1).

### Session header (both sizes)
- Line 1: `Full training · Fri 18 Sep, 17:00` (name, date, start time; date only when the session has no start time).
- Line 2: `16 on the roster · 3 need a state · 1 needs review` (every part only when it is not zero; when nothing is missing: `16 on the roster · Everybody has a state`).
- Line 3 (muted): `Each state is saved as soon as you choose it.`
- Status tag right of line 1: none while not started / `Complete` / `Needs review`.

### Desktop layout
```
┌ Activities week ────┐ ┌ Full training · Fri 18 Sep, 17:00              [Complete session] ┐
│ (as today; no roster │ │ 16 on the roster · 3 need a state · 1 needs review               │
│  markers — see L1)   │ │ Each state is saved as soon as you choose it.                    │
│                      │ │ [Needs a state 3] [Needs review 1] [Done 12] [All 16]            │
└──────────────────────┘ │ ☐ Athlete        State                    {metric 1} {metric 2} {metric 3}│
                         │ ☐ Ivan Marković  ○ Unknown   [Did not participate] [Participated · no device data]
                         │ ☐ Luka Jurić     ◐ No usable device record                        │
                         │                  GPEXE flagged this record for a manual check.     │
                         │                  [Participated · no device data] [Did not participate]
                         │   Mira Lukić     ● Measured               {value}    {value}    {value}   │
                         │ ▸ Recorded, but not on this session's roster (2)                   │
                         │ ▸ Technical details                                                │
                         └──────────────────────────────────────────────────────────────────┘
```
Rows are ordered Needs a state → Needs review → Done, then by name. The chips are **Needs a state · Needs review · Done · All** on both sizes. The filter defaults to **All** on desktop; on a phone to **Needs a state** when anybody needs one, otherwise **All**.

Value columns follow section 2 ("Values shown").

### 375 px layout
```
Full training
Fri 18 Sep, 17:00 · Needs review
16 on the roster · 3 need a state
[Needs a state 3] [Needs review 1] [Done 12] [All 16]   ← chips, scroll sideways if needed
┌──────────────────────────────┐
│ ☐ Ivan Marković              │
│ ○ Unknown                    │
│ [Participated · no device data]│  ← full width, 44 px
│ [Did not participate]        │
└──────────────────────────────┘
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  sticky bar: one action (see below)
```

### Sticky bar on a phone
The bar shows **one** message and **one** action at a time, in this priority:
1. a result is not confirmed: `1 result is not confirmed · [Check result]` (section 7);
2. a selection exists: `{n} selected · [Set state…] [Clear]` (section 6);
3. athletes need a state: `3 athletes need a state · [Show them]`;
4. the roster needs review: `Roster needs review · [Review changes]` (section 8);
5. ready: `Everybody has a state · [Complete session]` (section 8);
6. complete: `Complete · [Back to activities]`.

On desktop the same actions sit in the header and the selection bar above the table.
A card stays after a choice, marked `Saved`, until the filter changes (contract 5.2), so it does not jump away under the thumb.

**Loading:** `Loading the roster…` (the header shows at once from the session; rows below). **Could not load:** `The roster could not be loaded. [Try again]`. **Empty roster:** `Nobody was a member of this team on Fri 18 Sep. The roster lists the team's members on the session date.` (+ the Recorded-outside group, section 9, if anyone has values). **Not available any more** (404): `This session is not available any more. [Back to activities]`. **Merged into another session:** `This session was merged into another. [Open the current session]`.

**Read-only view:** the roster answer always comes with the viewer's right to decide (`viewer.basis`), so a viewer who can read can also decide. If a later role can read without deciding, the rows would show states without buttons and no sticky bar; nothing in 5a2 produces that case.

| Case | Primary action | Secondary | Clicks desktop | Clicks 375 px |
|---|---|---|---|---|
| Open a session that needs states | click the session | Roster tab if it opened on Overview | **1** | **1** |
| Open from an Imports result | Open roster | — | **1** | **1** |

---

## 2. Athlete with a measurement

Row: `● Measured` + key values. No controls: there is nothing to decide.

**Values shown.** The value columns (desktop) and the key values (cards) come from the metrics in the roster answer, labelled with each metric's short label (else its label), in a fixed order per metric; `—` when a value is missing. No column is fixed to one kind of device (for example GPS) and none is named after a source, so a source without GPS shows its own metrics. This applies to every row that shows values, including section 9.

- **Measured · change waiting:** `● Measured · change waiting` + line `A newer version of these values is waiting for review in Imports. [Open Imports]`. Group: Needs review. Does not block Complete. (The roster answer does not say which import holds the change, so the link opens the Imports page, not one session: section 10, L4.)
- **Measured values arrived after the decision** (a decision exists and values came later): line `Measured values arrived after Goran Babić set "Participated · no device data" (18 Sep).` + **[Use measured values]** (owner decision: the only action). It first opens an inline confirmation on the row (no modal): `Use the measured values for {athlete}? The state "{state}" set by {coach} will be removed. It stays recorded, but it cannot be set again while measured values exist. If these values belong to another athlete, sort that out in Imports first.` **[Use measured values]** · **[Cancel]**. Confirmed, it removes the decision (a new "removed" entry; history is kept) and the row becomes Measured. Group: Needs review; it does not block Complete. There is deliberately no "Keep this decision" (section 10, Q1).
- Clicking the row (anywhere except a button) unfolds the row: this session's values with units (`—` where missing), who decided and when, and **Technical details** (folded). There is no decision history view in 5a3 (section 10, L3).

| Case | Primary action | Clicks desktop | Clicks 375 px |
|---|---|---|---|
| Measured | none | **0** | **0** |
| Measured after a decision → use the values | Use measured values → Use measured values | **2** | **2** |
| Change waiting → go to Imports | Open Imports | **1** | **1** |

---

## 3. Athlete without a usable device record

Row: `◐ No usable device record` + the source's reason in the coach's words (the source's display name + the reason label from the roster answer), and the next step:
- `GPEXE flagged this record for a manual check. Fix it there, then find new sessions in Imports.`
- `GPEXE marks this record as not valid.`
- A reason without a label: `GPEXE could not give a usable record for this athlete.` A source without a display name: `The device source` instead of the name.

Buttons, in this order: **[Participated · no device data]** (primary) · **[Did not participate]** (secondary).
- Did not participate asks first, inline under the row (not a separate modal): `GPEXE has a record for Luka Jurić. Mark Luka Jurić as not participating anyway?` **[Choose a reason]** / [Cancel] → the reason list (section 5).
- The row never offers bulk "Did not participate" (section 6).

| Case | Primary action | Clicks desktop | Clicks 375 px |
|---|---|---|---|
| Accept as participated without data | Participated · no device data | **1** | **1** |
| Mark absent anyway | Did not participate → Choose a reason → reason | **3** | **3** |

---

## 4. "Participated · no device data"

From an Unknown row: **[Participated · no device data]** — saved at once. The row becomes `▢ Participated · no device data` + `Mira Lukić, just now` + **(Change)**.

Toast/inline confirmation: `Saved: Ivan Marković — Participated · no device data.` (no dialog).

Change: **(Change)** unfolds the same two choices on the row plus **Remove this state** (returns the athlete to Unknown / No usable device record / Measured; the earlier entry is kept, not erased).

| Case | Primary action | Clicks desktop | Clicks 375 px |
|---|---|---|---|
| Set | Participated · no device data | **1** | **1** |
| Change to absent | Change → Did not participate → reason | **3** | **3** |
| Remove the state | Change → Remove this state | **2** | **2** |

---

## 5. Absent with a reason

**[Did not participate]** opens the reason list (desktop: a popover under the row; 375 px: a bottom sheet, rows 48 px; it closes itself after the save, so a phone never stacks sheets):

```
Why did Ivan Marković not participate?
Note (optional)                         0/500
[                                        ]
Choose a reason to save:
  Injury (non-contact)
  Injury (contact)
  Illness
  Load management
  With another team
  Other
[Cancel]
```
- **Tapping a reason saves** (reason required; the note, if typed, is saved with it). No separate Save button.
- The reasons are the six from the roster answer, in its order; the list never shows keys.
- After saving: `✕ Did not participate · Illness` + note (first line) + `Mira Lukić, just now`.
- Failure keeps the sheet open with the chosen reason and the typed note, and a line above the reasons (texts in section 7).

| Case | Primary action | Clicks desktop | Clicks 375 px |
|---|---|---|---|
| Absent, no note | Did not participate → reason | **2** | **2** |
| Absent with a note | Did not participate → (type) → reason | **2** | **2** |

---

## 6. One state for several athletes

1. **A checkbox exists only on rows without a saved state**: Unknown and No usable device record. It does not exist on Measured rows, on rows that already have a state (they change only with **Change** on the row, section 4) and on **Two states** rows (section 7; they are resolved on the row). Tick rows, or use the labelled button `Select the 3 that need a state` (desktop and phone), which ticks exactly the rows without a saved state at that moment, skipping Two states rows; the number does not count them.
2. The action bar appears. Desktop: above the table, sticky: `4 selected · [Participated · no device data] [Did not participate] [Clear selection]`. Phone: the sticky bar (section 1) shows `4 selected · [Set state…] [Clear]`; **Set state…** opens one bottom sheet with both states, and for Did not participate the reason list and **Apply to 4 athletes** are in the same sheet (no second sheet).
3. **Participated · no device data** → confirmation: `Set "Participated · no device data" for 4 athletes? Ivan Marković, Ana Kovač, Petar Kunić, Omar Sijarić.` **[Apply to 4 athletes]** / [Cancel].
4. **Did not participate** → the same reason list (one reason and note for all) → **[Apply to 4 athletes]**.
   - Athletes with a GPEXE record (◐) are left out of a bulk absence and named: `Luka Jurić is left out: GPEXE has a record for Luka Jurić. Set this state on the row.` The count on the button excludes them.
5. Result: `Saved for 4 athletes.` The selection clears.

Limits: at most 60 at once (a team roster is smaller; if more are ticked: `Choose at most 60 athletes at once.`).

**A group decision never changes an existing state, and nobody outside the selection changes:**
- The request carries only the ticked athletes, each sent as "has no state". If any of them got a state or a measured value meanwhile, the server saves **nothing** (section 7).
- The confirmation lists every name it will change, and marks each name hidden by the current chip filter with `(not shown in this filter)`.
- Changing the chip filter keeps the selection, and the bar says so when ticked rows are out of view: `4 selected (1 not shown in this filter)`.
- After any reload, a ticked row that can no longer take the state (now Measured, now with a state, off the roster) is unticked and named: `{athlete} was removed from the selection: now {state}.`

| Case | Primary action | Clicks desktop | Clicks 375 px |
|---|---|---|---|
| All who need a state → participated | Select the N → Participated · no device data → Apply to N athletes | **3** | **3** |
| All who need a state → absent, one reason | Select the N → Did not participate → reason → Apply to N athletes | **4** | **4** |
| k hand-picked → absent | k ticks → Did not participate → reason → Apply | **k + 3** | **k + 3** |

---

## 7. Conflicts and stale decisions

### Outcome of every write

Every roster write has exactly one of these outcomes:

1. **Saved:** OptiMove returns a confirmed success. The UI shows the stored result.
2. **Nothing saved:** OptiMove returns a known refusal code (a coded 400/403/404/409, `roster_busy`, or `internal_error`). The message ends with `Nothing was saved.` The only exception is `already_complete`, which returns the stored completion and is shown as success.
3. **Result not confirmed:** `outcome_unknown`, no answer, timeout, offline state, or an uncoded 502/503/504. The UI must not claim failure. It shows `Result not confirmed` and **Check result**, which repeats the same command with the same `requestKey`; this cannot write twice.

After every confirmed refusal, the roster reloads once and the message says what changed and what to do. Rows are visually marked only when their state or decision differs from the previous successful read on this device. The API does not identify changed athlete rows. Nothing the coach chose is lost silently.

### Two states after merged sessions

When the roster answer flags `decisions_disagree`, the row shows `Two states` in **Needs a state** and lists both states with the coach who set each, using `conflictingDecisions`. It has no checkbox and `Select the N that need a state` skips it. The normal choices remain on the row; one confirmed choice replaces both states. On a complete session, the warning from section 8 is shown first.

| Situation (from the API) | Message (on the row, or on top for bulk / Complete) | Primary action | Clicks to resolve |
|---|---|---|---|
| Someone changed the athlete a moment ago (`decision_changed`) | `Goran Babić changed Ivan Marković a moment ago (now: Did not participate · Illness). Nothing was saved.` | Choose again (the row's buttons, now current) | **1–2** |
| Measured values arrived first (`measured_record_exists`) | `GPEXE values for Ivan Marković just arrived; he is now Measured. Nothing was saved.` | none (nothing to decide) | **0** |
| No longer on the roster (`not_on_roster`) | `Ivan Marković is no longer on this session's roster. Nothing was saved.` | none | **0** |
| Bulk: some athletes changed | `Nothing was saved. 1 athlete changed: Ivan Marković (now Measured).` **[Apply to the other 3]** (the changed row is unticked) | Apply to the other 3 | **1** |
| The session was merged while this screen was open, and the athlete still has a current decision in the resulting session | `This session was merged into another. Ivan Marković's current state is "Did not participate · Illness" in the resulting session. Nothing was saved.` | **Open the current session** | **1** |
| The session was merged while this screen was open, and the athlete needs a decision in the resulting session | `This session was merged into another. Ivan Marković now needs a state in the resulting session. Nothing was saved.` | **Open the current session** | **1** |
| The activity was replaced and there is no current session the viewer can open (`activity_superseded`) | `This session was replaced and can no longer be changed here. Nothing was saved.` | **Back to activities** | **1** |
| The viewer no longer has permission (403) | `Your access changed before this choice was saved. Nothing was saved.` | **Back to activities** | **1** |
| The session is no longer available through this workspace (404) | `This session is not available any more. Nothing was saved.` | **Back to activities** | **1** |
| Another roster operation holds the session (`roster_busy`) | `Someone else is saving this session. Try again. Nothing was saved.` | **Try again** after the automatic reread | **1** |
| The server refused the write before it was committed (`internal_error`) | `Nothing was saved. Try again.` Technical details contain only the stable error code. | **Try again** | **1** |
| A reason disappeared (`unknown_reason`) | `This reason is no longer available. Choose another. Nothing was saved.` | Keep the reason list open | **1** |
| A state was already removed (`nothing_to_clear`) | `Ivan Marković has no state to remove any more.` + the current state after reload + `Nothing was saved.` | none | **0** |
| The request key was used for another command (`request_key_reused`) | `Nothing was saved. Try again.` | **Try again** sends a new command with a new key | **1** |
| The answer was lost or transport failed | `Result not confirmed. Do not choose another state until this result is checked.` | **Check result** (same command, same `requestKey`) | **1** |

For an unconfirmed outcome, the row and every action that could change that athlete are locked until **Check result** returns a saved or refused answer. On a phone, the sticky bar says `1 result is not confirmed · Check result`. Closing the session or leaving Training Load uses the same leave protection as an unconfirmed Imports result. The screen never claims that nothing was saved merely because the answer was lost.

For a bulk command with an unknown outcome, all athletes from that command stay visibly grouped under `Result not confirmed`. The coach cannot send a smaller replacement bulk command until the original `requestKey` is checked. A confirmed replay shows the stored result; it never writes the decisions a second time.

If a reread fails after a command was confirmed as saved, the saved confirmation remains visible and the screen says: `Saved, but the roster could not be refreshed. [Try again]`. It never changes that outcome to `Nothing was saved`.

---

## 8. Complete and automatic Needs review

### When Complete is available

**Complete session** is enabled when the current roster answer says `canComplete: true` and no local read, write or outcome check is still running. The UI does not reproduce the server's eligibility rules. An unconfirmed individual or bulk result also keeps Complete unavailable until it is checked.

When it is disabled, the nearby sentence names the next action rather than showing a generic disabled button:
- `3 athletes still need a state. [Show them]`
- `Check the unconfirmed result before completing this session. [Check result]`
- `This roster has no athletes, so it cannot be completed.`

Rows in **Needs review** do not block Complete. The confirmation names every such athlete and groups them by what needs review, so the coach does not overlook them:

`Complete the roster for Full training · Fri 18 Sep, 17:00? All 16 athletes have a state. Measured values arrived after a state was set: Ivan Marković. A newer version is waiting in Imports: Luka Jurić. These items do not stop roster completion.`

Buttons: **[Complete session]** / [Cancel]. The client sends the `rosterFingerprint` from the currently displayed roster response. No fingerprint or revision is shown to the coach.

| Case | Primary action | Clicks desktop | Clicks 375 px |
|---|---|---:|---:|
| Everybody has a state | Complete session → Complete session | **2** | **2** |
| Some rows still need a state | Show them | **1** to the blocking rows | **1** |
| Complete refused because the roster changed | Review the current roster, then complete again | depends on the changed rows | same |

### Successful completion

Header tag: `Complete`. Confirmation: `Complete — Mira Lukić, 18 Sep 17:42. If device data or states change later, the session will show Needs review.` The primary action becomes **Back to activities**.

The merged API includes a Reopen command, but contract 5.7 deliberately exposes no **Reopen roster** button in 5a3. No hidden or overflow action calls it.

### Changing a completed session

**Change**, **Remove this state**, or a bulk choice on a complete session first shows an inline warning: `This session is complete. Changing this state marks it for review.` **[Change anyway]** / [Cancel]. This adds one click. After a confirmed change, the header becomes `Needs review`; the saved athlete state remains visible.

### The roster changed during Complete

If the fingerprint no longer matches (`roster_changed`), nothing is completed. The response is shown as:

`The roster changed before completion. Nothing was completed. Review the current roster, then complete the session again.`

The roster is reread once. A row is highlighted only when its state or decision differs from the previous successful read on this device; this is a client comparison, not a server claim. When no athlete row differs: `No athlete's state changed; other session data changed. You can complete again.` A second Complete always uses the newly read fingerprint; the old one is never silently reused.

Other outcomes follow section 7:
- `already_complete`: show the stored completion as success, not as an error;
- `revision_changed`: after the reload, `{coach} completed this session a moment ago. Nothing was saved.` only when the roster names that coach; otherwise `This session was changed a moment ago. Nothing was saved.` **[Show]** uses the reloaded roster;
- `roster_incomplete`: `{n} athletes still need a state. Nothing was saved. [Show them]`;
- `roster_empty`: `Nobody is on this session's roster, so it cannot be completed.`;
- `roster_busy`: `Someone else is saving this session. Try again. Nothing was saved.`;
- `outcome_unknown`: `The completion result is not confirmed yet. [Check result]`, with the same `requestKey` and the screen locked against another Complete;
- `internal_error`: `Nothing was completed. Try again.`;
- 403/404 or a replaced session: the corresponding access/session message from section 7.

### Automatic Needs review

After a completed roster receives a relevant change, its tag becomes `Needs review`. The banner never says that completion was undone by a person:

`This roster was complete, but something changed afterwards. Review the current information and complete it again.`

The main-flow explanation is derived from the cause returned by the API:

| API cause | Coach-facing explanation |
|---|---|
| `decision_changed` | `An athlete state changed after completion.` |
| `measurement_changed` | `Measured values changed after completion.` |
| `link_changed` | `A device record was moved to or from another athlete or session.` |
| `roster_changed` | `The session roster or session time changed after completion.` |
| `activity_merged` | `This session was merged or replaced after completion.` |
| `record_unusable` | `A device record now needs a decision.` |
| `change_pending` | `A newer version of measured values is waiting for review.` |
| `input_changed` or an unknown future cause | `The information used to complete this roster changed.` |

Technical cause codes remain folded. The banner action is **Review changes**, which selects the **Needs review** chip. Rows differing from the previous successful read on this device are highlighted; when none differ, the banner explains that other session data changed. **Complete session again** is enabled whenever the current response says `canComplete: true`; there is no hidden “reviewed” checkbox or acknowledgement step. It uses the same two-step confirmation as the first completion.

On 375 px, the sticky bar has one job at a time:
- blocking rows: `3 athletes need a state · Show them`;
- automatic downgrade: `Roster needs review · Review changes`;
- ready: `Everybody has a state · Complete session`;
- complete: `Complete · Back to activities`.

---

## 9. Recorded, but not on this session's roster

This is a separate, read-only group beneath the roster:

`Recorded, but not on this session's roster (2)`

It contains athletes who have measured values for the session but whose membership periods do not place them on this session's roster. The interface does **not** claim that they joined later, left earlier, were entered incorrectly or did anything wrong.

### Behaviour
- Collapsed by default when the roster contains athletes; automatically open when the roster itself is empty and this group is not.
- Each row shows the athlete name, `● Measured`, and the available metrics according to the source-neutral rule in section 2 (`—` for a missing value).
- No checkbox, state buttons, **Change**, bulk action or Complete requirement appears on these rows.
- A line above the rows says: `These athletes have recorded values, but they are not part of this session's roster. They do not need a roster state and do not block completion.`
- If the situation is unexpected: `Check the athlete's team membership. Changing historical membership is not available on this screen.` No cause is guessed and no unsupported correction button is offered.
- Technical details may show stable identifiers and the fact `recordedOutsideRoster`; they must not manufacture a membership explanation.

### Desktop

The group is a disclosure row beneath **Done**, spanning the roster width. Opening it does not alter the active roster filter or selection.

### 375 px

The group is a 44 px disclosure beneath the athlete cards. Its cards use the same value layout as Measured rows but contain no controls. Opening or closing it never changes the sticky action bar.

| Case | Primary action | Clicks desktop | Clicks 375 px |
|---|---|---:|---:|
| Inspect recorded athletes outside the roster | Open the group | **1** | **1** |
| Return to the roster | Close the group (optional) | **1** | **1** |

---

## 10. Decisions, open questions and API limits

### Decisions fixed for 5a3

1. **No invented action.** Every write shown here maps to a merged 5a2 command.
2. **After completion:** offer **Back to activities**, not `Next session to finish`.
3. **Measured values after a coach decision:** offer only **Use measured values**.
4. **Source-neutral language:** a source's display name may appear; its internal vocabulary and codes do not.
5. **Immediate saves:** individual states save on choice; bulk and completion have a named-scope confirmation.
6. **Recorded outside roster:** read-only, neutral and excluded from roster completion.
7. **Manual metric values and estimates:** absent from 5a3; they start in 5b.
8. **Bulk does not replace decisions:** only rows without a saved state can be selected; `Two states` is resolved on its own row.
9. **Completion is not permanent:** later changes produce Needs review; no Reopen button is exposed in 5a3.

### Open product question

**Q1 — Keep the earlier decision after measured values arrive.** The 5a2 API can remove the decision and use measured values, but it has no command that acknowledges the new measurement while deliberately retaining the earlier decision. Therefore 5a3 shows only **Use measured values**. A future contract must define what “keep” means, how the review is resolved, what remains current and how it is audited before such an action can be drawn.

### Known API and navigation limits

| ID | Limit in 5a3 | Behaviour in this contract | Natural later home |
|---|---|---|---|
| L1 | The Activities list does not return roster status. | No calendar/list markers and no `Next session to finish`; the roster status is known only after opening a session. | 5c, when roster status is added to Activities and Dashboards. |
| L2 | The roster is session-based and has no generic route from an unconfirmed import result to an activity. | **Open roster** appears only after an activity/approval is known. | Imports follow-up if the approval read later exposes a stable activity link earlier. |
| L3 | The read API exposes the current decision, not a coach-facing decision-history list. | The row shows the current decision, author and time; there is no History panel. | A later audit/history endpoint, only if coaches need it. |
| L4 | `Measured · change waiting` does not identify which Imports candidate holds the newer version. | **Open Imports** opens the Imports page, not a specific session review. | Add a safe candidate/deep-link reference to the roster read. |
| L5 | 5a2 does not support manual metric values or estimates. | They are neither shown nor disabled. | 5b, with provenance and metric eligibility rules. |
| L6 | Historical team membership cannot be corrected from the roster. | Recorded-outside rows are read-only and use neutral language. | Separate controlled membership-history workflow. |
| L7 | The API has no read-only viewer case today: every successful roster reader also has a decision basis. | The implementation should still render safely without actions if a future response lacks a decision basis. | Future role expansion. |

### Phase 5a3 implementation split

Each PR should be independently reviewable and must not introduce 5b behaviour.

#### 5a3a — Roster shell and read states
- Roster tab, opening rules and source-neutral header.
- GET roster state, groups, filters, loading/error/empty/404/merged states.
- Measured, No usable device record and Recorded outside roster rendering.
- Desktop table and 375 px cards; Technical details folded.
- No write actions yet; visible note that decisions arrive in the next PR if the split is deployed between PRs.

Review focus: terminology, information hierarchy, mobile density, absence of technical/source-specific leakage.

#### 5a3b — Individual and bulk decisions
- Individual set/change/remove actions and reason picker.
- Two states after merged sessions and the confirmation for **Use measured values**.
- Selection only for rows without a state, named-scope bulk confirmation and partial retry using the existing bulk contract.
- Refused, busy, merged, access-changed and unknown-outcome handling with idempotent replay.
- Leave protection for an unconfirmed result.

Review focus: nobody outside the named selection changes, lost answers never become false failures, every action is reachable on 375 px.

#### 5a3c — Complete and Needs review
- Fingerprint- and revision-bound Complete and successful completion.
- Automatic Needs review banner, cause-to-language mapping and “complete again” flow.
- Warning before a decision is changed on an already complete session.
- Cross-navigation to **Back to activities** and **Open Imports** where supported.
- No Reopen button; the merged command remains outside the 5a3 interface under contract 5.7.

Review focus: completion never promises permanence, a changed roster cannot be silently completed, and unknown COMMIT outcomes remain distinguishable.

#### 5a3d — Integrated browser and mobile QA
- Final sticky-bar priority across selection, unconfirmed result, blocking states, Needs review and Complete.
- Keyboard/focus behaviour, screen-reader labels, long names/text and 360/375/390 px checks.
- Integrated regression tests across all three earlier PRs and copy consistency with Imports.
- No new product capability. Keep this PR separate from 5a3c so the completion flow and the mobile/browser verification each receive a focused review.

### UX review record

`ux-design-reviewer` reviewed the whole flow. Round 1 was NOT READY; its 2 HIGH, 9 MEDIUM and 5 LOW findings are incorporated directly into sections 0–10. One narrow re-review returned READY. Its additional finding that `Two states` must never enter bulk selection and its wording clarifications are also incorporated. Visual quality still requires the browser and 360/375/390 px verification assigned to 5a3d.
