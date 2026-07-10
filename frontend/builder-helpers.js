import { escapeAttr } from "./utils.js";

export function builderIconOptions() {
  return [
    ["icon:target", "Target"],
    ["icon:bolt", "Bolt"],
    ["icon:dumbbell", "Strength"],
    ["icon:calendar", "Calendar"],
    ["icon:heart", "Recovery"],
  ].map(([value, label]) => `<option value="${value}">${builderIconGlyph(value)} ${label}</option>`).join("");
}

export function builderIconGlyph(value) {
  return ({ "icon:target": "o", "icon:bolt": "*", "icon:dumbbell": "[]", "icon:calendar": "#", "icon:heart": "+" })[value] || "-";
}

export function canPasteNodeType(nodeType, parentType) {
  if (parentType === "session") return nodeType === "domain" || nodeType === "category" || nodeType === "section";
  if (parentType === "domain") return nodeType === "category" || nodeType === "section";
  return parentType === "category" && nodeType === "section";
}

export function nodeTypeOptions(parentType = "") {
  const allowed = parentType === "domain" ? ["category", "section"] : parentType === "category" ? ["section"] : parentType === "section" ? [] : ["domain", "category", "section"];
  return allowed.map((type) => `<option value="${type}">${exerciseNodeLabel(type)}</option>`).join("") || `<option value="section">Exercise section</option>`;
}

export function exerciseNodeLabel(type) {
  return ({ domain: "Exercise domain", category: "Exercise category", section: "Exercise section" })[type] || type;
}

export function builderNodeMarker(type) {
  const label = exerciseNodeLabel(type);
  return `<span class="builder-node-level builder-node-level-${escapeAttr(type)}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}"><i class="builder-pyramid-top ${type === "section" ? "is-active" : ""}"></i><i class="builder-pyramid-middle ${type === "category" ? "is-active" : ""}"></i><i class="builder-pyramid-base ${type === "domain" ? "is-active" : ""}"></i></span>`;
}

export function builderExerciseCountDots(count) {
  const total = Math.max(0, Number(count) || 0);
  return `<span class="builder-exercise-count" title="${total} exercise${total === 1 ? "" : "s"}" aria-label="${total} exercise${total === 1 ? "" : "s"}">${Array.from({ length: total }, () => "<i></i>").join("")}</span>`;
}

export function findBuilderSession(draft, id) {
  return (draft?.blocks || []).flatMap((block) => block.sessions).find((session) => session.id === id) || null;
}

export function findBuilderNode(draft, id) {
  return (draft?.blocks || []).flatMap((block) => block.sessions).flatMap((session) => session.nodes).find((node) => node.id === id) || null;
}

export function sessionLabel(session) {
  return [session.amPm, { B: "Before training", T: "Training", A: "After training" }[session.bta] || ""].filter(Boolean).join(" / ") || "Session";
}
