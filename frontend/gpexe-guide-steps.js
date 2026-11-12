// U4 (J19), U6b: the setup stepper of the Imports screen - pure rules, no DOM
// and no requests. The steps follow the agreed "GPS Import Flow" sketch:
// Connect GPEXE -> Choose team -> Variables -> Athletes -> Ready. Every state
// is read from facts the screen already holds (the connection list and the
// variables for administrators, the team status, the last check, the
// candidates, the source-athletes list, the suggested pairs, the team's import
// switch). A read that failed is "unknown" and is never counted as done.
export const GUIDE_STEP_TITLES = ["Connect GPEXE", "Choose team", "Variables", "Athletes", "Ready"];

// Evidence that a search already happened: a succeeded check, an athlete linked or seen, or a session seen. One rule
// for every place that asks (the steps and the pair counts): a later failed or running search never undoes it.
export function searchEvidence({ check, sourceAthletes, candidates }) {
  const athletes = Array.isArray(sourceAthletes) ? sourceAthletes : null;
  return check?.status === "succeeded" || Boolean(athletes && athletes.length) || Boolean(Array.isArray(candidates) && candidates.length);
}

// facts: { admin, conn: { status, connected, reconnect, bound }, check, candidates,
//          sourceAthletes, sourceAthletesError, links, teamSwitch, vars, skipped,
//          pairs: { exact, namesMissing } or null, identityLoad, teamName, switchData }
//   conn.status: idle | loading | ready | error | unavailable
//   vars: { status, total, onCount } or null
//   switchData: the import switch read with its conditions (administrators) or null
export function guideSteps(f) {
  const steps = [];
  const conn = f.conn || { status: "idle" };
  const team = (f.teamName || "").trim() || "this team";
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
    const settings = { kind: "settings", label: "Open Source connections" };
    add(1, s1, unreadable ? (failed ? "Could not be checked." : "Checking...")
      : s1 === "done" ? "The GPEXE account is connected."
        : conn.reconnect ? "The GPEXE account needs to be connected again: open Source connections and choose Reconnect."
          : "Connect the club's GPEXE account: open Source connections and choose Connect account.",
    failed ? { kind: "retry", label: "Try again" } : s1 === "next" ? settings : null);
    add(2, s2, unreadable ? (failed ? "Could not be checked - see step 1." : "") : s2 === "done" ? `${team} uses its GPEXE team.`
      : s2 === "next" ? `Choose the GPEXE team for ${team}: open Source connections, test the connection, approve the GPEXE team and bind it.`
        : "Waiting for step 1.",
    s2 === "next" ? settings : null);

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
    const evidence = running || searchEvidence(f);
    const state = evidence ? "done" : "waiting";
    steps.push({ id: 1, title: "Connect, team and variables", state, text: evidence ? "An administrator has connected GPEXE for this team." : "An administrator connects GPEXE for this team and chooses its variables.", action: null, merged: true });
    s1 = state; s2 = state;
  }
  const setupDone = f.admin ? s2 === "done" : s2 === "done";

  // Step 4: athletes. OptiMove sees the GPEXE athletes only after a first search, so the search is this step's first action.
  let s4;
  let text4;
  let action4 = null;
  const pairs = athleteSuggestions(f, unlinked);
  // Evidence that a search already happened: a succeeded check, athletes or sessions seen. A later failed or running
  // search never undoes what is already linked (code review of U6b).
  const searched = searchEvidence(f);
  const find = { kind: "check", label: "Find new sessions" };
  if (!searched) {
    s4 = running ? "running" : setupDone ? "next" : "waiting";
    text4 = running ? "Finding sessions..."
      : !setupDone ? (f.admin ? "Waiting for steps 1 and 2." : "Waiting for the administrator.")
        : "Find the sessions of the last days first: OptiMove sees the GPEXE athletes from them.";
    // The server lets the team's coach search too (the same team access as the reads).
    if (s4 === "next") action4 = find;
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
    // No athlete seen yet: the instruction comes with its button.
    if (s4 === "waiting" && setupDone && !running) action4 = find;
  }
  add(4, s4, text4, action4, { pairs: s4 === "next" && unlinked > 0 ? pairs : null });

  // Step 5: ready - a checklist; done once a session has been imported (the import itself is the existing button below).
  const sw = f.teamSwitch;
  const switchOn = sw ? sw.enabled === true : null;
  const check = [];
  if (f.admin) {
    check.push({ id: "connect", ok: s1 === "done", text: "GPEXE account connected" });
    check.push({ id: "team", ok: s2 === "done", text: `GPEXE team chosen for ${team}` });
    check.push({ id: "variables", ok: variables.state === "done", text: "OptiMove variables switched on" });
  } else {
    check.push({ id: "setup", ok: s2 === "done", text: "GPEXE connected by an administrator" });
  }
  check.push({ id: "athletes", ok: s4 === "done", text: "Every GPEXE athlete linked" });
  check.push({ id: "switch", ok: switchOn === true, text: switchOn === false ? `Import off for ${team}` : `Import on for ${team}` });
  const backup = backupLine(f.switchData, switchOn);
  if (backup) check.push(backup);
  check.push({ id: "imported", ok: imported, text: imported ? "A session has been imported" : "No session imported yet" });
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

// S6: the suggested pairs by name and date of birth (U3). `f.pairs` is counted by the screen with the same rule Review
// all stages by (gpexe-import-data.js guidePairCounts), so the button never promises more than it opens.
function athleteSuggestions(f, unlinked) {
  const p = f.pairs;
  const exact = p ? p.exact : 0;
  return {
    ready: Boolean(p),
    exact,
    choice: unlinked === null ? 0 : Math.max(0, unlinked - exact),
    namesMissing: Boolean(p && p.namesMissing),
    canLoadNames: f.identityLoad === true,
  };
}

// The backup line of the checklist: only from the recorded dates an administrator reads (never claimed otherwise).
// The dates are a condition of switching import on (v56), so with import on the line is information only (ok: null).
function backupLine(data, switchOn) {
  const c = Array.isArray(data?.conditions) ? data.conditions.find((x) => x.kind === "backup") : null;
  if (!c) return null;
  const when = c.recordedOn ? c.recordedOn.split("-").reverse().join(".") : null;
  if (switchOn === true) return when ? { id: "backup", ok: null, text: `Last backup recorded ${when}` } : null;
  const need = " (needed to switch import on)";
  return { id: "backup", ok: c.met === true, text: c.met === true ? `Backup recorded on ${when}${need}` : when ? `Backup is older than ${c.maxAgeDays} days (recorded on ${when})${need}` : `No backup recorded${need}` };
}
