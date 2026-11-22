// K6-1 (docs/ai/central-calendar-k6-contract.md, section 2): the calendar's team and athlete switcher.
// Pure model + template strings, and the one read of the club's team memberships. The strip's list is
// `state.athletes` (the rail roster, the server's roster scope) INTERSECTED with the membership facts of
// `GET /api/organization`, reduced on arrival to { athleteUuid, teamId } pairs of this calendar's own teams
// (2.3, 5.1): nothing else of that answer is ever kept.
import {
  ATHLETE_SEARCH_MAX,
  ATHLETE_SEARCH_MIN_STRIP,
  ATHLETE_STRIP_MAX,
  renderAthleteSwitcherResultsHtml,
  renderAthleteSwitcherSearchHtml,
  renderAthleteSwitcherStripHtml,
  searchAthletes,
} from "./athlete-switcher.js";
import { api } from "./api.js";
import { calendarTeamColorIndexes } from "./calendar-colors.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { state } from "./state.js";
import { buildContextKey } from "./view-cache.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// The team's name as the calendar shows it ("U19 · Borac" in the platform workspace). The same rule as
// central-calendar-data.js's centralCalendarTeamLabel, kept here so the two modules never import each other.
const centralCalendarTeamLabel = (team) => {
  const name = team?.name || "Team";
  return team?.clubName ? `${name} · ${team.clubName}` : name;
};

export const CC_SWITCHER_ACTIONS = Object.freeze({
  pick: "central-calendar-pick-athlete",
  result: "central-calendar-pick-result",
  // The Groups chips keep their action name (the chips only moved, contract 2.2); it is now the choice of one team.
  group: "central-calendar-toggle-team",
  toggle: "central-calendar-switcher-toggle",
  everyone: "central-calendar-show-everyone",
  orgRetry: "central-calendar-switcher-org-retry",
});

const rowUuid = (row) => String(row?.athlete_uuid || "");
const rowImage = (row) => row?.athlete_image_url || row?.image_url || "";

export function centralCalendarWorkspaceType(cal) {
  return cal?.data?.workspace?.type || "";
}

// The chosen athlete, checked against the roster now: a remembered id that is no longer there is never sent (2.5).
// The platform workspace has no strip, so no athlete either.
export function centralCalendarChosenAthlete(cal, athletes = state.athletes) {
  const key = cal?.switcher?.athleteKey || "";
  if (!key || centralCalendarWorkspaceType(cal) === "platform") return "";
  return (athletes || []).some((row) => rowUuid(row) === key) ? key : "";
}

// `GET /api/organization` reduced to what K6 may keep: the active team memberships of roster athletes in this
// calendar's teams. Everything else (users, e-mails, invites, other memberships, names) is dropped at once.
export function reduceOrganizationPairs(answer, athletes, teams) {
  const roster = new Set((athletes || []).map(rowUuid).filter(Boolean));
  const teamIds = new Set((teams || []).map((team) => String(team.teamId)));
  const pairs = [];
  for (const row of Array.isArray(answer?.athletes) ? answer.athletes : []) {
    const uuid = String(row?.id || "");
    if (!uuid || !roster.has(uuid)) continue;
    for (const membership of Array.isArray(row.memberships) ? row.memberships : []) {
      if (membership?.membershipType !== "team" || membership?.status !== "active") continue;
      const teamId = String(membership.teamId || "");
      if (!teamIds.has(teamId)) continue;
      if (!pairs.some((pair) => pair.athleteUuid === uuid && pair.teamId === teamId)) pairs.push({ athleteUuid: uuid, teamId });
    }
  }
  return pairs;
}

let orgGeneration = 0;
export function bumpCentralCalendarSwitcherGeneration() {
  orgGeneration += 1;
}

// Read once per workspace, club workspaces only; a slower answer of another workspace is dropped.
export async function ensureCentralCalendarSwitcherOrg(cal, render) {
  if (state.centralCalendar !== cal || centralCalendarWorkspaceType(cal) !== "club") return;
  const org = cal.switcher.org;
  if (org.status === "loading" || org.status === "ready") return;
  // An empty roster has nothing to group: no request (the pairs are only ever the roster's).
  if (!(state.athletes || []).length) return;
  const generation = ++orgGeneration;
  const contextKey = buildContextKey(currentUserWorkspaceContextParts());
  org.status = "loading";
  const current = () => generation === orgGeneration && state.centralCalendar === cal && contextKey === buildContextKey(currentUserWorkspaceContextParts());
  try {
    const answer = await api("/api/organization");
    if (!current()) return;
    org.pairs = reduceOrganizationPairs(answer, state.athletes, cal.data?.teams);
    org.contextKey = contextKey;
    org.status = "ready";
  } catch {
    if (!current()) return;
    org.pairs = [];
    org.status = "error";
  }
  render?.();
}

// --- The model --------------------------------------------------------------

function teamColorStyle(teamId, teams) {
  const index = calendarTeamColorIndexes(teams).get(teamId) ?? -1;
  return index < 0 ? "" : `--cc-team-color: var(--cc-team-${index})`;
}

const byName = (a, b) => String(a.name).localeCompare(String(b.name));

// What the box shows for this calendar answer: the Groups row, the strip's items, the search's list.
export function buildCentralCalendarSwitcherModel(cal, athletes = state.athletes) {
  if (!cal?.data || !cal.switcher) return null;
  const type = centralCalendarWorkspaceType(cal);
  const teams = cal.data.teams || [];
  const chosenTeam = (cal.filters?.teamIds || [])[0] || "";
  const showGroups = teams.length > 1 || (type === "platform" && teams.length > 0);
  const base = { type, teams, chosenTeam, showGroups, strip: null, tooMany: 0, orgStatus: "ready", searchList: [], athleteKey: "" };
  if (type === "platform") return base;
  const roster = (athletes || []).filter((row) => rowUuid(row)).map((row) => ({ key: rowUuid(row), name: String(row.athlete || "Athlete"), imageUrl: rowImage(row) }));
  const grouped = type === "club";
  const org = cal.switcher.org;
  const pairs = grouped && org.status === "ready" ? org.pairs : [];
  const orderOf = new Map(teams.map((team, index) => [String(team.teamId), index]));
  const teamName = (teamId) => teams.find((team) => String(team.teamId) === teamId)?.name || "Team";
  const teamsOf = (uuid) => pairs.filter((pair) => pair.athleteUuid === uuid).map((pair) => pair.teamId).sort((a, b) => orderOf.get(a) - orderOf.get(b));
  const withTeams = roster.map((item) => ({ ...item, teamIds: teamsOf(item.key) }));
  const byTeams = grouped && org.status === "ready";
  // The search list: the whole strip list of the workspace, each with its team names (a club workspace).
  const searchList = withTeams.map((item) => ({
    ...item,
    teamOrder: item.teamIds.length ? orderOf.get(item.teamIds[0]) : teams.length,
    teamLabels: item.teamIds.map((id) => ({ name: teamName(id), colorStyle: teamColorStyle(id, teams) })),
  })).sort(byName);
  base.searchList = searchList;
  base.orgStatus = grouped ? org.status : "ready";
  let items = [];
  if (chosenTeam && byTeams) {
    items = withTeams.filter((item) => item.teamIds.includes(chosenTeam)).sort(byName);
  } else if (!byTeams) {
    items = [...withTeams].sort(byName);
  } else if (withTeams.length > ATHLETE_STRIP_MAX) {
    base.tooMany = withTeams.length;
    items = [];
  } else {
    // All groups: every athlete once, under the first of their teams, then "No team".
    const seen = new Set();
    for (const team of teams) {
      const id = String(team.teamId);
      let first = true;
      for (const item of withTeams.filter((row) => row.teamIds[0] === id).sort(byName)) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        items.push({ ...item, teamColorStyle: teamColorStyle(id, teams), groupLabel: first ? team.name : "" });
        first = false;
      }
    }
    let firstNone = true;
    for (const item of withTeams.filter((row) => !row.teamIds.length).sort(byName)) {
      items.push({ ...item, groupLabel: firstNone ? "No team" : "" });
      firstNone = false;
    }
  }
  base.strip = items.length || base.tooMany ? items : [];
  base.athleteKey = centralCalendarChosenAthlete(cal, athletes);
  base.rosterCount = withTeams.length;
  return base;
}

export function centralCalendarSwitcherSearchShown(model) {
  if (!model || model.type === "platform") return false;
  return (model.strip?.length || 0) > ATHLETE_SEARCH_MIN_STRIP || model.tooMany > 0;
}

export function centralCalendarSwitcherEmptySentence(type, query) {
  const text = String(query ?? "").trim();
  if (type === "team") return `No athlete in this team matches ‘${text}’.`;
  if (type === "private_coach") return `None of your athletes matches ‘${text}’.`;
  return `No athlete in this club matches ‘${text}’.`;
}

export function centralCalendarSwitcherResults(cal, model) {
  const query = cal.switcher.query;
  if (!query || !model) return null;
  return searchAthletes(model.searchList, query, { max: ATHLETE_SEARCH_MAX });
}

// --- The view -----------------------------------------------------------------

function groupsRowHtml(cal, model, counts) {
  if (!model.showGroups) return "";
  const chip = (action, teamId, label, count, active, style = "") => `<button type="button" class="cc-chip${active ? " is-active" : ""}" data-action="${action}"${teamId ? ` data-team-id="${escapeAttr(teamId)}"` : ""} aria-pressed="${active ? "true" : "false"}" aria-label="${escapeAttr(`${label}, ${count}`)}"${style ? ` style="${escapeAttr(style)}"` : ""}>${style ? `<span class="cc-chip-dot" aria-hidden="true"></span>` : ""}<span class="cc-chip-label">${escapeHtml(label)}</span><span class="cc-chip-count">${escapeHtml(String(count))}</span></button>`;
  return `<div class="cc-chip-row athlete-switcher-groups" role="group" aria-label="Groups">
        <span class="cc-chip-row-label">Groups</span>
        ${chip("central-calendar-all-groups", "", "All groups", counts?.total ?? 0, !model.chosenTeam)}
        ${model.teams.map((team) => chip(CC_SWITCHER_ACTIONS.group, String(team.teamId), centralCalendarTeamLabel(team), counts?.teams?.get(team.teamId) || 0, model.chosenTeam === String(team.teamId), teamColorStyle(String(team.teamId), model.teams))).join("")}
      </div>`;
}

function chosenItem(model, key) {
  return (model.searchList || []).find((item) => item.key === key) || null;
}

// "Everyone · U19" / "Ana Kovač · U19": the phone's folded line, and the green line's names.
export function centralCalendarSwitcherSummary(cal, model) {
  const team = model.chosenTeam ? model.teams.find((entry) => String(entry.teamId) === model.chosenTeam)?.name || "" : "";
  const athlete = model.athleteKey ? chosenItem(model, model.athleteKey)?.name || "" : "";
  return { athlete, team, text: [athlete || "Everyone", model.showGroups ? team : ""].filter(Boolean).join(" · ") };
}

const searchArgs = (cal, model) => ({
  value: cal.switcher.query,
  results: centralCalendarSwitcherResults(cal, model),
  activeIndex: cal.switcher.activeIndex,
  emptySentence: centralCalendarSwitcherEmptySentence(model.type, cal.switcher.query),
  pickAction: CC_SWITCHER_ACTIONS.result,
});

export function renderCentralCalendarSearchHtml(cal, model) {
  return renderAthleteSwitcherSearchHtml({ ...searchArgs(cal, model), action: "central-calendar-switcher-search" });
}

// The result list alone (every keystroke, the arrows): the field is not drawn again.
export function renderCentralCalendarSearchResultsHtml(cal, model) {
  return renderAthleteSwitcherResultsHtml(searchArgs(cal, model));
}

export function renderCentralCalendarSwitcherHtml(cal, model, { layout = "wide", counts = null } = {}) {
  if (!model || (model.type === "platform" && !model.showGroups)) return "";
  const phone = layout === "phone";
  const open = !phone || cal.switcher.open;
  const summary = centralCalendarSwitcherSummary(cal, model);
  let body = groupsRowHtml(cal, model, counts);
  if (model.type !== "platform") {
    if (centralCalendarSwitcherSearchShown(model)) body += renderCentralCalendarSearchHtml(cal, model);
    if (model.tooMany) {
      body += `<p class="athlete-switcher-note" role="status">${model.tooMany} athletes in the club. Search for an athlete, or choose a group.</p>`;
    } else if (model.strip && model.strip.length > 0) {
      const strip = model.strip;
      const athleteKey = model.athleteKey;
      const index = strip.findIndex((item) => item.key === athleteKey);
      body += renderAthleteSwitcherStripHtml({
        items: strip,
        currentKey: athleteKey && index >= 0 ? athleteKey : "",
        action: CC_SWITCHER_ACTIONS.pick,
        keyAttr: "data-athlete-key",
        allItem: { label: "Everyone", caption: "All" },
        ariaLabel: "Athletes",
        wrapArrows: false,
      });
      if (athleteKey && index >= 0) body += `<small class="athlete-switcher-count">${index + 1} / ${strip.length}</small>`;
    }
    if (model.type === "club" && model.orgStatus === "error") {
      body += `<p class="athlete-switcher-note" role="status">Teams could not be loaded. <button type="button" class="plain-button cc-inline-button" data-action="${CC_SWITCHER_ACTIONS.orgRetry}">Try again</button></p>`;
    }
  }
  if (!body) return "";
  const fold = phone
    ? `<button type="button" class="athlete-switcher-fold" data-action="${CC_SWITCHER_ACTIONS.toggle}" aria-expanded="${open ? "true" : "false"}"><span>${escapeHtml(summary.text)}</span><span class="cc-filters-chevron" aria-hidden="true"></span></button>`
    : "";
  return `<section class="athlete-switcher${open ? " is-open" : ""}" aria-label="Team and athlete">${fold}<div class="athlete-switcher-body"${open ? "" : " hidden"}>${body}</div></section>`;
}

// F2: the green line above the grid whenever the choice is not Everyone.
export function renderCentralCalendarShowingLineHtml(cal, model, { onlyLabel = "" } = {}) {
  if (!model?.athleteKey) return "";
  const { athlete, team } = centralCalendarSwitcherSummary(cal, model);
  if (!athlete) return "";
  const parts = [`Showing <strong>${escapeHtml(athlete)}</strong>`];
  if (model.type === "club" && team) parts.push(escapeHtml(team));
  if (onlyLabel) parts.push(escapeHtml(onlyLabel));
  return `<p class="cc-showonly-line cc-athlete-line" role="status"><span>${parts.join(" · ")}</span><button type="button" class="plain-button cc-inline-button cc-showonly-all" data-action="${CC_SWITCHER_ACTIONS.everyone}">Show everyone</button></p>`;
}
