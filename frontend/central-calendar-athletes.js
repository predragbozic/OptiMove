// K6-1, the calendar's team and athlete switcher (docs/ai/central-calendar-k6-contract.md section 2): the Groups row
// (the Filters panel's chips, moved here, one team at a time), the search and the strip of athletes, the green
// "Showing …" line. Frontend only: the lists come from the rail roster (state.athletes) and, for a club's grouping
// only, the reduced { athleteUuid, teamId } pairs of GET /api/organization (central-calendar-data.js). Nothing is
// listed, named, counted or coloured that the workspace does not already show (contract 5.1).
import { calendarTeamColorIndexes } from "./calendar-colors.js";
import {
  centralCalendarChosenAthlete,
  centralCalendarK6,
  centralCalendarServerKinds,
  centralCalendarShownData,
  centralCalendarTeamLabel,
  findCentralCalendarItem,
  loadCentralCalendarAthlete,
  loadCentralCalendarDay,
  loadCentralCalendarKinds,
  loadCentralCalendarOrganization,
} from "./central-calendar-data.js";
import {
  ATHLETE_SWITCHER_ALL_GROUPS_LIMIT,
  ATHLETE_SWITCHER_SEARCH_FROM,
  athleteSwitcherScrollIntoView,
  athleteSwitcherSearch,
  renderAthleteSwitcherSearchHtml,
  renderAthleteSwitcherSearchResultsHtml,
  renderAthleteSwitcherStripHtml,
} from "./athlete-switcher.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const SEARCH_ID = "ccK6Search";
const NO_TEAM = "No team";

function teamColorStyle(teamId, teams) {
  const index = calendarTeamColorIndexes(teams).get(teamId) ?? -1;
  return index < 0 ? "" : ` style="--cc-team-color: var(--cc-team-${index})"`;
}

function rosterAthletes() {
  return (state.athletes || [])
    .filter((athlete) => athlete?.athlete_uuid)
    .map((athlete) => ({ key: String(athlete.athlete_uuid), name: String(athlete.athlete || "Athlete"), imageUrl: athlete.athlete_image_url || athlete.image_url || "" }));
}

const byName = (a, b) => a.name.localeCompare(b.name);

// The strip's list and how it is drawn, for the workspace on screen (contract 2.3, 2.4).
export function centralCalendarK6Model(cal) {
  const workspaceType = cal?.data?.workspace?.type || "";
  const teams = cal?.data?.teams || [];
  const k6 = cal?.k6 || null;
  const chosenTeam = String(cal?.filters?.teamIds?.[0] || "");
  const groupsRow = Boolean(cal?.data) && teams.length > 1;
  const model = { workspaceType, teams, groupsRow, chosenTeam, strip: null, searchOnly: 0, searchList: [], teamsOf: new Map(), orgNote: "", showSearch: false };
  if (!cal?.data || workspaceType === "platform" || !["club", "team", "private_coach"].includes(workspaceType)) return model;
  const roster = rosterAthletes();
  const order = new Map(teams.map((team, index) => [String(team.teamId), index]));
  if (workspaceType !== "club") {
    const items = roster.sort(byName);
    model.strip = items;
    model.searchList = items.map((item) => ({ ...item, rank: 0 }));
  } else {
    const org = k6?.organization || { status: "idle", pairs: [] };
    if (org.status === "ready") {
      for (const pair of org.pairs) {
        if (!order.has(pair.teamId)) continue;
        const list = model.teamsOf.get(pair.athleteUuid) || [];
        if (!list.includes(pair.teamId)) list.push(pair.teamId);
        model.teamsOf.set(pair.athleteUuid, list);
      }
      for (const list of model.teamsOf.values()) list.sort((a, b) => order.get(a) - order.get(b));
      const firstTeam = (item) => model.teamsOf.get(item.key)?.[0] || "";
      if (chosenTeam) {
        model.strip = roster.filter((item) => (model.teamsOf.get(item.key) || []).includes(chosenTeam)).sort(byName);
      } else {
        const grouped = [];
        for (const team of teams) {
          const members = roster.filter((item) => firstTeam(item) === String(team.teamId)).sort(byName);
          members.forEach((item, index) => grouped.push({ ...item, groupLabel: index === 0 ? centralCalendarTeamLabel(team) : "", teamColorStyle: teamColorStyle(team.teamId, teams) }));
        }
        const loose = roster.filter((item) => !firstTeam(item)).sort(byName);
        loose.forEach((item, index) => grouped.push({ ...item, groupLabel: index === 0 ? NO_TEAM : "" }));
        if (grouped.length > ATHLETE_SWITCHER_ALL_GROUPS_LIMIT) model.searchOnly = grouped.length;
        else model.strip = grouped;
      }
      model.searchList = roster.map((item) => ({ ...item, rank: order.get(firstTeam(item)) ?? teams.length }));
    } else {
      // Not loaded (yet, or it failed): the roster by name, no grouping and no dot; the Groups row still works on the cards.
      model.strip = roster.sort(byName);
      model.searchList = model.strip.map((item) => ({ ...item, rank: 0 }));
      if (org.status === "failed") model.orgNote = "Teams could not be loaded.";
    }
  }
  model.showSearch = Boolean(model.searchOnly) || (model.strip || []).length > ATHLETE_SWITCHER_SEARCH_FROM;
  return model;
}

function athleteNameOf(id) {
  return rosterAthletes().find((item) => item.key === id)?.name || "";
}

// The team the green line and the folded box name (a club only): the chosen group, else the athlete's first team.
function lineTeam(cal, model, athleteId) {
  if (model.workspaceType !== "club") return null;
  const id = model.chosenTeam || (athleteId ? model.teamsOf.get(athleteId)?.[0] : "") || "";
  return model.teams.find((team) => String(team.teamId) === id) || null;
}

function emptySentence(model, typed) {
  const quoted = `‘${typed}’`;
  if (model.workspaceType === "team") return `No athlete in this team matches ${quoted}.`;
  if (model.workspaceType === "club") return `No athlete in this club matches ${quoted}.`;
  return `None of your athletes matches ${quoted}.`;
}

function searchResults(cal, model) {
  const k6 = cal.k6 || {};
  const { results, more } = athleteSwitcherSearch(model.searchList, k6.search || "");
  return {
    results: results.map((row) => ({
      ...row,
      detailHtml: model.workspaceType === "club"
        ? (model.teamsOf.get(row.key) || []).map((teamId) => {
          const team = model.teams.find((entry) => String(entry.teamId) === teamId);
          return team ? `<span class="athlete-switcher-result-team"${teamColorStyle(team.teamId, model.teams)}><span class="cc-team-dot" aria-hidden="true"></span>${escapeHtml(centralCalendarTeamLabel(team))}</span>` : "";
        }).join("")
        : "",
    })),
    more,
    activeIndex: Number.isInteger(k6.searchIndex) ? k6.searchIndex : -1,
    emptySentence: emptySentence(model, String(k6.search || "").trim()),
  };
}

function groupChipHtml({ action, teamId = "", label, count, active, style = "", dot = false }) {
  return `<button type="button" class="cc-chip${active ? " is-active" : ""}" data-action="${action}"${teamId ? ` data-team-id="${escapeAttr(teamId)}"` : ""} aria-pressed="${active ? "true" : "false"}" aria-label="${escapeAttr(`${label}, ${count}`)}"${style}>${dot ? `<span class="cc-chip-dot" aria-hidden="true"></span>` : ""}<span class="cc-chip-label">${escapeHtml(label)}</span><span class="cc-chip-count">${escapeHtml(String(count))}</span></button>`;
}

// The switcher box (contract 2.1): under the week's navigation, above the grid; folded to one line on a phone.
export function renderCentralCalendarSwitcherHtml(cal, { counts, layout = "wide" } = {}) {
  const model = centralCalendarK6Model(cal);
  if (!model.groupsRow && !model.strip && !model.searchOnly) return "";
  const k6 = cal.k6 || {};
  const athleteId = centralCalendarChosenAthlete(cal);
  const groups = model.groupsRow
    ? `<div class="cc-chip-row cc-k6-groups" role="group" aria-label="Groups">
        <span class="cc-chip-row-label">Groups</span>
        ${groupChipHtml({ action: "central-calendar-all-groups", label: "All groups", count: counts?.total ?? 0, active: !model.chosenTeam })}
        ${model.teams.map((team) => groupChipHtml({
          action: "central-calendar-toggle-team", teamId: String(team.teamId), label: centralCalendarTeamLabel(team),
          count: counts?.teams?.get(team.teamId) || 0, active: model.chosenTeam === String(team.teamId), style: teamColorStyle(team.teamId, model.teams), dot: true,
        })).join("")}
      </div>`
    : "";
  const search = model.showSearch
    ? renderAthleteSwitcherSearchHtml({ value: k6.search || "", inputAction: "central-calendar-k6-search", focusKey: "k6-search", id: SEARCH_ID, action: "central-calendar-k6-athlete", keyAttr: "data-athlete-key", ...searchResults(cal, model) })
    : "";
  const position = model.strip && athleteId ? model.strip.findIndex((item) => item.key === athleteId) : -1;
  const strip = model.strip
    ? `${athleteId && position >= 0 ? `<p class="cc-k6-position"><strong>${escapeHtml(athleteNameOf(athleteId))}</strong> <small>${position + 1} / ${model.strip.length}</small></p>` : ""}
      ${model.strip.length ? renderAthleteSwitcherStripHtml({
        items: model.strip, currentKey: athleteId, action: "central-calendar-k6-athlete", keyAttr: "data-athlete-key",
        allItem: { label: "Everyone", caption: "All" }, ariaLabel: "Athletes", wrapArrows: false,
      }) : ""}`
    : model.searchOnly
      ? `<p class="cc-k6-searchonly">${model.searchOnly} athletes in the club. Search for an athlete, or choose a group.</p>`
      : "";
  const orgNote = model.orgNote ? `<p class="cc-k6-note" role="status">${escapeHtml(model.orgNote)} <button type="button" class="plain-button cc-inline-button" data-action="central-calendar-k6-org-retry">Try again</button></p>` : "";
  const body = `${groups}${search}${strip}${orgNote}`;
  if (layout !== "phone") return `<section class="cc-k6" aria-label="Team and athlete">${body}</section>`;
  const team = lineTeam(cal, model, athleteId);
  const summary = `${athleteId ? athleteNameOf(athleteId) : "Everyone"}${team ? ` · ${centralCalendarTeamLabel(team)}` : ""}`;
  const open = Boolean(k6.boxOpen);
  return `<section class="cc-k6 cc-k6-phone${open ? " is-open" : ""}" aria-label="Team and athlete">
      <button type="button" class="cc-k6-fold" data-action="central-calendar-k6-box" aria-expanded="${open ? "true" : "false"}" aria-controls="ccK6Body"><span class="cc-k6-fold-text">${escapeHtml(summary)}</span><span class="cc-filters-chevron" aria-hidden="true"></span></button>
      <div class="cc-k6-body" id="ccK6Body"${open ? "" : " hidden"}>${body}</div>
    </section>`;
}

// The green line (F2): "Showing Ana Kovač · U19 · only GPS imports · Show everyone"; "" on Everyone.
export function renderCentralCalendarAthleteLineHtml(cal, { showOnlyLabel = "" } = {}) {
  const athleteId = centralCalendarChosenAthlete(cal);
  if (!athleteId) return "";
  const model = centralCalendarK6Model(cal);
  const team = lineTeam(cal, model, athleteId);
  const parts = [team ? escapeHtml(centralCalendarTeamLabel(team)) : "", showOnlyLabel ? `only ${escapeHtml(showOnlyLabel)}` : ""].filter(Boolean);
  return `<p class="cc-showonly-line cc-k6-line" role="status"><span>Showing <strong>${escapeHtml(athleteNameOf(athleteId))}</strong>${parts.map((part) => ` · ${part}`).join("")}</span><button type="button" class="plain-button cc-inline-button cc-k6-everyone" data-action="central-calendar-k6-everyone">Show everyone</button></p>`;
}

// The panel's note while an athlete is chosen (Q5): her row only, and *Show everyone* reads the item again.
export function renderCentralCalendarPanelAthleteNoteHtml(cal) {
  const athleteId = centralCalendarChosenAthlete(cal);
  if (!athleteId) return "";
  if (cal.panel?.everyone) return `<p class="cc-k6-panel-note">Showing everyone on this item.</p>`;
  return `<p class="cc-k6-panel-note">Showing ${escapeHtml(athleteNameOf(athleteId))} only. <button type="button" class="plain-button cc-inline-button" data-action="central-calendar-k6-panel-everyone">Show everyone</button></p>`;
}

function closedPanel() {
  return { open: false, key: "", date: "", athletes: null, loading: false, error: "" };
}

// The cards after a change of the chosen athlete: her read, or (back to Everyone) the kinds read if one is needed.
async function readCards(cal, render) {
  if (centralCalendarChosenAthlete(cal)) await loadCentralCalendarAthlete({ render });
  else if (centralCalendarServerKinds(cal.filters)) await loadCentralCalendarKinds({ render, closeMissing: false });
}

export async function chooseCentralCalendarAthlete(cal, athleteId, { render } = {}) {
  const k6 = centralCalendarK6(cal);
  const id = String(athleteId || "");
  if (id && !rosterAthletes().some((item) => item.key === id)) return;
  if (cal.data?.workspace?.type === "platform") return;
  const changed = id !== String(k6.athleteId || "");
  k6.athleteId = id;
  k6.search = "";
  k6.searchIndex = -1;
  k6.boxOpen = false;
  k6.athleteError = "";
  if (changed && cal.panel?.open && !cal.form) cal.panel = closedPanel();
  render?.();
  if (changed) await readCards(cal, render);
}

// A team chosen in the Groups row (one at a time, Q1): the strip shows that team; an athlete not in it goes back to
// Everyone. "" is All groups.
export async function chooseCentralCalendarTeam(cal, teamId, { render } = {}) {
  const k6 = centralCalendarK6(cal);
  const id = String(teamId || "");
  const teams = new Set((cal.data?.teams || []).map((team) => String(team.teamId)));
  if (id && !teams.has(id)) return;
  cal.filters.teamIds = id ? [id] : [];
  const athleteId = centralCalendarChosenAthlete(cal);
  if (id && athleteId) {
    const model = centralCalendarK6Model(cal);
    if (model.teamsOf.size && !(model.teamsOf.get(athleteId) || []).includes(id)) {
      k6.athleteId = "";
      if (cal.panel?.open && !cal.form) cal.panel = closedPanel();
      render?.();
      await readCards(cal, render);
      return;
    }
  }
  render?.();
}

function chooseFromSearch(cal, athleteId, render) {
  const model = centralCalendarK6Model(cal);
  if (model.workspaceType === "club" && model.teamsOf.size) {
    const teamsOfAthlete = model.teamsOf.get(athleteId) || [];
    const elsewhere = model.chosenTeam && !teamsOfAthlete.includes(model.chosenTeam);
    if (elsewhere || (!model.chosenTeam && model.searchOnly)) cal.filters.teamIds = teamsOfAthlete[0] ? [teamsOfAthlete[0]] : [];
  }
  return chooseCentralCalendarAthlete(cal, athleteId, { render });
}

// The clicks of the box, the green line and the panel note; false for any other action.
export async function handleCentralCalendarK6Action(type, action, { render, openWeeklyPlanForAthleteOnDate } = {}) {
  const cal = state.centralCalendar;
  if (!cal) return false;
  if (type === "central-calendar-k6-each") {
    await openEachAthlete(cal, action, { openWeeklyPlanForAthleteOnDate });
    return true;
  }
  if (type === "central-calendar-k6-athlete") {
    const id = action.dataset.athleteKey || "";
    if (action.closest?.(".athlete-switcher-search")) await chooseFromSearch(cal, id, render);
    else await chooseCentralCalendarAthlete(cal, id, { render });
    return true;
  }
  if (type === "central-calendar-k6-everyone") {
    await chooseCentralCalendarAthlete(cal, "", { render });
    return true;
  }
  if (type === "central-calendar-k6-box") {
    const k6 = centralCalendarK6(cal);
    k6.boxOpen = !k6.boxOpen;
    render?.();
    return true;
  }
  if (type === "central-calendar-k6-org-retry") {
    await loadCentralCalendarOrganization({ render, force: true });
    return true;
  }
  if (type === "central-calendar-k6-panel-everyone") {
    if (!cal.panel?.open) return true;
    cal.panel = { ...cal.panel, everyone: true };
    await loadCentralCalendarDay({ render });
    return true;
  }
  return false;
}

function paintSearchResults(cal) {
  const body = globalThis.document?.querySelector?.(`#${SEARCH_ID}-body`);
  const input = globalThis.document?.querySelector?.('[data-action="central-calendar-k6-search"]');
  if (!body) return false;
  const model = centralCalendarK6Model(cal);
  const results = searchResults(cal, model);
  body.innerHTML = renderAthleteSwitcherSearchResultsHtml({ value: cal.k6.search, id: SEARCH_ID, action: "central-calendar-k6-athlete", keyAttr: "data-athlete-key", ...results });
  if (input) {
    input.setAttribute("aria-expanded", String(Boolean(String(cal.k6.search || "").trim() && results.results.length)));
    if (results.activeIndex >= 0 && results.results[results.activeIndex]) input.setAttribute("aria-activedescendant", `${SEARCH_ID}-results-${results.activeIndex}`);
    else input.removeAttribute("aria-activedescendant");
  }
  return true;
}

// The search's typed text (app.js's input event): only the results are drawn again.
export function handleCentralCalendarK6Input(target, { render } = {}) {
  if (target?.dataset?.action !== "central-calendar-k6-search") return false;
  const cal = state.centralCalendar;
  if (!cal) return true;
  const k6 = centralCalendarK6(cal);
  const value = String(target.value ?? "");
  if (value === k6.search) return true;
  k6.search = value;
  k6.searchIndex = value.trim() ? 0 : -1;
  if (!paintSearchResults(cal)) render?.();
  return true;
}

// ↑ ↓ move, Enter chooses, Escape clears (contract 2.6).
export function handleCentralCalendarK6Keydown(event, { render } = {}) {
  const target = event?.target;
  if (target?.dataset?.action !== "central-calendar-k6-search") return false;
  const cal = state.centralCalendar;
  if (!cal) return false;
  const k6 = centralCalendarK6(cal);
  const model = centralCalendarK6Model(cal);
  const { results } = athleteSwitcherSearch(model.searchList, k6.search || "");
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!results.length) return true;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    k6.searchIndex = ((Number.isInteger(k6.searchIndex) ? k6.searchIndex : -1) + step + results.length) % results.length;
    paintSearchResults(cal);
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const row = results[k6.searchIndex >= 0 ? k6.searchIndex : 0];
    if (row) void chooseFromSearch(cal, row.key, render);
    return true;
  }
  if (event.key === "Escape") {
    if (!k6.search) return false;
    event.preventDefault();
    event.stopPropagation?.();
    k6.search = "";
    k6.searchIndex = -1;
    target.value = "";
    paintSearchResults(cal);
    return true;
  }
  return false;
}

// K6-3 (contract section 4): *See each athlete* from an event's panel. The list is the panel's athletes of that day
// intersected with the roster, in the panel's order; a manager's view names the linked slots of the day (one button
// per slot), a reader gets *Open the week* (the day, no session, Q7). Returns null where nothing is offered.
export function centralCalendarEachAthleteModel(cal, item) {
  if (item?.kind !== "event" || item.cancelled || !cal?.panel?.open || cal.panel.key !== item.key || !Array.isArray(cal.panel.athletes)) return null;
  if (centralCalendarChosenAthlete(cal) && !cal.panel.everyone) return null;
  const roster = new Map((state.athletes || []).filter((athlete) => athlete?.athlete_uuid && athlete?.athlete_id).map((athlete) => [String(athlete.athlete_uuid), athlete]));
  const listed = [...cal.panel.athletes].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  const inRoster = listed.filter((athlete) => roster.has(String(athlete.athleteId || athlete.id || "")));
  if (!inRoster.length) return null;
  const view = cal.panelEvent && cal.panelEvent.key === item.key ? cal.panelEvent.event : null;
  const manager = item.canManage === true && Array.isArray(view?.sessionLinks);
  const slots = [];
  if (manager) {
    for (const link of view.sessionLinks) {
      if (link.day !== cal.panel.date || link.state === "orphaned") continue;
      const key = `${link.amPm || ""}|${link.bta || ""}`;
      let slot = slots.find((entry) => entry.key === key);
      if (!slot) {
        slot = { key, amPm: link.amPm || "", bta: link.bta || "", name: String(link.sessionName ?? "").trim() || "the session", athletes: new Set() };
        slots.push(slot);
      }
      if (link.athleteId) slot.athletes.add(String(link.athleteId));
    }
  }
  return {
    manager, slots, date: cal.panel.date,
    hidden: manager ? listed.length - inRoster.length : 0,
    athletes: inRoster.map((athlete) => {
      const row = roster.get(String(athlete.athleteId || athlete.id));
      return { uuid: String(row.athlete_uuid), key: String(row.athlete_id), name: String(athlete.name || row.athlete || "Athlete"), imageUrl: row.athlete_image_url || row.image_url || "" };
    }),
  };
}

export function renderCentralCalendarEachAthleteHtml(cal, item) {
  const model = centralCalendarEachAthleteModel(cal, item);
  if (!model) return "";
  const hidden = model.hidden > 0 ? `<p class="cc-k6-panel-note">${model.hidden} athlete${model.hidden === 1 ? "" : "s"} of this event ${model.hidden === 1 ? "is" : "are"} not in your roster.</p>` : "";
  const attrs = `data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(model.date)}"`;
  if (!model.manager || !model.slots.length) {
    return `<div class="cc-k6-each"><button type="button" class="plain-button cc-panel-button" data-action="central-calendar-k6-each" ${attrs} data-slot="">Open the week</button>${hidden}</div>`;
  }
  const many = model.slots.length > 1;
  return `<div class="cc-k6-each">
      ${model.slots.map((slot) => `<button type="button" class="plain-button cc-primary cc-panel-button" data-action="central-calendar-k6-each" ${attrs} data-slot="${escapeAttr(slot.key)}">${escapeHtml(many ? `See each athlete · ${slot.name}` : "See each athlete")}</button>`).join("")}
      <p class="cc-k6-panel-note">Opens ${escapeHtml(model.slots[0].name)}${many ? " (or the session you choose)" : ""}, one athlete at a time, only the ${model.athletes.length} of this event.</p>
      ${hidden}
    </div>`;
}

async function openEachAthlete(cal, action, { openWeeklyPlanForAthleteOnDate }) {
  const item = findCentralCalendarItem(centralCalendarShownData(cal), action.dataset.key || "");
  const model = item ? centralCalendarEachAthleteModel(cal, item) : null;
  if (!model || action.dataset.date !== model.date) return;
  const slot = model.slots.find((entry) => entry.key === (action.dataset.slot || "")) || null;
  const athletes = model.athletes.map((athlete) => (slot && !slot.athletes.has(athlete.uuid)
    ? { key: athlete.key, name: athlete.name, imageUrl: athlete.imageUrl, mark: "–", markLabel: "not in this session" }
    : { key: athlete.key, name: athlete.name, imageUrl: athlete.imageUrl }));
  const switcher = { athletes, teamLabel: "", context: "in this event", sessionLabel: slot ? slot.name : "" };
  await openWeeklyPlanForAthleteOnDate?.(athletes[0].key, model.date, { switcher, slot: slot ? { amPm: slot.amPm, bta: slot.bta } : null });
}

// K6-2 (contract 3.1): the Weekly plan's list, opened from the calendar for `athleteUuid` - the strip's list of the
// team chosen here (roster athletes only, in the strip's order), or her alone when the strip does not hold her.
// Keys are the roster's athlete_id, the id the weekly plan's route reads.
export function centralCalendarWeeklySwitcher(cal, athleteUuid) {
  const roster = new Map((state.athletes || []).filter((athlete) => athlete?.athlete_uuid && athlete?.athlete_id).map((athlete) => [String(athlete.athlete_uuid), athlete]));
  const toEntry = (item) => {
    const row = roster.get(item.key);
    return row ? { key: String(row.athlete_id), name: item.name, imageUrl: item.imageUrl || "" } : null;
  };
  const model = centralCalendarK6Model(cal);
  const strip = (model.strip || []).filter((item) => roster.has(item.key));
  const inStrip = strip.some((item) => item.key === String(athleteUuid));
  const own = rosterAthletes().find((item) => item.key === String(athleteUuid));
  const athletes = (inStrip ? strip : own ? [own] : []).map(toEntry).filter(Boolean);
  const team = lineTeam(cal, model, String(athleteUuid));
  return { athletes, teamLabel: team ? centralCalendarTeamLabel(team) : "", context: "" };
}

// After every paint: the chosen pill in view inside its strip (F1).
export function revealCentralCalendarAthlete(root) {
  const box = root?.querySelector?.(".cc-k6");
  if (box) athleteSwitcherScrollIntoView(box);
}
