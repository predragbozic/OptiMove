// U4 (J19): the five-step setup guide of the Imports screen - pure rules, no
// DOM and no requests. Every state is read from facts the screen already holds
// (the connection list for administrators, the team status, the last check,
// the candidates, the source-athletes list, the team's import switch). A read
// that failed is "unknown" and is never counted as done.
export const GUIDE_STEP_TITLES = ["Connect the GPEXE account", "Approve and bind the team", "Find sessions", "Link athletes", "Import"];

// facts: { admin, conn: { status, connected, reconnect, bound }, check, candidates,
//          sourceAthletes, sourceAthletesError, links, teamSwitch, importSwitchOn, vars }
//   conn.status: idle | loading | ready | error | unavailable
//   vars: { status, total, onCount } or null
export function guideSteps(f) {
  const steps = [];
  const conn = f.conn || { status: "idle" };
  const add = (id, state, text, action = null) => steps.push({ id, title: GUIDE_STEP_TITLES[id - 1], state, text, action });
  const checkDone = f.check?.status === "succeeded";
  const running = f.check?.status === "running";
  const list = Array.isArray(f.candidates) ? f.candidates : null;
  const imported = Boolean(list && list.some((c) => c.status === "imported" && !c.importUndoneAt));
  const athletes = Array.isArray(f.sourceAthletes) ? f.sourceAthletes : null;
  const unlinked = athletes ? athletes.filter((a) => a.status === "unlinked").length : null;
  const linked = athletes ? athletes.filter((a) => a.status === "linked").length : 0;
  // U6a: a session that still lists an athlete as not linked (no_linked_athlete, athletes_not_linked) is a fact the athletes list can miss
  // (it is read separately and can be older or empty); linking is never "done" while one is open.
  const sessionsUnlinked = list ? list.filter((c) => !c.importUndoneAt && c.status !== "imported" && c.status !== "superseded" && (c.reasons || []).some((r) => r.code === "no_linked_athlete" || r.code === "athletes_not_linked")).length : 0;

  // Steps 1 and 2: the administrator's work. A coach gets one sentence.
  let s1;
  let s2;
  if (f.admin) {
    if (conn.status === "error" || conn.status === "unavailable") {
      s1 = "unknown"; s2 = "unknown";
    } else if (conn.status !== "ready") {
      s1 = "unknown"; s2 = "unknown";
    } else {
      s1 = conn.connected || conn.bound ? "done" : "next";
      s2 = conn.bound ? "done" : s1 === "done" ? "next" : "waiting";
    }
    const unreadable = conn.status === "error" || conn.status === "unavailable" || conn.status === "idle" || conn.status === "loading";
    const failed = conn.status === "error" || conn.status === "unavailable";
    add(1, s1, unreadable ? (failed ? "Could not be checked." : "Checking...")
      : s1 === "done" ? "The GPEXE account is connected."
        : conn.reconnect ? "The GPEXE account needs to be connected again (Settings > Source connections > Reconnect)."
          : "Connect the club's GPEXE account (Settings > Source connections > Connect account).",
    failed ? { kind: "retry", label: "Try again" } : null);
    add(2, s2, unreadable ? (failed ? "Could not be checked - see step 1." : "") : s2 === "done" ? "This team is bound to its GPEXE team."
      : s2 === "next" ? "A platform administrator approves this team's GPEXE team in Settings > Data sources. Then test the connection and bind the team in Settings > Source connections."
        : "Waiting for step 1.");
  } else {
    const evidence = checkDone || running || Boolean(list && list.length);
    const state = evidence ? "done" : "waiting";
    steps.push({ id: 1, title: "Connect and approve", state, text: evidence ? "An administrator has connected the GPEXE account and approved this team." : "An administrator connects the GPEXE account and approves this team.", action: null, merged: true });
    s1 = state; s2 = state;
  }

  // Step 3: find sessions. The administrator runs it; a coach sees the state.
  const ready12 = f.admin ? s2 === "done" : s2 === "done";
  let s3;
  if (checkDone) s3 = "done";
  else if (running) s3 = "running";
  else s3 = ready12 ? "next" : "waiting";
  add(3, s3, s3 === "done" ? "Sessions have been found." : s3 === "running" ? "Finding sessions..." : s3 === "next"
    ? (f.admin ? "Find the sessions of the last days in GPEXE." : "An administrator finds the sessions in GPEXE.") : "Waiting for steps 1 and 2.",
  s3 === "next" && f.admin ? { kind: "check", label: "Find new sessions" } : null);

  // Step 4: link athletes (the coach and the administrators).
  let s4;
  if (f.sourceAthletesError || unlinked === null) s4 = s3 === "done" ? "unknown" : "waiting";
  else if (unlinked === 0 && sessionsUnlinked > 0) s4 = s3 === "done" ? "next" : "waiting";
  else if (unlinked === 0 && linked > 0) s4 = "done";
  else if (unlinked === 0) s4 = "waiting";
  else s4 = s3 === "done" ? "next" : "waiting";
  add(4, s4, s4 === "done" ? "Every GPEXE athlete is linked." : s4 === "unknown" ? "Could not be checked."
    : unlinked === 0 && sessionsUnlinked > 0 ? `Every athlete is linked now, but ${sessionsUnlinked} ${sessionsUnlinked === 1 ? "session was" : "sessions were"} reviewed before that. ${f.admin ? "Find new sessions to refresh them." : "An administrator finds new sessions to refresh them."}`
    : unlinked === 0 ? "No GPEXE athlete has been seen yet. Find sessions first."
    : s4 === "next" ? `${unlinked} GPEXE ${unlinked === 1 ? "athlete is" : "athletes are"} not linked yet.` : "Waiting for step 3.",
  s4 === "next" && unlinked > 0 ? { kind: "link", label: "Link athletes" }
    : s4 === "next" && f.admin ? { kind: "check", label: "Find new sessions" } : null);

  // Step 5: import - a status for everyone; the approval is the existing button.
  let s5;
  if (imported) s5 = "done";
  else if (list === null) s5 = "unknown";
  else s5 = s4 === "done" ? "next" : "waiting";
  const off = f.teamSwitch && f.teamSwitch.enabled === false;
  add(5, s5, s5 === "done" ? "At least one session has been imported."
    : s5 === "unknown" ? "Could not be checked."
      : s5 === "next" ? (off ? "Importing is switched off for this team. An administrator switches it on first." : "Review the sessions below and import them.")
        : "Link athletes first for the sessions that need it. Sessions that are already ready can be imported below.");

  // The variables line (administrators): done when every system variable of the list is on.
  let variables = null;
  if (f.admin) {
    const v = f.vars || { status: "idle", total: 0, onCount: 0 };
    const skipped = Array.isArray(f.skipped) ? f.skipped : [];
    let state;
    if (conn.status === "error" || conn.status === "unavailable" || v.status === "error") state = "unknown";
    else if (v.status !== "ready") state = "waiting";
    else if (v.total > 0) state = "next";
    else if (skipped.length) state = "attention";
    else if (v.onCount > 0) state = "done";
    else state = "none";
    variables = { state, total: v.total ?? 0, onCount: v.onCount ?? 0, skipped, canSwitchOn: v.status === "ready" && v.total > 0 && s2 === "done" };
  }
  const allDone = steps.every((s) => s.state === "done") && (!variables || variables.state === "done");
  return { steps, variables, allDone };
}
