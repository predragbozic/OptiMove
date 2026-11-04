// What the metric pickers show of OptiMove's ready-made (system) variables once
// a club hides some (7i-B2, J15 8.2). The loaders keep every row, hidden ones
// included, so recorded results keep their names; only a picker's own render
// and selection leave a hidden row out. A club's variable of the same name as
// OptiMove's is told apart by "(OptiMove)" on OptiMove's row.
export const isHiddenInClub = (definition) => definition?.hiddenInClub === true;

// The rows a picker offers: not hidden by the club, unless already chosen (so a
// chosen one can still be seen and changed).
export function pickable(definitions, { chosen = [] } = {}) {
  const keep = new Set(chosen.filter(Boolean));
  return (definitions || []).filter((d) => !isHiddenInClub(d) || keep.has(d.id));
}

const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
export function pickerName(definition, all = []) {
  const label = definition?.label || "";
  if (definition?.ownerScope !== "system") return label;
  return all.some((other) => other.id !== definition.id && other.ownerScope && other.ownerScope !== "system" && sameName(other.label, label)) ? `${label} (OptiMove)` : label;
}
