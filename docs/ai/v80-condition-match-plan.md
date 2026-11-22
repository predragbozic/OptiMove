# v80: a column fills a variable with a condition only when the team's GPEXE setting matches (plan)

Status: **Proposed** (the *Rukovodilac*'s order of 2026-11-19, widened by the owner the same day). Plan only: no code and
no migration file. Verified against `main` `912d669c`. Production was not read by this session; its state below is as
the *Rukovodilac* read it.

The owner, on accelerations: a user may set a duration other than 0.3 s in GPEXE (the default is 0.5 s), "so that
should be checked". The range must be shown, and it must **match**.

## 0. Today

- **The conditioned system variables are empty.** Accelerations is `>= 2.5 m/s2`, 0.3 s. Decelerations is
  `<= -2.5 m/s2`, 0.3 s, with key `deccelerations`.
- **The board offers a drop it then refuses.** The platform board shows these variables as "Empty · drag a column here",
  but a drop is refused with `condition_mismatch`. Confirmed in the code:
  - `sourceMetricBoardService.js` marks a variable `placeable` by owner, value type and unit token, and never by
    `has_condition`;
  - the save (`:665`, `:673`, `:739`) refuses any column with no condition onto a conditioned variable.
  - Fix in section 7, step A.
- **The database lets it through; only the service refuses.** `source_metric_check_parameters` (v34) returns early for
  `parameter_kind = 'none'` whatever the target's condition, so the refusal of PR #37 is the service's alone. v80 adds
  the database's own refusal.
- **Event columns show no threshold line.** A column of kind `none` has no range of its own:
  - the zone columns get their line only from the session's team limits and their name (`frontend/zone-ranges.js`,
    `athletesession{power|speed}zone_{distance|time|events}_N`);
  - nothing reads an event column's threshold;
  - the seeded event fields (`more.events.acceleration_events_count`, `…deceleration…`) are of kind `event_threshold`,
    so the board leaves them out as `field_has_parameters` and shows no values for them.
  - So the "Acceleration events" column that shows values is a field of kind `none` (most likely a `details.players.*`
    count created by route C). **Its exact key is a production read for the *Rukovodilac*:** `source_metric_key` of that
    column.

## 1. Where GPEXE's thresholds are in what we already read

| Source | Fields | Proven by |
|---|---|---|
| **Team thresholds**, `team/<id>/thresholds/?valid_on=<session day>`, read once per day per check, kept in the candidate's `raw_bundle.teamThresholds` | `power_thresholds`, `speed_thresholds` (m/s), `acceleration_events_threshold` + `acceleration_events_duration`, `deceleration_events_threshold` + `deceleration_events_duration`; in the answer but not projected: `speed_events_threshold` / `_duration`, `relative_speed_events_*`, `acceleration_thresholds` (zones), `relative_speed_thresholds`, heart rate, jump | The real answer for team 980, set 1473 (`backend/tests/fixtures/gpexe-team-thresholds-1473.json`: 2.5 / 0.3, -2.5 / 0.3, speed events 7 / 0). The adapter's projection `teamThresholds` (`gpexeRestV1Adapter.js:97`). The mapper refuses an incomplete set (`thresholds_payload_incomplete`, `gpexeImportMapper.js:151-158`). |
| **The threshold set of every imported session** | the same six, with the set id, validity and hash | `metric_event_source_bindings.reference_payload` / `reference_hash` (v20): already the provenance of each imported event |
| **Each athlete row's `/more/` events** | `acceleration_events_threshold_value`, `acceleration_events_duration`, `acceleration_events_count`, the same for deceleration | The adapter's projection `moreEvents` (`gpexeRestV1Adapter.js:93`). The event extractor compares the row's own value and duration to the mapping's (`eventCount`, `sourceMetricExtractors.js:131`); a different one blocks the candidate (`threshold_contract`). |

**Unknown:**
- **Whether a `details.players` count was computed with the team's event setting.** It carries no threshold of its own.
  This is the assumption a kind-`none` event column rests on. Before such a column fills a conditioned variable, the
  owner-run check of C97's kind compares, for one session and two or three athletes:
  - the column's value;
  - the `/more/` row count at the team's setting;
  - GPEXE's screen.
- **Whether GPEXE recomputes old sessions after a setting change.** The thresholds are read "valid on the session day",
  so a change in GPEXE with a validity from that day on is seen. A change applied backwards would differ between two
  checks of the same session, and section 3 blocks that session.

**Shown everywhere a zone range is shown today** (board column, Source fields, Create field, Compare), from the stored
session's team setting:
- "Events above 2.5 m/s2 lasting 0.3 s" (acceleration);
- "Events below -2.5 m/s2 lasting 0.3 s" (deceleration);
- "Zone 25–60 W/kg" stays as it is.

Speed is shown in km/h, as GPEXE shows it (stored in m/s, through `unit_conversions`).

## 2. The match rule

A column of kind `none` may fill a conditioned variable only through a **condition rule** that says which team setting
gives the column its range:
- a numbered zone column takes zone N of the power or speed limits (the numbering of `zone-ranges.js`, owner-stated
  evidence 8.13);
- an event column takes the acceleration or deceleration setting.

The rules are a code table beside the extractors. A key with no rule never fills a conditioned variable.

It fills the variable only when the range from the team's setting **equals** the variable's condition:
- **A closed zone:** `between`, lower = limit N-1 (0 for zone 1), upper = limit N.
- **An open top zone:** `>=` the last limit, with no upper.
- **An event:**
  - the operator follows the direction (acceleration `>=`, deceleration `<=`);
  - the value is equal;
  - **the duration is equal** (0.3 s against 0.5 s does not match).
- **Units:** only through `unit_conversions`, in the normal form (m/s to km/h is `× 18 / 5`), compared by
  multiplication as `source_metric_check_parameters` already does. No division, no rounding.
- **Decimals:**
  - every number is read from GPEXE's JSON as the shortest decimal of the double (`0.3`, never `0.30000000000000004`);
  - it is compared exactly, with **no tolerance**;
  - the same unit with different digits is a mismatch, said in plain words (section 5).

A match needs exactly one team setting. Section 4 covers a variable with several teams.

## 3. Where the match is kept, and what the importer does

- **On the T5 activation**, per team binding. It records when it was matched and the setting it was matched against:
  - `matched_condition` (jsonb, the variable's own condition, written once);
  - `matched_threshold_set_id`;
  - `matched_at`.
- The mapping version records which rule it uses: `condition_rule` (for example `{"family":"power","zone":3}` or
  `{"event":"acceleration"}`). A version with a rule is the only kind-`none` version a conditioned variable takes.
- **At every check, for every session**, the importer computes the column's range from that session's own team setting.
  If it differs from the activation's `matched_condition`, **the whole candidate is blocked**, never imported silently:
  `team_setting_changed`, with a sentence naming both values (section 5).
- The other variables of the session are not imported either: a candidate is one approval, as `threshold_contract`
  already works.
- **Values already imported stay as they are.** They matched when they were written. Each event's
  `metric_event_source_bindings` row keeps the setting it was imported under, so a later change never rewrites history.
- To go on after a setting changed in GPEXE, there are two ways:
  - set it back in GPEXE;
  - switch this team's mapping off and use a variable with the new condition (a new variable, or a club's own).

## 4. Per team

- **One system variable can serve several teams;** each activation is matched against its own team's setting.
  Example: First team at 0.3 s, U19 at 0.5 s.
  - **Accelerations (0.3 s) is switched on for First team only.** The board of U19 refuses it, naming both settings.
  - **The U19 club uses a variable of its own** (or the owner's second system variable) with 0.5 s.
- **Two teams of one binding cannot exist** (one binding, one team), so a team never needs two settings at once.
- **A column with no single setting.** When the board shows a column whose team setting differs between sessions of
  the same team, no match is offered. This is like `zoneThresholdsOf`'s `differ`.

## 5. Sentences (plain, for the board, Source fields and Imports)

- **Board column line:** "Events above 2.5 m/s2 lasting 0.3 s (First team's setting in GPEXE)".
- **A conditioned variable with no matching column** (step A, before v80):
  "Counts only events above 2.5 m/s2 lasting 0.3 s. No column fills it yet."
- **A conditioned variable after v80:**
  - with no matching column: "Counts only events above 2.5 m/s2 lasting 0.3 s. Drag a column with the same setting."
  - with a matching column: the ordinary "Empty · drag a column here".
- **A drop refused:** "This column counts events lasting 0.5 s (First team's setting in GPEXE); Accelerations counts
  those lasting 0.3 s. Choose a variable with the same setting, or change the team's setting in GPEXE."
- **Imports, a blocked session:** "First team's acceleration setting in GPEXE changed to 2.5 m/s2 lasting 0.5 s for
  this session; Accelerations counts those lasting 0.3 s. Nothing of this session is imported. Set it back in GPEXE,
  or switch Accelerations off for First team."

## 6. Migration v80 (outline)

**★★, triggers 1 and 3. It adds:**
- the column `source_metric_mapping_versions.condition_rule` (jsonb, null by default; written once);
- the columns `source_metric_mapping_activations.matched_condition`, `matched_threshold_set_id` and `matched_at`
  (written once).

**It changes:**
- `source_metric_check_parameters`, which gets the refusal of a kind-`none` version on a conditioned target unless it
  carries a `condition_rule` of a known shape. That is the database twin of PR #37's refusal.
- The activation guard (v48), which requires `matched_condition` exactly when the version has a rule, equal to the
  target version's condition after `canonicalParametersOf`'s normalisation.

The arithmetic of the match is the service's. The database checks the shape and the equality of the stored condition.

**Locks:** as S1 today (LO-1). The rights rows first, users first, then:
1. the binding;
2. the team's import lock;
3. the mapping version;
4. the variable `FOR SHARE`;
5. the conversions `FOR SHARE`.

The setting is read from the stored candidate before the locks, then compared again under them.

**Rollback** refuses once any version has a `condition_rule` or any activation has a `matched_condition`. It restores
both bodies by md5.

**Tests:**
- every zone N, the open top, both events and m/s to km/h;
- 0.3 against 0.5 s;
- a different value;
- two teams;
- a session whose setting changed is blocked and imports nothing;
- an earlier imported event unchanged;
- the database refusal of a raw kind-`none` version on a conditioned target;
- the board's line and refusals;
- the race of a setting read against an activation.

## 7. Split, effort, and the order of work

| Step | What | Size |
|---|---|---|
| **A** (no migration, frontend + board read) | A conditioned variable is never "Empty · drag a column here"; it says its condition. Event columns get their setting line (from the stored session, read only). | small: about a third of the Divide/Subtract screen |
| **B** (v80, ★★, backend) | Condition rules, the match at board save / mapping version / activation, the database refusal and checks, the importer's block. | large: about twice the Divide/Subtract screen, plus the ★★ reviews and the owner's order |
| **C** (frontend) | The board's matching drop, the refusals naming both settings, the Imports sentence | about the Divide/Subtract screen |
| **Owner-run evidence** | The kind-`none` event column against the `/more/` count, one session (section 1) | before C goes live |

**Recommendation:**
1. A now (it removes the misleading drop).
2. Then the Divide/Subtract screen (PR 2 of v79, already designed, frontend only).
3. Then B and C.

B is the longer and riskier piece. Divide/Subtract gives the owner the per-minute ratios he asked for first. If the owner
wants v80 first, A + B + C replace the screen in the queue unchanged.

**Needs the owner's order:**
- the migration file naming v80;
- the owner-run evidence before a kind-`none` event column is matched in production.

## 8. Questions for the owner (one word each)

1. If a team's GPEXE setting changes, block the session? **Block** (recommended) / **Skip** (import the session without
   that variable).
2. Must the duration match exactly (0.3 against 0.5 s)? **Yes** (recommended) / **No**.
3. Values imported before a setting change: keep them as they are? **Keep** (recommended) / **Hide**.
4. A team with a different setting: should the board offer to create a matching variable from the column in one step?
   **Later** (recommended) / **Now**.

## 9. Step B as built (the Rukovodilac's GO of 2026-11-19)

Runbook `docs/runbooks/condition-match-v80.md`. Where the build departs from sections 3 and 6:

- **New triggers, not replaced bodies.** `source_metric_check_parameters` (v34) and the v48 activation guard are not
  replaced: v80 adds `source_metric_mapping_versions_condition_guard` and `source_metric_mapping_activations_match_guard`.
  Nothing of an earlier migration changes, so the rollback drops what v80 added and needs no md5 restore.
- **`matched_source_range` beside `matched_condition`.** The importer compares a session's range with the range the
  activation was matched with, in GPEXE's units (exact decimal text), so no conversion runs at import time.
- **The owner's confirmation of an event setting** (section 1's "unknown") is a route and an append-only table: the owner
  enters the threshold and the duration GPEXE shows and presses Confirm; they must equal the team setting of the session the
  column was compared in (route O). Until then a details event column matches nothing (`event_setting_not_confirmed`).
- **Which session S1 and A1 read.** The newest stored session of the team that can still be read (not purged, not expired);
  none is `team_setting_missing`. The board reads the session it shows.
- **Not built here:** step C (the screen), the Imports sentence for `team_setting_changed` (the code is in the preview's
  messages; the screen's own sentence is step C), and a check that a team's sessions all carry one setting (section 4's last
  point: the importer blocks every session that differs, so a mixed history never imports silently).

### 9.1 After the reviews of PR #659 (recorded, not built)

- **The database does not bind a rule to the field's key, nor `matched_source_range` to the condition** (the Independent's
  LOW-1; migration v80's version and activation guards): the service does (`conditionRuleFor`, the match). A later
  migration may add a database function that mirrors `conditionRuleFor` in the version guard - only on the Rukovodilac's
  order.
- **An event-setting confirmation holds per field revision and numbers, not per team**: a team whose own session carries
  the same threshold and duration matches without a confirmation of its own. It stays so for now (the Rukovodilac's note to
  the owner, 2026-11-19).

## 10. Step C: the screen contract (Proposed, 2026-11-20; no code before the Rukovodilac's GO)

Verified against `main` `8b3d9639`. Step C is frontend plus three small reads on the server (C0). There is no migration and
no change to a write route, a lock or a right.

**The gate stays closed until the owner has compared and confirmed.** A `details.players.*` event column matches nothing
until two things are recorded, and every screen below says so in plain words:
- the owner's comparison (route O) on one session: session 17.11, two athletes, against GPEXE;
- the owner's confirmation of the setting GPEXE shows: 2.5 m/s² lasting 0.3 s.

Until both exist, the server already refuses: route O's evidence is `not_compared`, and S1, A1 and the board save return
`event_setting_not_confirmed`. The screen adds no gate of its own and never offers a step that the server would refuse.

### C0. Reads the screen needs (server, no migration; code-reviewer + security-reviewer, ★)

1. **`GET /fields/:fieldId` (Source fields detail): an `eventSetting` object**, present only for an events column with an event rule:
   - `{ event, needed: true, compared, sessionSetting, confirmation }`;
   - `compared`: whether route O's comparison is recorded on the active revision;
   - `sessionSetting`: the compared session's `{ operator, value, durationSeconds }`, or null when that session is no
     longer kept;
   - `confirmation`: the newest row `{ thresholdValue, durationSeconds, confirmedAt }`, or null.

   The audience is the field read's (platform admin, club admin). The numbers are GPEXE settings, not personal data, and
   no user id is returned.
2. **The board: per variable with a condition, `waitingFieldIds`.** These are the placeable columns whose match fails only
   because of `event_setting_not_confirmed`. Today such a variable says "No column fills it yet", which hides the reason.
3. **The preview's block `team_setting_changed` names both settings.** It carries `blocked.setting`:
   `{ variableLabel, teamName, current, matched }`, both ranges as `{ operator, value, durationSeconds | min/max, unit }`.
   It also carries the sentence of section 5 built on the server, so the coach and the administrator read the same words.
   The ranges are team settings and carry no id; the coach's "no technical details" rule (J20-A2) is kept.

### C1. Source fields: "Confirm GPEXE's setting" (platform admin, platform workspace only)

On an events column's detail, the platform admin sees one block, **GPEXE's events setting**. Its state comes from
`eventSetting`:

| State | What the block says | Action |
|---|---|---|
| not compared | "Compare this value with GPEXE first (one session, two athletes). Until then it fills no variable with a condition." | link to Compare |
| compared, session no longer kept | "The session you compared is no longer kept. Compare again first." | link to Compare |
| compared, not confirmed | "In GPEXE, open the team's settings and enter the acceleration events threshold and duration it shows." | the form |
| confirmed | "Confirmed: at or above 2.5 m/s² lasting 0.3 s (date)." No form. | none |

- **The form:** two number fields with fixed units (`m/s²` and `s`), 16 px text, `inputmode="decimal"`. A comma is read as
  a decimal point, and the value is sent as text. There is one primary button, **Confirm**. There is no default value:
  the owner types what GPEXE shows and never copies what OptiMove shows, so the compared session's setting is **not**
  shown before Confirm.
- **The answers:**
  - **201 or 200:** the "confirmed" state.
  - **`setting_differs`:** the server's sentence (it names the session's setting). The fields stay filled, so a typing
    error can be corrected.
  - **`not_compared` / `session_not_kept`:** that state's sentence.
  - **`try_again`:** "Nothing was saved. Try again."
  - **`503 outcome_unknown`, a 5xx, or a lost answer:** "Result not confirmed" with **Check result**, which sends the same
    `requestKey` and body; nothing is sent by itself.
  - **`verified_after_commit_error`:** confirmed.
  - **`request_key_reused`:** a new key on the next Confirm.

  One write at a time.
- **A club admin** sees the block read-only: the state words, no form.

### C2. The board (club and platform): the matching drop and the refusals

- **A variable with a condition:**
  - with `matchingFieldIds`: the ordinary "Empty · drag a column here". While dragging, only the matching columns take
    the drop: the others show no drop target, and a drop on them is refused locally with the server's message.
  - with `waitingFieldIds` only: "Counts only events above 2.5 m/s² lasting 0.3 s. A column with this setting waits for
    GPEXE's setting to be confirmed in Source fields." For a platform admin, this is a link to that column's Source fields
    detail.
  - with neither: step A's sentence, unchanged.
- **A refused placement** (`team_setting_mismatch`) shows the server's `message` verbatim (section 5's sentence, naming
  both settings). The other codes (`event_setting_not_confirmed`, `team_setting_missing`, `conversion_unavailable`) each
  get one sentence from the server's text.
- **S1 / A1 refusals** on the Mappings screen name the team, as the server's `current.bindingId` already allows.

### C3. Imports: a session blocked by `team_setting_changed`

- **The session row's reason** (coach and administrator alike) is section 5's sentence from `blocked.setting`: "First
  team's acceleration setting in GPEXE changed to 2.5 m/s² lasting 0.5 s for this session; Accelerations counts those
  lasting 0.3 s. Nothing of this session is imported. Set it back in GPEXE, or switch Accelerations off for First team."
- **The row:** *Needs attention*, with no Approve and no *Update the review*. A new check after GPEXE is set back
  re-reads the session.
- **An administrator** also gets a link to Mappings, for switching the column off for the team.

### C4. Tests and checks

- **Backend (C0):** the three reads; the audience and the identical 404 for the field read; no id in `blocked.setting`.
- **Frontend:**
  - each state of C1 through the real handlers with a fake server: the comma, a lost answer and Check result with the
    same key, `setting_differs` keeping the fields;
  - the board's matching / waiting / neither;
  - the Imports sentence.
- **Mutations** on the form's key reuse and the drop filter.
- **Browser QA** at 1280 / 390 / 360 px for C1 and C3, and the drag at 1280 px.
- **The full `--preset frontend-fast`** on the head against main (the Frontend PR gate).
- **Reviewers:** code-reviewer, mobile-qa and ux-design-reviewer, and security-reviewer for C0. No external trigger
  applies: there is no write, right or migration change.

### C5. Open, for the Rukovodilac

1. Should the club admin see the C1 block at all (read-only), or only the board's "waits for confirmation" line?
   Recommended: read-only, so the club knows why.
2. Should the Imports reason also name the date from which GPEXE's setting changed? The thresholds read gives the set's
   validity. Recommended: no, not now.

Decided by the Rukovodilac (2026-11-20): 1 yes (read-only), 2 no.

### C6. After the merge (#687, #690; 2026-11-20)

- **The owner's decision (2026-11-20, in the Rukovodilac's chat): the confirmation stays as it is.**
  - `setting_differs` keeps naming the compared session's exact setting, and there is no stricter variant.
  - The Independent's note stands as recorded. The confirmation is a record that the owner confirmed. It is not proof that the owner looked at GPEXE, since the refusal and the Compare and Create screens (decision #33) show the setting.
- **The owner's run (2026-11-20):** the five steps done. The comparison, 2.5 m/s² lasting 0.3 s confirmed, and Acceleration and Deceleration events placed for First team.
- **Follow-ups closed with the estimate panel PR:**
  - Mappings shows the server's sentence naming both settings for a team refused with `team_setting_mismatch` (code review LOW-3).
  - The board's drop filter attribute has its own test (the Independent's LOW-1).
  - A negative duration is refused on the screen with its own test (the Independent's LOW-2).
