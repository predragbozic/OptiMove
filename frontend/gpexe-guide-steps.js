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
  const imported = Boolean(list && list.some((c) => c.status === "imported"));
  const athletes = Array.isArray(f.sourceAthletes) ? f.sourceAthletes : null;
  const unlinked = athletes ? athletes.filter((a) => a.status === "unlinked").length : null;
  const linked = athletes ? athletes.filter((a) => a.status === "linked").length : 0;

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
    add(1, s1, unreadable ? (conn.status === "loading" || conn.status === "idle" ? "Checking..." : "Could not be checked.")
      : s1 === "done" ? "The GPEXE account is connected."
        : conn.reconnect ? "The GPEXE account needs to be connected again (Settings > Source connections > Reconnect)."
          : "Connect the club's GPEXE account (Settings > Source connections > Connect account).");
    add(2, s2, unreadable ? "" : s2 === "done" ? "This team is bound to its GPEXE team."
      : s2 === "next" ? "Test the connection, then approve and bind this team (Settings > Source connections). A platform administrator first approves the pair in Settings > Data sources."
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
  else if (unlinked === 0 && linked > 0) s4 = "done";
  else s4 = s3 === "done" ? "next" : "waiting";
  add(4, s4, s4 === "done" ? "Every GPEXE athlete is linked." : s4 === "unknown" ? "Could not be checked."
    : s4 === "next" ? `${unlinked} GPEXE ${unlinked === 1 ? "athlete is" : "athletes are"} not linked yet.` : "Waiting for step 3.",
  s4 === "next" ? { kind: "link", label: "Link athletes" } : null);

  // Step 5: import - a status for everyone; the approval is the existing button.
  let s5;
  if (imported) s5 = "done";
  else if (list === null) s5 = "unknown";
  else s5 = s4 === "done" ? "next" : "waiting";
  const off = f.teamSwitch && f.teamSwitch.enabled === false;
  add(5, s5, s5 === "done" ? "At least one session has been imported."
    : s5 === "unknown" ? "Could not be checked."
      : s5 === "next" ? (off ? "Importing is switched off for this team. An administrator switches it on first." : "Review the sessions below and import them.")
        : "Waiting for step 4.");

  // The variables line (administrators): done when every system variable of the list is on.
  let variables = null;
  if (f.admin && f.vars) {
    const v = f.vars;
    const state = v.status === "error" ? "unknown" : v.status !== "ready" ? "waiting" : v.total === 0 ? "done" : "next";
    variables = { state, total: v.total ?? 0, onCount: v.onCount ?? 0, canSwitchOn: v.status === "ready" && v.total > 0 && s2 === "done" };
  }
  const allDone = steps.every((s) => s.state === "done") && (!variables || variables.state === "done");
  return { steps, variables, allDone };
}
