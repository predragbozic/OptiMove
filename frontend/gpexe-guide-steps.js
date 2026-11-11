// U4 (J19), U6b: the setup stepper of the Imports screen - pure rules, no DOM
// and no requests. The steps follow the agreed "GPS Import Flow" sketch:
// Connect GPEXE -> Choose team -> Variables -> Athletes -> Ready. Every state
// is read from facts the screen already holds (the connection list and the
// variables for administrators, the team status, the last check, the
// candidates, the source-athletes list, the suggested pairs, the team's import
// switch). A read that failed is "unknown" and is never counted as done.
export const GUIDE_STEP_TITLES = ["Connect GPEXE", "Choose team", "Variables", "Athletes", "Ready"];

// facts: { admin, conn: { status, connected, reconnect, bound }, check, candidates,
//          sourceAthletes, sourceAthletesError, links, teamSwitch, vars, skipped,
//          suggestions: { status, data }, identityLoad, teamName, switchData }
//   conn.status: idle | loading | ready | error | unavailable
//   vars: { status, total, onCount } or null
//   switchData: the import switch read with its conditions (administrators) or null
export function guideSteps(f) {
  const steps = [];
  const conn = f.conn || { status: "idle" };
  const add = (id, state, text, action = null, extra = {}) => steps.push({ id, title: GUIDE_STEP_TITLES[id - 1], state, text, action, ...extra });
  const checkDone = f.check?.status === "succeeded";
  const running = f.check?.status === "running";
  const list = Array.isArray(f.candidates) ? f.candidates : null;
  const imported = Boolean(list && list.some((c) => c.status === "imported" && !c.importUndoneAt));
  const athletes = Array.isArray(f.sourceAthletes) ? f.sourceAthletes : null;
  const unlinked = athletes ? athletes.filter((a) => a.status === "unlinked").length : null;
  const linked = athletes ? athletes.filter((a) => a.status === "linked").length : 0;
  // U6a-2: a session that still lists an athlete as not linked is a fact the athletes list can miss (it is read separately
  // and can be older); linking is never "done" while one is open. Such a session is fixed in its own review (J20).
  const sessionsUnlinked = list ? list.filter((c) => !c.importUndoneAt && c.status !== "imported" && c.status !== "superseded" && (c.reasons || []).some((r) => r.code === "no_linked_athlete" || r.code === "athletes_not_linked")).length : 0;

  // Steps 1-3: the administrator's work. A coach gets one merged row.
  let s1;
  let s2;
  let variables = null;
  if (f.admin) {
    const unreadable = conn.status === "error" || conn.status === "unavailable" || conn.status === "idle" || conn.status === "loading";
    const failed = conn.status === "error" || conn.status === "unavailable";
    if (unreadable) {
      s1 = "unknown"; s2 = "unknown";
    } else {
      s1 = conn.connected || conn.bound ? "done" : "next";
      s2 = conn.bound ? "done" : s1 === "done" ? "next" : "waiting";
    }
    add(1, s1, unreadable ? (failed ? "Could not be checked." : "Checking...")
      : s1 === "done" ? "The GPEXE account is connected."
        : conn.reconnect ? "The GPEXE account needs to be connected again (Settings > Source connections > Reconnect)."
          : "Connect the club's GPEXE account (Settings > Source connections > Connect account).",
    failed ? { kind: "retry", label: "Try again" } : null);
    add(2, s2, unreadable ? (failed ? "Could not be checked - see step 1." : "") : s2 === "done" ? "This team is bound to its GPEXE team."
      : s2 === "next" ? "A platform administrator approves this team's GPEXE team in Settings > Data sources. Then test the connection and bind the team in Settings > Source connections."
        : "Waiting for step 1.");

    // Step 3: the variables (switching on the OptiMove GPEXE set; "Choose my own" is the Mappings screen).
    const v = f.vars || { status: "idle", total: 0, onCount: 0 };
    const skipped = Array.isArray(f.skipped) ? f.skipped : [];
    let state;
    if (failed || v.status === "error") state = "unknown";
    else if (s2 !== "done") state = "waiting";
    else if (v.status !== "ready") state = "waiting";
    else if (v.total > 0) state = "next";
    else if (skipped.length) state = "attention";
    else if (v.onCount > 0) state = "done";
    else state = "none";
    variables = { state, total: v.total ?? 0, onCount: v.onCount ?? 0, skipped, canSwitchOn: v.status === "ready" && v.total > 0 && s2 === "done" };
    add(3, state, "", null, { variables });
  } else {
    const evidence = checkDone || running || Boolean(list && list.length);
    const state = evidence ? "done" : "waiting";
    steps.push({ id: 1, title: "Connect, team and variables", state, text: evidence ? "An administrator has connected GPEXE, chosen this team and its variables." : "An administrator connects GPEXE, chooses this team and its variables.", action: null, merged: true });
    s1 = state; s2 = state;
  }
  const setupDone = f.admin ? s2 === "done" : s2 === "done";

  // Step 4: athletes. OptiMove sees the GPEXE athletes only after a first search, so the search is this step's first action.
  let s4;
  let text4;
  let action4 = null;
  const pairs = athleteSuggestions(f, unlinked);
  if (!checkDone) {
    s4 = running ? "running" : setupDone ? "next" : "waiting";
    text4 = running ? "Finding sessions..."
      : !setupDone ? (f.admin ? "Waiting for steps 1 and 2." : "Waiting for the administrator.")
        : f.admin ? "Find the sessions of the last days first: OptiMove sees the GPEXE athletes from them."
          : "An administrator finds the sessions in GPEXE first.";
    if (s4 === "next" && f.admin) action4 = { kind: "check", label: "Find new sessions" };
  } else {
    if (f.sourceAthletesError || unlinked === null) s4 = "unknown";
    else if (unlinked === 0 && sessionsUnlinked > 0) s4 = "next";
    else if (unlinked === 0 && linked > 0) s4 = "done";
    else if (unlinked === 0) s4 = "waiting";
    else s4 = "next";
    text4 = s4 === "done" ? "Every GPEXE athlete is linked." : s4 === "unknown" ? "Could not be checked."
      : unlinked === 0 && sessionsUnlinked > 0 ? `${sessionsUnlinked === 1 ? "1 session still has" : `${sessionsUnlinked} sessions still have`} athletes that are not linked. Open ${sessionsUnlinked === 1 ? "it" : "them"} under "Athletes not linked" below and link them from their rows.`
        : unlinked === 0 ? "No GPEXE athlete has been seen yet. Find sessions first."
          : `${unlinked} GPEXE ${unlinked === 1 ? "athlete is" : "athletes are"} not linked yet.`;
    if (s4 === "next" && unlinked > 0) action4 = pairs.exact > 0 ? { kind: "link", label: `Confirm ${pairs.exact} ${pairs.exact === 1 ? "match" : "matches"}` } : { kind: "link", label: "Link athletes" };
  }
  add(4, s4, text4, action4, { pairs: checkDone && s4 === "next" && unlinked > 0 ? pairs : null });

  // Step 5: ready - a checklist; done once a session has been imported (the import itself is the existing button below).
  const sw = f.teamSwitch;
  const switchOn = sw ? sw.enabled === true : null;
  const team = (f.teamName || "").trim() || "this team";
  const check = [];
  if (f.admin) {
    check.push({ id: "connect", ok: s1 === "done", text: "GPEXE account connected" });
    check.push({ id: "team", ok: s2 === "done", text: "Team bound to its GPEXE team" });
    check.push({ id: "variables", ok: variables.state === "done", text: "OptiMove variables switched on" });
  } else {
    check.push({ id: "setup", ok: s2 === "done", text: "GPEXE set up by an administrator" });
  }
  check.push({ id: "athletes", ok: s4 === "done", text: "Every GPEXE athlete linked" });
  check.push({ id: "switch", ok: switchOn === true, text: switchOn === false ? `Import off for ${team}` : `Import on for ${team}` });
  const backup = backupLine(f.switchData);
  if (backup) check.push(backup);
  check.push({ id: "imported", ok: imported, text: imported ? "A session has been imported" : "Import your first session below" });
  let s5;
  if (imported) s5 = "done";
  else if (list === null) s5 = "unknown";
  else s5 = s4 === "done" ? "next" : "waiting";
  const off = switchOn === false;
  add(5, s5, s5 === "done" ? "At least one session has been imported."
    : s5 === "unknown" ? "Could not be checked."
      : s5 === "next" ? (off ? "Importing is switched off for this team. An administrator switches it on first." : "Review the sessions below and import them.")
        : "Link athletes first for the sessions that need it. Sessions that are already ready can be imported below.", null, { checklist: check });

  const allDone = steps.every((s) => s.state === "done");
  return { steps, variables, allDone };
}

// S6: the suggested pairs by name and date of birth (U3), counted against the athletes still unlinked.
// "names": names were never loaded, so no pair can be suggested yet; the server decides who may load them.
function athleteSuggestions(f, unlinked) {
  const sug = f.suggestions;
  const data = sug?.status === "ready" ? sug.data : null;
  const open = new Set((Array.isArray(f.sourceAthletes) ? f.sourceAthletes : []).filter((a) => a.status === "unlinked").map((a) => String(a.gpexeAthleteId)));
  const exact = data ? data.exact.filter((p) => open.has(String(p.gpexeAthleteId))).length : 0;
  const choice = unlinked === null ? 0 : Math.max(0, unlinked - exact);
  return {
    status: sug?.status || "idle",
    exact,
    choice,
    namesMissing: Boolean(data && data.state !== "ok"),
    canLoadNames: f.identityLoad === true,
  };
}

// The backup line of the checklist: only from the recorded dates an administrator reads (never claimed otherwise).
function backupLine(data) {
  const c = Array.isArray(data?.conditions) ? data.conditions.find((x) => x.kind === "backup") : null;
  if (!c) return null;
  const when = c.recordedOn ? c.recordedOn.split("-").reverse().join(".") : null;
  return { id: "backup", ok: c.met === true, text: c.met === true ? `Backup recorded on ${when}` : when ? `Backup is older than ${c.maxAgeDays} days (recorded on ${when})` : "No backup recorded" };
}
