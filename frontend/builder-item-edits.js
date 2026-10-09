import { state } from "./state.js";

const pending = new Map();

export function rememberBuilderItemEdit(itemId, data) {
  const edit = { planId: state.builder.draft?.plan.id, data: { ...data } };
  pending.set(itemId, edit);
  preserveBuilderItemEdits(state.builder.draft);
  return edit;
}

export function pendingBuilderItemEdit(itemId) {
  const edit = pending.get(itemId);
  return edit?.planId === state.builder.draft?.plan.id ? edit : null;
}

export function acknowledgeBuilderItemEdit(itemId, edit) {
  if (pending.get(itemId) === edit) pending.delete(itemId);
}

export function clearBuilderItemEdits() { pending.clear(); }

export function preserveBuilderItemEdits(draft) {
  for (const block of draft?.blocks || []) {
    for (const session of block.sessions || []) {
      for (const node of session.nodes || []) {
        for (const item of node.items || []) {
          const edit = pending.get(item.id);
          if (edit?.planId === draft.plan.id) Object.assign(item, edit.data);
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
