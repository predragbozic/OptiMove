import { planItemText } from "./exercise-text.js";
import { state } from "./state.js";

const pending = new Map();
// Items whose Instruction the coach has changed (owner, 2026-11-03). The field
// shows what the reader reads - the exercise's English for an English reader
// while the item still carries its exercise's text - so it goes back to the
// server only once it differs from what was shown; an unchanged one is left
// out of the save and the stored text stays as it is. Once changed, an item
// stays marked until the save that carries the change is answered.
const touchedText = new Set();

// A textarea or an attribute reads "\r\n" back as "\n" and a leading newline
// may be dropped, so line ends and outer whitespace do not count as a change.
const sameShownText = (a, b) => String(a ?? "").replace(/\r\n?/g, "\n").trim() === String(b ?? "").replace(/\r\n?/g, "\n").trim();

function draftItem(itemId) {
  for (const block of state.builder.draft?.blocks || []) {
    for (const session of block.sessions || []) {
      for (const node of session.nodes || []) {
        const item = (node.items || []).find((candidate) => candidate.id === itemId);
        if (item) return item;
      }
    }
  }
  return null;
}

export function withoutUntouchedText(itemId, data) {
  if (!Object.hasOwn(data, "description")) return { ...data };
  if (!touchedText.has(itemId)) {
    const item = draftItem(itemId);
    if (item && !sameShownText(data.description, planItemText(item, "description"))) touchedText.add(itemId);
  }
  if (touchedText.has(itemId)) return { ...data };
  const { description, ...rest } = data;
  return rest;
}

export function rememberBuilderItemEdit(itemId, data) {
  const edit = { planId: state.builder.draft?.plan.id, data: withoutUntouchedText(itemId, data) };
  pending.set(itemId, edit);
  preserveBuilderItemEdits(state.builder.draft);
  return edit;
}

export function pendingBuilderItemEdit(itemId) {
  const edit = pending.get(itemId);
  return edit?.planId === state.builder.draft?.plan.id ? edit : null;
}

// The newest edit saved (edit null: a save that had none waiting, with none
// waiting now): a changed Instruction is now the item's own text.
export function acknowledgeBuilderItemEdit(itemId, edit) {
  if ((pending.get(itemId) ?? null) !== (edit ?? null)) return;
  pending.delete(itemId);
  touchedText.delete(itemId);
}

export function clearBuilderItemEdits() {
  pending.clear();
  touchedText.clear();
}

export function preserveBuilderItemEdits(draft) {
  for (const block of draft?.blocks || []) {
    for (const session of block.sessions || []) {
      for (const node of session.nodes || []) {
        for (const item of node.items || []) {
          const edit = pending.get(item.id);
          if (edit?.planId !== draft.plan.id) continue;
          Object.assign(item, edit.data);
          // A changed Instruction is shown as typed, never the English.
          if (Object.hasOwn(edit.data, "description")) item.descriptionEn = null;
        }
        const move = state.builder.itemMovePending;
        if (move?.planId === draft.plan.id && move.nodeId === node.id) {
          const positions = new Map(move.itemIds.map((id, index) => [id, index]));
          node.items.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
        }
      }
    }
  }
  return draft;
}
