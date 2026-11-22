// v87: the positions' clicks and forms (see positions-view.js). One write at a time; every write reads the list again.
import { loadPositions, sendPositionWrite } from "./positions-data.js";
import { state } from "./state.js";

function say(forWhat, message, ok = false) {
  state.positions.message = message;
  state.positions.messageFor = forWhat;
  state.positions.messageOk = ok;
}

async function write(forWhat, op, path, method, body, rerender) {
  const p = state.positions;
  if (p.busy) return null;
  p.busy = true;
  say(null, "");
  await rerender();
  let result;
  try {
    result = await sendPositionWrite(op, path, method, body);
    if (result.ok || result.code === "position_changed" || result.code === "name_changed") await loadPositions({ force: true });
    if (!result.ok) say(forWhat, result.message);
  } finally {
    p.busy = false;
  }
  await rerender();
  return result;
}

export async function handlePositionAction(action, { renderOrganizationPanel }) {
  const type = action.dataset.action;
  if (!type?.startsWith("positions-")) return false;
  const p = state.positions;
  const rerender = () => renderOrganizationPanel({ refresh: false });
  const id = action.dataset.positionId;
  if (type === "positions-toggle-add") {
    p.addOpen = !p.addOpen;
    say(null, "");
    await rerender();
  } else if (type === "positions-reload") {
    await loadPositions({ force: true });
    await rerender();
  } else if (type === "positions-rename") {
    p.renameId = id;
    say(null, "");
    await rerender();
  } else if (type === "positions-rename-cancel") {
    p.renameId = null;
    say(null, "");
    await rerender();
  } else if (type === "positions-archive" || type === "positions-restore") {
    const op = type === "positions-archive" ? "archive" : "restore";
    await write(`row:${id}`, `${op}:${id}`, `/api/positions/${encodeURIComponent(id)}/${op}`, "POST", {}, rerender);
  }
  return true;
}

export async function submitPositionForm(form, { renderOrganizationPanel }) {
  const kind = form.dataset.positionForm;
  const rerender = () => renderOrganizationPanel({ refresh: false });
  const p = state.positions;
  if (kind === "add") {
    const name = String(new FormData(form).get("name") ?? "").trim();
    const result = await write("add", `add:${name}`, "/api/positions", "POST", { name }, rerender);
    if (result?.ok) {
      p.addOpen = false;
      await rerender();
    }
    return true;
  }
  if (kind === "rename") {
    const id = form.dataset.positionId;
    const name = String(new FormData(form).get("name") ?? "").trim();
    const expectedName = form.dataset.positionExpected ?? "";
    const result = await write(`rename:${id}`, `rename:${id}:${name}`, `/api/positions/${encodeURIComponent(id)}/rename`, "POST", { name, expectedName }, rerender);
    if (result?.ok) {
      p.renameId = null;
      await rerender();
    }
    return true;
  }
  if (kind === "athlete") {
    const athleteId = form.dataset.athleteId;
    const positionId = String(new FormData(form).get("positionId") ?? "") || null;
    const expectedPositionId = form.dataset.positionExpected || null;
    const result = await write(`athlete:${athleteId}`, `athlete:${athleteId}:${positionId}:${expectedPositionId}`,
      `/api/positions/athletes/${encodeURIComponent(athleteId)}`, "PUT", { positionId, expectedPositionId }, rerender);
    if (result?.ok) {
      say(`athlete:${athleteId}`, "Position saved.", true);
      await rerender();
    }
    return true;
  }
  return false;
}
