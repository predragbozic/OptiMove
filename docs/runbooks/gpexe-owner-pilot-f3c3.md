# Owner-run read-only pilot through the deployed UI (after PR A, F3c3)

The first real GPEXE connection, binding and check in production are made by the owner alone,
through the deployed Settings screen, after PR A is merged, deployed and smoke-checked. The main
session prepares this procedure and never runs it. **The credential never goes through chat, a
terminal, a screenshot or a log** — it is typed into the Connect form only.

Preconditions (checked by the owner before step 1):

- `/api/health` serves the merge commit of PR A with `ok: true`.
- Signed in as a platform admin, in the platform workspace or in the club's workspace; or as the
  club's admin in the club's workspace.
- `GPEXE_IMPORT_APPLY_ENABLED` is off and stays off; nothing is approved during the pilot.
- Team ID 980 is the approved pair of the OptiMove team under Settings → Data sources (set earlier
  by a platform admin, F3b). If it is not, set it there first — before any binding.

The steps:

1. **Settings → Source connections.** Platform workspace: choose the club. Expected: "has no GPEXE
   connection yet" and *Create connection*.
2. **Create connection** — host profile `GPEXE server3`, an account label such as
   "Club GPEXE account". Expected: the Connect form opens on the new row.
   **STOP rule for Create:** if Create shows *Result not confirmed*, do **not** choose
   *Acknowledge uncertainty and continue*, do **not** create a new connection and do **not**
   continue the pilot. The pilot stops there and the result is reported (the screen's sentence and
   the code from *Technical details*). The create route has no idempotency key yet, so a second
   Create after a lost answer could leave a duplicate connection that cannot be removed from the
   screen; stopping here means the first real pilot cannot make one.
3. **Connect** — type the GPEXE username and password into the form, press *Connect* once. OptiMove
   does not retain the pair after the request, but your browser or password manager may offer to
   fill or save it according to its own settings: if it offers a saved OptiMove password, decline
   it and type the GPEXE password yourself; if it offers to save the pair afterwards, decline.
   Before pressing *Connect*, check that both fields hold the GPEXE account's username and
   password, not your OptiMove sign-in; if the browser filled either field, clear both and type the
   GPEXE username and password yourself. Type the password; do not
   paste it from a note or a chat (a clipboard history such as Win+V keeps it) — if you must paste,
   clear the clipboard history afterwards. A private window without extensions is the simplest
   setting.
   Expected: badge *Verified*, "The connection is verified", the GPEXE teams the account sees
   listed (a platform admin: all of them, Team ID 980 marked "Approved for <team>"; a club admin:
   the approved intersection). If GPEXE refuses the pair on this first Connect: the badge **stays
   *Not connected*** and the Connect form stays open with "GPEXE refused this username and
   password. Nothing was stored; check them and try once more" — nothing is stored, and each
   press of *Connect* counts toward 5 attempts in 15 minutes, after which the screen says to wait.
   If the exchange succeeded but the check read did not (badge *Connected, not tested*): the
   token is stored — press *Test connection*, do not Reconnect.
4. **Test connection** once. Expected: still *Verified*, "The last test … succeeded".
5. **Bind** on the row of GPEXE team 980. Expected: the review names GPEXE, `GPEXE server3`, the
   club, the OptiMove team and `980 · <name>`. *Confirm binding*. Expected: "<team> now reads from
   GPEXE team 980", the team under *Bound teams* with *Unbind*.
6. **One read-only check** — Training Load → Imports as the team's coach (or the owner's own coach
   view of that team): *Find new sessions* for a small window (one to three days with a known
   session). Expected: the check runs through the connection; the server log line names
   `source_connection` with the connection and binding ids; sessions found appear as candidates in
   the inbox (review only — the switch is off, nothing is written to results).
7. **Read back, change nothing:** the check row (`source_path = 'source_connection'`, the
   connection, binding, source team and host key), the check result (sessions seen, candidates),
   the candidates' sessions, athletes and drills (a session's drill set complete; an empty drill is
   a valid empty drill). If a check fails with a connection code, the coach sees "contact an
   administrator" and the administrator sees the precise code on the status.
8. **Stop.** `GPEXE_IMPORT_APPLY_ENABLED` stays unchanged; no candidate is approved; no Unbind, no
   Reconnect, no second connection. Report: the connection state, the number of bound teams (1),
   the check id and its counts — never the credential, never a token.

If anything stops the pilot (a refused credential after a verified Connect, a `try_again` that
does not clear, or any lost answer — *Result not confirmed*), stop there and report the screen's
sentence and the code from *Technical details*; nothing else is retried. *Read current state* may
be used to look, but it shows only what the server holds now and never confirms the lost request.
During the pilot *Acknowledge uncertainty and continue* is never chosen, and nothing is created,
connected, reconnected, tested or bound again after a lost answer; for a lost Create this is the
STOP rule of step 2.

## After a failed check: read its code, then (only on a separate order) re-test one known date

The first pilot (2026-10-05) stopped on a check that ended *failed*. The sentence "Import writing is
switched off in this environment…" under the source card's *Technical details* is the import
switch's state, not the check's reason: a check never consults the switch, only approving does.

1. **Read the check's own code — sends nothing to GPEXE.** Training Load → Imports, the bound team.
   In the red box "The last search (…) did not finish", open *Technical details* and read **Code**
   and **Server message**. Once the fix PR for these details is deployed, the source card's own
   *Technical details* also shows them as *Last check code* / *Last check message*, next to
   *Last check status*. Report only the code and that sentence. Do not press *Find new sessions*.
2. **Re-test only on a separate, explicit order**, after the cause of that code is understood (and,
   if it is a code defect, after its fix is merged and deployed). Before it, look only: Settings →
   Source connections shows *Verified* and the team bound to GPEXE Team ID 980. If it shows anything
   else (for example *Needs reconnect*), stop and report the badge and the last problem shown; no
   re-test.
3. Training Load → Imports, the bound team → *Choose dates*: set **From** and **To** to the **same
   single date** on which exactly one GPEXE session of team 980 is known to exist (not in the
   future). Press *Find new sessions* **once** and wait until *Finding…* ends.
4. Report only: the result line ("Sessions found … · N sessions in GPEXE: a not seen by OptiMove
   before, b changed, c unchanged"), or — if it failed — the **Code** from the red box. Nothing is
   approved or imported; `GPEXE_IMPORT_APPLY_ENABLED` stays unchanged.
5. A failed or unknown result is not repeated: stop and report the code. No Reconnect, Unbind or
   second check without a new order.

## The diagnostic read for `source_answer_unexpected` (whole-session details)

The first check's code was `source_answer_unexpected` ("The source answer to the whole-session
details carries a metric value in an unknown shape."). The real shape of those metric values is
not documented anywhere in the repository, so the acceptance rule is not widened. Instead the
refusal now carries a sanitized description after " Diagnostic: " in its message. It holds only
kinds, booleans and count buckets, and no name except `tot_burst_events` / `tot_brake_events`.
It holds no athlete id, value, text or date.

1. **Only after the external review of branch `fix/gpexe-session-details-metric-shape`, its merge
   and its deploy, and on a separate, explicit order.** Look first: Settings → Source connections
   shows *Verified* with the team bound to GPEXE Team ID 980; anything else, stop and report.
2. One check for one known date, exactly as steps 3 and 4 above: From = To = one date with exactly
   one known session of team 980, *Find new sessions* once.
3. If it fails with `source_answer_unexpected` (whole session) or `drill_set_incomplete` (a drill),
   the source card's *Technical details* → *Last check message* (as an administrator) holds the
   sentence and then `Diagnostic: …` (for a drill: `drill_index=…; drill_code=…; op=…`). Return
   **that whole line** and the Code. Nothing else from the screen is needed. No screenshot is
   needed either, and never one of a form.
4. If it succeeds, report the result line instead. Nothing is approved or imported, and the switch
   stays off.
5. Nothing is repeated. A parser change follows only for the shape that line proves, in a new PR
   with its own review, and then one more single-date re-test.

## Re-test after the whole-session projection (one known date)

The diagnostic of 2026-10-06 proved both consumed fields (`tot_burst_events`, `tot_brake_events`)
in the documented shape. The one refused metric is not consumed. Branch
`fix/gpexe-session-details-projection` therefore projects the whole-session read to those two
fields. The drill answers keep the full check.

1. **Only after the external review of that branch, its merge and deploy, and on a separate order.**
   Look first: Settings → Source connections shows *Verified* with the team bound to GPEXE Team ID
   980. If it shows anything else, stop and report.
2. Training Load → Imports, the bound team → *Choose dates*: **From = To = the same known date** as
   the last re-test. Press *Find new sessions* **once** and wait until *Finding…* ends.
3. **If it succeeds**, report only the result line ("Sessions found … · N sessions in GPEXE: a not
   seen by OptiMove before, b changed, c unchanged"). Do not open Import. Nothing is approved, linked
   or imported, and `GPEXE_IMPORT_APPLY_ENABLED` stays unchanged.
4. **If it fails**, report only the Code and the whole `Diagnostic: …` line from *Technical details →
   Last check message*. A drill refusal reads `drill_set_incomplete` with
   `drill_index=…; drill_code=…; op=session_drill_details; …`.
5. **Nothing is repeated.** No Link athletes, no Import, no second check without a new order.

## Reviewing the first found session (read-only)

The re-test of 2026-10-06 found one session (05.10.2026) and stored it for review. Everything below
reads data OptiMove already stored: no GPEXE request and no write. Stop at any step that does not
look as described. **Report only the row's sentence, a count or an error Code, as text.** Never paste
or screenshot the review or the Link athletes screen (they show athlete names, ids and values), and
never put an athlete's id, name or value into chat. **Press nothing but what a step names:** no
*Find new sessions*, *Link...*, *Confirm link*, *Unlink*, *Review N links*, *Link N athletes*,
checkbox or Import.

1. Training Load → Imports, the bound team. **Reload the browser page** (F5) first: the screen does
   not re-read the Link athletes list after a check, and only a reload shows the athletes found by
   the re-test. **Do not press** *Find new sessions* — at no step below.
2. Check that the button reads **Link athletes (N)** with a number. If it reads *Link athletes*
   without one, stop and report.
3. In **Needs attention (1)**, read the row's sentence. Expected: "No linked athlete in this session
   yet - link the athletes under Link athletes (below), then find new sessions." Report it if it is
   another one.
4. Click the session row to open its review. Expected while nobody is linked: the badge *Up to
   date* and "Nothing new to import - no action needed." (misleading here, a known follow-up; ignore
   it). Expand an athlete row to see "This GPEXE athlete is not linked to an OptiMove athlete of the
   team", its GPS status and its values; the team's athletes without a GPEXE record are listed too.
   **Do not press** *Link...*. Close it with ×.
5. Click **Link athletes (N)**. Read the summary line ("X linked · Y not linked"); groups without
   athletes have no heading. Each GPEXE athlete is shown by its id with Time, Distance, Top speed
   and Drills of 05.10.2026; nothing is preselected. If the screen says "No GPEXE athlete has been
   seen yet. Find new sessions first.", **stop and report — do not follow it**. **Do not choose**
   anyone and **do not press** *Review N links* or *Link N athletes*. Close it with *Close*.
6. Read-only comparison: open GPEXE's own view of the same session and compare Time / Distance / Top
   speed for two or three athletes with OptiMove's values. Report only whether they match (yes / no,
   and if no, roughly by what factor). No value, name or id goes into chat.
7. Report: the row's sentence, the summary line's counts, and the result of step 6.

**Before any athlete link is written** — from the Link athletes screen or from a session's review — on
a separate order: the owner runs, read-only and themselves, the count recorded on 2026-09-24 against
the deployed `gpexe_athlete_links` (`select count(*) from training_load.gpexe_athlete_links where
gpexe_athlete_id !~ '^(0|[1-9][0-9]{0,11})$'`, expected 0) and reports only the number — no connection
string and no rows in chat; and step 6 shows that the values match.
If they do not match, a code fix of the server3 units comes first. After any link, the stored review
is out of date until a new check (a GPEXE request, its own order) has seen the session.
