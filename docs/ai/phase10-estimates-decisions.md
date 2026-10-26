# Phase 10: manual corrections and estimates — decisions

Status: **decisions and recommendations, not built.** Phase 10 of `docs/ai/metrics-core-plan.md` starts after phase 9
(M4) is merged, with a contract the owner approves (★★).
- **Decided by the owner (2026-10-26):** D2, D6, D7, D7a, D13 and Q1–Q5.
- **Recommendations:** D1, D3–D5 and D8–D12 stay recommendations until that contract.
- **Before implementation:** both are written into section C of `docs/ai/gpexe-metric-variable-mapping-discovery.md`
  (A3 of the plan).

Nothing here is code, a migration or a schema. The formulas are new owner decisions, since
`docs/ai/phase5a-discovery-and-contract.md` §3.7 says "No formula is part of this".

Last verified against commit: `deb2aa1`.

**Basis:**
- `docs/ai/phase5a-discovery-and-contract.md`:
  - §0 (5, 7);
  - §2 (the state "◇ Estimated · method");
  - §3.3 (the trigger "measured is never overridden");
  - §3.5 (source observations);
  - §3.6 (the right to decide);
  - §3.7 (`entry_method 'estimated'`, `training_load.metric_estimations`).
- The discovery document: section I (more than one track) and section J (M4, M5).
- Code:
  - `backend/src/gpexeImportMapper.js`: `GPEXE_METRIC_SPECS`, `ACTIVITY_TYPE_BY_CATEGORY` (only `FULL TRAINING`), the
    `multiple_tracks` anomaly;
  - `backend/src/gpexeImportWriter.js`: the re-import rules.

**The owner's words** (written in the *Rukovodilac*'s chat on 2026-10-26, and checked by the executor in that
session's transcript):
- D2, D6, D7, D7a: „D2 ulaze u procene to su acc i dec iznad 80% od acc velocity ili dec velocity profila koji se
  linearno menja sa promenom brzinom. D6 uzima se prosek max brzina. D7 ja određujem koliko utakmica i minimum minuta
  default je 5 i preko 60min da traje. D7a ručno se unose ili moze kao prosek kao u d7”;
- Q1, Q2, Q4: „b, igrao bar 60 min i min 5 utakmica default ako korisnik ne promeni, 180 dana ostaje”;
- Q3: „Trener za svoj tim”;
- the window: „180 dana moze da se menja”;
- Q5: „Burst i brake se preuzimaju kao broj koji je neko uradio funkcioniše isto kao i acc dec. Ne znam sta je tu
  nesljasno”;
- D13: „Može, prenesi (a)”;
- the whole package: „Potvrdi i da krenemo”.

## 0. General rules (every method)

1. **Never as a measurement.** Every value from this phase is `entry_method = 'estimated'` (or `'manual'` for a plain
   manual entry), with one row in `training_load.metric_estimations` (§3.7).
   - The GPEXE event and its values are never changed.
   - An estimate lives in an event owned by the coach, linked to the same activity (§0 item 7).
2. **A measurement wins.** An estimate is refused while the athlete has a valid measured value (`api_import` /
   `csv_import`) in that activity (§3.3, trigger 4).
   - If a measurement arrives later, the row is marked "Measured values arrived after the decision" (§2), and the
     coach chooses.
   - Nothing is deleted by itself.
3. **No estimate from an estimate.** Only measured values (`api_import` / `csv_import`) are an input. Other athletes'
   manual values and estimates are an input of no method. The one exception is D7a (b), section 5.
4. **The right.** An estimate is made only by someone who may decide an athlete's state in the session (§3.6: the
   team coach, the club admin, the platform admin), under the same lock order.
5. **Target variables.** After M4 (phase 9) an estimate is written into a canonical Metrics Core variable, under the
   definition's current version that the measurement of that team uses (section 8). That is why phase 10 follows
   phase 9.
6. **A method states, for every metric, whether it produces it.** What it does not produce goes into
   `metrics_refused` with a reason. Empty is never zero.

## 1. Metric classes (the input of every method)

The metrics the importer carries today (`GPEXE_METRIC_SPECS`):

| Metric | Unit | Class | Sum of two tracks | Per minute | Team average | Copy |
|---|---|---|---|---|---|---|
| TIME (`gpexe_time_min`) | min | duration | yes (if they do not overlap) | — (it is the minutes) | yes | yes |
| TotDist (`gpexe_total_distance`) | m | additive | yes | yes | yes | yes |
| Sprint ≥25.2 km/h (`gpexe_sprint_distance_7mps`) | m | additive | yes | yes | yes | yes |
| Accel ≥2.5 m/s² (`gpexe_acceleration_events`) | n | count | yes | yes | yes | yes |
| Decel ≤−2.5 m/s² (`gpexe_deceleration_events`) | n | count | yes | yes | yes | yes |
| Burst / brake (`gpexe_burst_events`, `gpexe_brake_events`) | n | count (D2, Q5) | yes | yes | yes | yes |
| SPEEDmax (`gpexe_max_speed`) | km/h | peak | **no, the larger is taken** | **no** | D6 (section 4) | yes |

- **D2 (owner).** Burst and brake enter the estimates as count metrics. The owner's working definition: accelerations
  and decelerations above 80 % of the athlete's acceleration-velocity or deceleration-velocity profile, which changes
  linearly with speed.
- **Q1 (owner): (b).** That definition is a working description until GPEXE confirms it.
  - C97 stays in force: the M2b meaning act for these fields still needs official GPEXE documentation or a written
    answer from GPEXE support.
  - Burst and brake estimates are allowed now, with that description as the working definition.
- **Q5 (owner).** Burst and brake are treated like the acc and dec counts and enter every method (2.2, 3, 4, 5),
  always marked as an estimate.
  - Rejected recommendation, kept for the record: leave them out of the copy and the team average, refused as
    `metric_not_transferable`, because they are computed against each athlete's own profile.
- **Zones** (power, speed) join this table only once they are mapped as canonical variables after phase 5 (the zone
  model) and M4. Their class is then "additive".
- **Derived metrics** (m/min, Acc+Dec, HMLD, …) are never produced by an estimate. By the owner's decision of
  2026-09-17 they wait for a separate feature with a formula and a formula version.

## 2. More than one GPS track of an athlete (M5)

Today such an athlete is not imported (`multiple_tracks`, needs manual review; discovery section I). The data do not
say whether the tracks overlap in time.

### 2.1 Choosing one track (`track_choose_one`, v1)
- **The choice.** The coach sees both tracks side by side: duration, distance, max speed and the start time. The data
  carry the start of a track only, not its end. The coach chooses one.
- **The values.** The chosen track's values are written as an estimate with the method `track_choose_one`. They are
  not a measurement, because the choice is a person's (rule 0.1).
- **D1 (recommendation): the trade-off.**
  - An `estimated` occasion (§3.7) has no source identity (`source_identity_id`) and no `import_batch_id`.
  - So the chosen values lose their GPEXE identity and the idempotency of a re-import, and a later correction of that
    track in GPEXE is not recognised as its change.
  - *Alternative:* the chosen track stays `api_import` with its source identity, and the manual choice is recorded as
    a decision.
  - *Recommendation:* `estimated`. It is simpler and never looks like a plain measurement, and the loss of
    correction tracking is accepted knowingly.
- **In `reference`:**
  - both source identities;
  - which one was chosen;
  - a snapshot of the **chosen** track's values;
  - the reason for the choice (a mandatory short note, at most 500 characters).
- **The rejected track (D13 = (a), owner).** The decision record that phase 10 introduces for D1 and the estimates
  holds, with the choice: which track was used, which was rejected (its source identity only), who decided and when.
  - The rejected track's data are not kept; they stay in GPEXE.
  - The record serves three purposes:
    - a trace of why a value looks as it does;
    - at the next GPEXE check the decision is recognised, so the coach does not choose again;
    - the choice can be changed later.
  - No extension of the §3.5 source observations, and no migration just for the rejected track.
  - Open technical question T1 (section 10).

### 2.2 The sum of two tracks (`track_sum_disjoint`, v1)
- **Only with the coach's explicit confirmation.** A confirmation box with the text "These two tracks do not cover the
  same time (for example, the first and the second half)." Without it the sum is not offered.
- **Formula:**
  - additive and count metrics (burst and brake included): the sum;
  - TIME: the sum;
  - SPEEDmax: **the larger of the two**.
- **In `reference`:**
  - both identities;
  - a snapshot of both tracks' values;
  - the confirmation text and its version (`overlap_statement_v1`);
  - who confirmed it, and when.
- **The coach's confirmation is the only basis for the sum**, and it is recorded as such.
  - The system cannot check the overlap: the data carry a track's start (`track.timestamp`) only, neither its end nor
    a duration per track (discovery section I; the mapper reads nothing else).
  - An automatic check (for example start + TIME per athlete-session row) is an optional future item. It comes only
    once the owner has collected evidence that tracks carry a reliable start and duration, on the pattern of C97.
    Until then it is not claimed to be possible.
- **D3 (recommendation):** two tracks only. Three or more stay "needs manual review" (choosing one is still possible).

## 3. A copy from another athlete (`copy_from_athlete`, v1)
- **The source** is a measured teammate in the **same** activity (the same session, the same team), never another
  session.
- **What is copied:** every metric the source has, burst and brake included (Q5).
- **Shown in Activities and the Roster** as `◇ Estimate · copied from <source's name>`: the ◇ glyph and the word,
  never colour alone. Only those who may see the source athlete see the name; everyone else sees
  `◇ Estimate · copied from a teammate`.
- **Dashboards:** section 6.
- **When the source changes:** if the source's measured values change later (a new version from GPEXE), the copy
  **does not change by itself**. The row is marked "The copy's source changed", and the coach decides; a new estimate
  replaces the old one, with history.
- **D4 (recommendation):** from the same activity only; no automatic following of the source.

## 4. The team average (`team_average`, v1)
1. **Input:** the measured teammates in the **same activity** (as in section 3), without those with an estimate or a
   manual entry. Never an average over several sessions.
2. **Minimum:** 3 measured teammates per metric. Fewer refuses that metric's estimate with the stable code
   `too_few_measured` in `metrics_refused`.
3. **D6 (owner):** SPEEDmax is estimated as the average of the measured teammates' max speeds, clearly marked.
4. **Formula:** the arithmetic mean, not weighted by minutes. It is kept apart from method 5.
5. **In `reference`:** the athletes whose values entered, and the count per metric.

**D5 (recommendation):** the same activity, a minimum of 3, and no weighting by minutes in v1. A weighting by minutes
(the mean rate × the athlete's minutes) is not recommended for v1, because a training session's minutes are usually
not entered by hand.

## 5. A match: the average of the last N matches, scaled to the minutes (`match_rate_last_n`, v1)

**Precondition.** The GPEXE import accepts only the `FULL TRAINING` category today (`ACTIVITY_TYPE_BY_CATEGORY`).
Matches are refused (`unsupported_category`), so the database holds no measured match from GPEXE.
- Importing GPEXE matches (mapping a GPEXE category to the activity type `match`, which already exists in
  `training.activity_types`) is a separate owner decision and a separate phase (D9).

**D7a (owner): until matches are imported, both ways are allowed:**
- (a) a **manual entry** of a match's values (`entry_method = 'manual'`);
- (b) an **estimate by the D7 formula over manually entered matches.**
  - It is an exception to rule 0.3, for this method only.
  - Every manual match is visibly marked "manual entry" in `reference`, and the estimate carries the label "based on
    manual values".

**The formula, once the data exist:**
1. **What a "match" is (D7, Q2, owner):** a canonical activity of type `match` of the same team, in which the athlete
   **played at least 60 minutes** and has values. The minimum minutes are a team setting; the default is 60.
2. **N and the window (D7, Q4, owner):** the last **5** such matches before the given match, in the last **180 days**,
   and at least **5** such matches. N, the minimum number of matches and the window are team settings; the defaults
   are 5, 5 and 180. Fewer matches than the minimum refuse the estimate (`metrics_refused`, `too_few_matches`).
3. **Minutes:** the manually entered minutes of the given match (§3.7 `minutes_occasion_id`, a manual TIME occasion).
   Without them the method is not available.
4. **Formula per metric** (additive and count metrics, burst and brake included):
   - the weighted rate `rate = Σ value(i) / Σ minutes(i)` over the N matches;
   - estimate = `rate × entered minutes`;
   - rounded to the canonical variable's precision.
5. **SPEEDmax is not scaled.** **D8 (recommendation):** refuse it (`not_rate_scalable`). The alternative is the
   average max speed of the N matches, unscaled.
6. **In `reference`:**
   - the identities of the N matches and a snapshot of their values;
   - their minutes, and the entered minutes;
   - the settings used (section 7);
   - `metrics_produced`, and `metrics_refused` with the reasons.

## 6. Estimates in Dashboards and Activities

By §0 item 5 and §3.7, the Dashboards `source_policy` gains `estimated`, and Activities no longer show `manual` when the
method is missing.

**D10 (recommendation):**
- **Dashboards.** The default source **excludes estimates**.
  - They are included explicitly ("Include estimates"), and the series then carries the label "includes estimates
    (N values)".
  - Today the default `all_with_conflicts` would include estimates silently (§0 item 5), so it changes in the same PR.
- **Activities and the Roster** always show:
  - the ◇ glyph;
  - the word "Estimate";
  - the method and its version;
  - the `reference` in the details.

## 7. Method versions and team settings
- **The method key is fixed** (`track_choose_one`, `track_sum_disjoint`, `copy_from_athlete`, `team_average`,
  `match_rate_last_n`).
- **`method_version`** is an integer. It goes up with **every** change of the formula, of the inputs, of a fixed
  threshold (for example the minimum number of teammates), or of the list of metrics the method produces.
- **Team settings (Q3, owner):**
  - N, the minimum number of matches, the minimum minutes played and the window in days (default 180; the owner:
    „180 dana moze da se menja”) are team settings of method 5, not part of `method_version`;
  - the coach changes them for their own team, with the same right as D12 (the team coach, the club admin, the
    platform admin).
- **The *Rukovodilac*'s proposal for the settings**, so that it is always visible what an estimate rests on:
  - every estimate records in `reference` the settings it was computed with;
  - every change of a setting has an audit row (who, when, old, new);
  - a change does not change the estimates already computed (D11).
- **Each version's description** is written into section C of the discovery document (or a phase 10 document)
  before the code.
- **D11 (recommendation): no automatic recomputation.**
  - An old estimate is **never recomputed by itself**, and a new version applies to new estimates only.
  - Recomputing is the coach's explicit action: it makes a new estimate that replaces the old one, with history.

## 8. Relation to the Metrics Core mapping (M4)
- **The target.** An estimate targets the **canonical variable** (the definition and its current version), the same
  one the measurement goes into after M4. The unit is the canonical one; the inputs are canonical values already, so
  no conversion is needed.
- **No T6.** An estimate does **not** write T6 (source fact provenance), which is for source facts. Its provenance is
  `metric_estimations`.
- **Versions.** If the canonical variable gets a new version (M3-0) between the measurement and the estimate, the
  estimate is computed over values of one version. Mixed versions are refused (`metrics_refused`, `version_mismatch`).

## 9. Decision table

| # | Question | Decision / recommendation |
|---|---|---|
| D1 | Every value of this phase as `estimated` (the track choice included), losing the chosen track's GPEXE identity (2.1) | recommendation: yes (alternative: `api_import` + a decision) |
| D2 | Burst / brake | **owner:** they enter the estimates; working definition: accelerations and decelerations above 80 % of the A-V / D-V profile, linear in speed; **Q1 (b):** a description until GPEXE confirms it, C97 stays; **Q5:** every method, like acc / dec |
| D3 | Sum of tracks: two tracks only; the coach's confirmation is the only basis (the system cannot check the overlap); max speed = the larger | recommendation: yes |
| D4 | Copy: same activity only; no automatic following of the source | recommendation: yes |
| D5 | Team average: measured teammates of the same activity, minimum 3 (else `too_few_measured`); no weighting by minutes in v1 | recommendation: yes |
| D6 | SPEEDmax in the team average | **owner:** the average of the measured teammates' max speeds |
| D7 | Match: type `match`; weighted rate × entered minutes | **owner:** played ≥ 60 min (Q2); N = 5, at least 5 matches, window 180 days (Q4); N, the minimums and the window are team settings the coach changes for their own team (Q3) |
| D7a | Until matches are imported | **owner:** both a manual entry and an estimate by D7 over manual matches, visibly marked |
| D8 | SPEEDmax in the per-minute method | recommendation: refuse (`not_rate_scalable`) |
| D9 | Importing GPEXE matches as the precondition of method 5 | recommendation: a separate decision and phase, before phase 10 |
| D10 | Dashboards: estimates excluded by default, included explicitly with a label | recommendation: yes |
| D11 | Method version: every change raises it; no automatic recomputation | recommendation: yes |
| D12 | The right: the same as deciding an athlete's state in a session (§3.6) | recommendation: yes |
| D13 | The rejected GPS track | **owner: (a):** only its source identity, who and when, in the same decision record as D1; none of its data, no §3.5 extension, no migration of its own |

## 10. Open technical question (for the phase 10 contract, not an owner decision)

- **T1.** The choice of one track (D1) is made, and a new GPEXE check brings different content for one of the two
  tracks.
  - The *Rukovodilac* proposes that the choice is then confirmed again.
  - The contract has to say how the change is recognised: a content hash of both tracks kept with the decision, or the
    existing `change_pending` / "Measured values arrived after the decision" path.
  - It also has to say what holds until the confirmation. Proposal: the old estimate stays visible, marked as having
    a changed source.
