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
does not clear, or any lost answer — *Result not confirmed*; *Read current state* shows only what
the server holds now and never confirms the lost request, so do not acknowledge the uncertainty
without reporting first), stop there and report the
screen's sentence and the code from *Technical details*; nothing else is retried.
