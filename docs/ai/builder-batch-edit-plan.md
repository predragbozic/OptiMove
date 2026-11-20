# Builder: applying an edit of a published batch to every athlete (plan)

Status: **Accepted** (2026-11-19, written against `main` `f406ee2d`): the OptiMove manager's GO for the step 2 code,
with the rulings and binding conditions of section 10 (relayed by the central calendar's stream manager). Where
sections 1–9 differ from section 10, section 10 wins. ★★
(external-review triggers 3 and 4: copy / materialization, transactions and lock order). The OptiMove manager
reviews it before any code.

Step 1 (branch `claude/builder-edit-draft-batch-step1`, frontend only) already makes the screen honest: a reopened
member of a batch says "Changes go to this athlete only." and sends no `syncBatch`. This plan is step 2: making
"apply to all athletes" real for a published batch.

## 0. The bug, in one paragraph

A weekly plan for N athletes is N plans sharing one `builder_batch_id` (`backend/src/routes/builder.js:437`,
`:474-477`). While they are drafts, `syncBatch` copies the open plan over its draft siblings
(`syncBatchContentWithClient`, `:2007-2032`). Once published, reopening one makes an **edit draft** of that plan
alone (`POST /plans/:id/edit`, `:850-928`), and Save applies it to that plan alone (`applyEditDraft`,
`:2117-2190`). `wantsBatchSync` is false for an edit draft (`:1846-1851`) and `syncBatchFromPlan` returns at once for
one (`:2041`), so the other athletes never get the change (proved by a real run, `docs/ai/central-calendar-k3-plan.md`
section 1.1 on branch `claude/central-calendar-k3-plan`).

The existing draft sync cannot simply be switched on for published siblings: it deletes and recreates a sibling's
whole tree with **fresh** `logical_session_id`s (`copyDaySessions`, `:2341-2376`, without `preserveLogicalId`). On a
published plan that would orphan entered RPE (`training_load.session_feedback` is unique on
`(athlete_id, logical_session_id)`, v2 migration) and reopen the session for a second submission — the reason
`lockBatchPlansForUpdate` only ever returns **draft** siblings (`:1951-1979`, the comment at `:1915-1934`).

## 1. The rule: apply the change, not the copy

Save computes what the coach **changed** in this edit — the edit draft against the source plan as it is now — and
applies only that change to every other live member. Everything the coach did not touch in this edit stays as each
athlete has it. This is what lets the other athletes keep their own ids, links, results and settings.

The two inputs are already in the database at Save:

- **before**: the source plan (the edited athlete's live plan), untouched until Save;
- **after**: the edit draft. Its sessions carry the source's `logical_session_id`s (`preserveLogicalId`, `:906`), so
  before ↔ after is matched **by logical id**, exactly.

A sibling's session is matched to a **before** session by its **slot** in that week: weekday, `am_pm`, `bta`,
`session_order` (the key the calendar's links use, v49 `calendar.event_session_links`, and the shape the draft sync
copied positionally). If a slot is not unique in a plan (two sessions with the same key), that plan's day is
**ambiguous** and is treated as diverged (section 3).

### 1.1 The operations, per session

| before → after (the edited athlete) | the sibling's matched session | what Save does to the sibling |
|---|---|---|
| unchanged (same fields, same content) | anything | nothing |
| changed content and/or fields | content equal to **before** | its content replaced by **after**'s; its `logical_session_id` kept; fields three-way (1.2) |
| changed | content different from **before** | **diverged** (section 3) |
| added (logical id not in before) | its slot empty | a new session with a **fresh** logical id (as the draft sync does) |
| added | its slot taken | **diverged** |
| removed (logical id not in after) | equal to **before**, no results, no live link | removed |
| removed | has results or a live calendar link | **blocked** (section 3) |
| moved to another slot | equal to **before**, no results, no live link on the old slot | moves with it, logical id kept |
| moved | results, or a live link on the old slot | **blocked** (a slot-keyed link would stay on an empty slot; Q5 as ruled) |

"Content" is the session's node and item tree (domains, sections, exercises, doses, instructions), compared by a
canonical, id-free fingerprint computed in the same transaction (a new helper; nothing stored). "Results" means a row
of `training_load.session_feedback` with the sibling's athlete and the matched session's logical id.

### 1.2 Fields: three-way, per field

For each field of a session (name, time, `am_pm`, `bta`, `rpe_enabled`, `training_load_enabled`), of a day
(`day_note`, `block_name`) and of the plan (`name`, `note`, `icon_url`, `color`, `track_training_load_default`,
`request_rpe_default`): if after = before, the sibling keeps its own value; if after ≠ before, the sibling gets
after's value — **unless** the sibling's value already differs from before, which is **diverged** for that session
(or, for a plan field, for that member).

This keeps the other athletes' **Track** and **Request RPE** settings as they are, unless the coach changed that very
setting in this edit (decision **Q4**).

## 2. Where and how: one transaction, the existing lock order

All of it runs inside `applyEditDraft`, in **the same transaction** that applies the edited athlete's own plan. The
lock order stays the one this file already documents; nothing new is invented:

1. `lockExerciseReuse(client)` (the advisory lock `applyEditDraft` already takes first);
2. the **edit draft's** own row `FOR UPDATE` (as today, `:2135-2140`);
3. **every live member of the batch, the source included, `FOR UPDATE` in ascending id** — through
   `lockBatchPlansForUpdate` (`:1951`). Today the source is locked on its own (`:2155`); with a batch it is locked
   **only** as one row of the ascending set, never before it, so the order matches every other multi-plan caller.

`lockBatchPlansForUpdate` today returns draft siblings only and filters the candidates by the **caller** as creator.
For this path it gains one option (same function, same order, same discovery read of the immutable
`builder_batch_id`): `members: "live"` — the candidates are the batch's active, non-edit-draft plans created by the
**source plan's creator**, and the returned siblings are the `active` ones. Rights are not decided by that filter;
they are checked per member after the locks (section 3, "no rights").

4. Under those locks, before the first write: read before / after / each sibling, classify every member (sections 1
   and 3). **Any refusal here writes nothing.**
5. Write: the edited athlete's plan exactly as today; then each chosen sibling, in ascending id; then delete the edit
   draft (as today); `assertExerciseReuseAllowed` for every written plan; one bounded COMMIT.

Why this cannot deadlock with the calendar: an event attach / create / alignment locks the live plans `FOR SHARE` in
ascending id (`lockPlansForShare`, `calendarEventService.js:1460`, called at `:876`, `:1643`, `:1691`, `:1732`) and
only then the sessions; it never takes an edit draft. Save takes no event or link row. Two ascending sweeps over the
same plan rows cannot cross. A Save and a draft-batch submit (`syncAndActivateBatchWithClient`) never meet: one works
on active members, the other on draft members of different batches (a batch is all-draft or published).

One small change outside `applyEditDraft` is needed for correctness: **`POST /plans/:id/edit` takes its source row
`FOR SHARE`** before copying it (today it reads it unlocked, `:854`). Otherwise a coach who reopens member B while
another coach's Save is changing B copies B's old content into the new edit draft, and B's later Save would put it
back. With the share lock the copy waits for the Save and sees the new content. One row, one lock: no new order.

### 2.1 How a sibling session is written

The writes reuse the existing copy helpers (`copyDaySessions`, `copyBuilderSessionContents`), with one addition: an
explicit map `after session → logical id to write` instead of the all-or-nothing `preserveLogicalId` flag. A changed
session gets the sibling's own logical id; an added one gets none (the column default mints a fresh one). Unchanged
sibling sessions are not deleted or recreated at all — so their `plan_session_id`s, their content and anything the
coach tailored for that athlete stay byte for byte. (Today's whole-tree replace in `copyWeeklyPlanTree` is used only
for the edited athlete, as now.)

### 2.2 What each other athlete keeps

- **`logical_session_id`s**: kept for every matched session; only an added session gets a new one.
- **Calendar links**: they are keyed by slot (plan, day, `am_pm`, `bta`, `session_order`), not by session row, so a
  session changed in place keeps its link. A change that would leave a live link on a moved or removed slot is
  **blocked** (1.1).
- **Entered results and RPE** (`training_load.session_feedback`): keyed by `(athlete_id, logical_session_id)`; the id
  is kept, so the result stays attached. A session with results is never removed by this path (blocked). Its content
  may change (the same as the edited athlete's own session today) — decision **Q5**.
- **Track / Request RPE**: kept unless changed in this edit (1.2).
- **The plan's owner snapshot** (`training_load.plan_workspace_ownership`): never touched.

## 3. Special members

Every member other than the edited one ends up in exactly one class:

| class | when | proposal |
|---|---|---|
| **apply** | nothing below | the change is applied |
| **diverged** | a session (or plan field) the coach changed was also changed for this athlete alone, or its slot is ambiguous / taken | **ask** (recommended); see Q1 |
| **blocked** | the change would remove a session with results, or move / remove a slot with a live calendar link | **ask**, never overwritten; see Q2 |
| **open edit draft** | an edit draft of this member exists (by this coach or another; `edit_source_plan_id`) | **ask**: applying under it would be undone when that draft is saved (`applyEditDraft` replaces the whole plan) |
| **archived athlete** | `public.athletes.is_active = false` (the create refuses them, `:436`) | **skipped and named**, not asked |
| **no rights** | `getEditablePlan`'s predicate (`:2763`) does not hold for the saving coach | **skipped and named**, not asked; no other detail about that plan |

**Q1 (diverged), three options:** (a) overwrite — loses what the coach tailored for that athlete, and a "diverged"
session can be one with results; (b) skip and say — silent loss of the change for that athlete except for one line;
(c) **ask** (recommended): one question, two or three buttons, nothing written until the coach answers. This is a
product question for the manager (or the owner, if it changes the product): the plan recommends (c) with **no
overwrite button** in the first version.

## 4. The outcome: all or nothing, and the coach's sentence

- **One request is all-or-nothing.** Either every chosen member and the edited plan are written in one COMMIT, or
  nothing is.
- **Save on an edit draft of a batch member asks first** (frontend): "Apply these changes to all N athletes?" —
  **[All athletes]** **[Only {name}]**. (This replaces step 1's sentence; there is no sticky checkbox for a published
  batch, because the choice is made per Save.)
- *Only {name}* = today's `applyEditDraft`, unchanged.
- *All athletes*: if every member is **apply** (or skipped), it is written and the answer says
  "Saved for N athletes." plus, when there are any, "Not changed: {names} (archived / not yours to edit)."
- If any member is **diverged**, **blocked** or has an **open edit draft**: `409 batch_members_need_choice`, nothing
  written, with one row per such member: the athlete's name and one plain reason word (`changed_separately`,
  `has_results`, `linked_to_event`, `being_edited`). The screen asks one question:
  "{k} athletes can't take these changes: {names and reasons}." — **[Apply to the other {m}]** **[Only {name}]**
  **[Cancel]**. *Apply to the other m* resends with `applyTo` = the exact member ids offered and the `choiceToken`
  the 409 returned (a hash of the classification); if anything changed in between, the server answers the 409 again
  instead of writing.

## 5. A lost answer on Save

The edit draft row is deleted in the COMMIT, so today a retry finds nothing and throws "Edit draft was already applied
or discarded." (a 500).

Proposal, **no migration**: the Save body carries a `requestKey`. A retry whose draft is gone answers
`409 edit_draft_already_applied` with the source plan id (after the same rights check), never a 500. The screen then
shows *Result not confirmed* · **Check result**, which reads the batch's plans again and shows them; it never resends.
A COMMIT whose answer is lost is verified on a new connection the F2 way (the draft row gone ⇒ written).

What this cannot say: **which** members a lost Save wrote. If the manager wants that exact replay, it needs a request
record (one append-only table, `requestKey` → outcome and member ids) — **a migration**, decision **Q6**.

## 6. Migration

**None for the core.** Everything is reads, the existing tables and the existing helpers: matching is by data already
stored (logical ids, slot keys), fingerprints are computed in the transaction, and the classification lives only in
the request. A migration is needed only if Q6 asks for an exact replay of a lost answer.

## 7. Tests (through the real routes, disposable databases)

Seeded: one coach, a weekly batch of three athletes, published.

1. Add a session in the edit → all three get it; the two others get **fresh** logical ids; the edited one keeps its
   own; nothing else of theirs changes (row ids of unchanged sessions identical).
2. Change a session's content → the others' matched sessions get the content with **their own** logical ids; a
   `session_feedback` row of athlete 2 on that session is still found by logical id.
3. Change Track / Request RPE on one session → propagated; a sibling whose Track was turned off alone and not changed
   in this edit keeps it off.
4. Remove a session athlete 2 has an RPE for → `409 batch_members_need_choice` (`has_results`), **nothing written**
   (all three plans and the draft byte for byte); then *Apply to the other 1* → athlete 3 and the edited one written,
   athlete 2 untouched.
5. A calendar event linked to athlete 3's slot; move that session → `linked_to_event`; an in-place content change
   keeps the link and the event read shows the new name.
6. Diverged: athlete 2's session edited alone before; the same session changed in the edit → `changed_separately`.
   A session the coach did **not** touch in this edit and athlete 2 tailored → untouched, not asked.
7. Open edit draft of athlete 3 (by another coach) → `being_edited`.
8. Archived athlete 3 → skipped and named; no rights on athlete 3 → skipped and named with no other detail.
9. `choiceToken` stale (athlete 2 gains an RPE between the 409 and the resend) → the 409 again, nothing written.
10. **Two concurrent Saves**: edit drafts of athletes 1 and 2 saved at once (barrier after the draft-row lock) →
    one commits, the other waits on the ascending lock and then sees the first's change: its member classification is
    computed against the new state (no lost update, no deadlock, no `40P01`).
11. **The same draft saved twice** (double click / retry) → one write; the second answers
    `edit_draft_already_applied`.
12. **Save racing an event attach** on athlete 2's session (both orders, with the existing `afterSessionLocks` test
    hook): attach first → Save sees the live link and keeps it (in-place change) or asks (move); Save first → the
    attach waits on the plan share lock and then finds the session by the **same** logical id. No `40P01` in either
    order.
13. Reopen of member B while A's Save holds B → the edit draft is copied **after** the Save, with A's change in it.
14. A lost COMMIT answer (a test seam) → verified as written; a retry → `edit_draft_already_applied`.
15. Mutations on: the logical-id map (fresh ids for changed sessions must fail test 2), the feedback check, the link
    check, the ascending order (source locked first must fail test 10 with a deadlock), the `FOR SHARE` in
    `/edit` (must fail test 13).

Plus the frontend: the Save question, the 409 question and its resend body, *Check result*, at 360 / 375 / 390 /
1280 in a browser; `code-reviewer`, `db-reviewer` (transactions, no schema), `security-reviewer` (the no-rights member
must not leak), `mobile-qa`, `ux-design-reviewer` (a changed flow); external review (triggers 3 and 4).

## 8. Out of scope

- **Program batches** (`planType: "program"` with several athletes, `:437`): they keep "only this athlete" (step 1's
  sentence) until a decision; their days have no weekday slot to match on.
- The draft batch sync (`syncBatchContentWithClient`): unchanged.
- No change to the calendar's tables, routes or rules.

## 9. Decisions for the manager

- **Q1** Diverged members: (c) ask, with no overwrite button in the first version (recommended), or (a) / (b).
- **Q2** A session with results the edit would remove, and a slot with a live calendar link the edit would move or
  remove: ask, never written (recommended).
- **Q3** Archived athletes and plans the coach may not change: skipped and named, not asked (recommended).
- **Q4** Fields three-way: a sibling keeps its own value unless the coach changed that field in this edit
  (recommended), or the edited athlete's values always win.
- **Q5** A session with results may change content in place for the others, as it can today for the edited athlete
  (recommended), or a session with results is never changed for the others.
- **Q6** A lost Save answer: "already applied" + *Check result*, no migration (recommended), or a request record for
  an exact replay (a migration).
- **Q7** Program batches stay "only this athlete" (recommended).

## 10. The manager's rulings and binding conditions (2026-11-19)

### 10.1 Rulings

- **Q1 (c):** a diverged member is **asked about**; there is **no overwrite button**.
- **Q2:** ask; a session with results and a slot with a live calendar link are **never written past**.
- **Q3:** archived athletes and plans the coach may not change are **skipped and named** (but see 10.2 for the name).
- **Q4:** fields **three-way** (1.2).
- **Q5:** a session with results may change **content in place** for the others, as it does today for the athlete on
  screen. A session with results is **never deleted or moved** (1.1 updated: a move is blocked by results as well as
  by a link).
- **Q6:** **no migration**; a retry after the draft is gone answers "already applied" and the screen offers
  *Check result*.
- **Q7:** program batches stay "this athlete only".

### 10.2 Binding conditions

1. **The "no rights" member.** Its athlete's name is shown **only** if the coach already sees it in the batch
   switcher, i.e. the member is in `loadBuilderBatch`'s answer for this draft (`builder.js:3073`); otherwise the
   member is **counted without a name** ("1 other athlete was not changed."). `security-reviewer` is mandatory, with a
   test of both cases.
   - Recorded fact: today `loadBuilderBatch` lists every active, non-edit-draft member of the batch with its name and
     has no rights filter, so in practice every member is named. The count-only path is what applies the moment that
     list is narrowed; its test builds that case through a seam rather than by changing the list's behaviour, which is
     out of scope.
2. **`choiceToken`.** A test that a change between the 409 and the resend — a new result, a new event link, another
   coach's edit draft, an archive — answers the 409 again and writes nothing.
3. **`POST /plans/:id/edit` with `FOR SHARE`.** A test of both orders against another coach's Save, and a **recorded
   SQL order** (the PR #346 rule in `.claude/rules/migrations.md`) proving there is no inversion with
   `lockBatchPlansForUpdate`: the edit route takes one live plan row `FOR SHARE` and nothing else before its copy;
   the Save takes the draft row, then the live rows ascending.
4. **The content fingerprint.** Two identical trees with different ids give the **same** fingerprint; a change of a
   dose, an order or an instruction gives a **different** one. An ambiguous slot (two sessions with one slot key in a
   plan) is **diverged**, never a guess.
5. **Races:**
   - two concurrent Saves on two members of the same batch;
   - a Save racing an event attach;
   - a Save racing an athlete's **RPE submit** on a session the edit removes: "blocked" must win in both orders, or
     show as `has_results`. How: before it reads `session_feedback`, the Save takes the sibling session rows it would
     remove or move `FOR UPDATE`, in ascending id, after the plan rows. The submit's insert into
     `training_load.session_feedback` takes `FOR KEY SHARE` on its `plan_session_id` row (the foreign key,
     `trainingLoad.js:462`). Submit first: the Save waits on that row and then reads the committed result, so the member
     is `has_results`. Save first: the submit's foreign-key check waits for the Save; if the Save had to block the
     member it removed nothing and the submit goes on; if the member was not blocked, the session was removed and the
     submit's insert fails on the foreign key. That failure is mapped to the submit route's existing "Training session
     not found." 404, never a 500. The submit never locks a plan row, so no cycle.
6. **Step 1's sentence** ("Changes go to this athlete only.") disappears **only when step 2 is live**: the Save question
   of section 4 replaces it in the same pull request as the server change, never earlier.

### 10.3 Delivery

Step 2 is built on `claude/builder-batch-edit-step2`, from `origin/main` after #653 (step 1) merges, or on top of
#653 if it has not merged yet. It is one ★★ package: `db-reviewer`, `security-reviewer`, `code-reviewer` (plus
`mobile-qa` and `ux-design-reviewer` for the Save question), the tests of section 7 and 10.2, and mutations. Its
frozen head goes to the *Nezavisni revizor*, then to the manager's gate.

## 11. As built (step 2, branch `claude/builder-batch-edit-step2`)

Where this differs from sections 1-10, this section records what the code does. Code: `backend/src/builderBatchEdit.js`
(tree load, id-free fingerprint, `planSiblingChange`, the sibling facts and writes) and `prepareBatchEdit` /
`applyEditDraft` in `backend/src/routes/builder.js`; screen: `renderBuilderBatchEditPanel` (`frontend/builder-view.js`)
and the `builder-batch-edit-*` actions (`frontend/builder-actions.js`).

- **The RPE submit race (10.2.5) needs no change to the RPE route.** `POST /api/training-load/sessions/:sessionId/rpe`
  locks the session row first: `backend/src/routes/trainingLoad.js` ~:345-363, the statement that ends
  `for update of ps` (at :363 on the merge base `d3943466`). So the Save, which locks the sibling session rows it would
  remove or move `FOR UPDATE` before it reads results, either waits for a submit and then sees its result
  (`has_results`), or makes the submit wait and the submit then finds the row gone and answers its existing 404. A
  foreign-key violation cannot occur, so no catch was added (the OptiMove manager's ruling). Both orders are tested
  through the real routes (step 2 test 13).
- **A move** carries a sibling's session only while it is still as before (content and fields); otherwise the member
  is asked about (`changed_separately`).
- **`has_results` is fail-closed over every recorded link** (the OptiMove manager's ruling of 2026-11-20, after the
  *Nezavisni revizor*'s observation on `5fd31143`). A sibling session is never removed or moved when anything recorded
  names its `logical_session_id` (`readSiblingFacts`, one statement, a `union` per kind):
  - the athlete's RPE: `training_load.session_feedback` (by athlete and logical id, as before);
  - an activity linked to it: `training.activity_participant_session_links` with `link_status` `confirmed` or
    `suggested`, whatever the participant's merge state. This covers an activity materialised for the planned session
    and an imported GPEXE activity merged with it: `training.merge_activity_participants` leaves the link row on the
    merged-away participant, so the link is not narrowed to canonical participants;
  - a metric event: `training_load.metric_event_participants.logical_session_id` (the event row
    `training_load.metric_events` has no logical id; the participant row carries it).

  A logical id belongs to one plan session, so the two link tables are matched by it alone, not by athlete. The reason
  stays `has_results`. Tests (step 2, each athlete without any RPE): 20 an activity materialised for the session
  (removal and move), 21 a metric event's participant, 22 an imported activity merged with the planned participant.
  Mutations: each branch dropped, and the activity links narrowed to canonical participants, each fail a test.
- **The edit route's `FOR SHARE` (10.2.3)** is the transaction's first statement; `builder-tree-batch-routes.test.mjs`
  test 4 asserts it (its mock client now knows that read).
- **The choice token** is compared whenever `applyTo` or `choiceToken` is sent, even if nobody is asked any more.
- **Rights first**, on the transaction's own connection (`getEditablePlan(req, id, client.query)`): a member the coach
  may not change is only `not_editable`, nothing more about it.
- **Names (10.2.1)** come from the same predicate as the switcher (`editablePlanAccessSql`, #664): a member the coach
  may not open is counted without a name.
- **409 `try_again`** for a lock wait that runs out or a deadlock (nothing written); **409 `source_changed`** when the
  source was saved after the edit draft was opened (the Save writes the source's `updated_at` with
  `clock_timestamp()`, so a draft opened while a Save waited is never newer than it); a failed read after the COMMIT
  answers 200 with what is known.
- **The screen:** "{name} is one of N athletes in this group" (N counts the hidden members); "Apply these changes to
  all M athletes (you can edit)?" (M the members the coach may open); one "won't get the changes" list with plain
  reasons; no group button when nobody else can take the change; *Not saved* / *Your changes may already be saved*
  after *Check result*, which only reads. With only the reopened plan visible there is no question: "Changes go to
  this athlete only." Program batches keep that sentence (Q7).
