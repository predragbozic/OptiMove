import { clean, countLabel, groupBy, orderedUnique } from "./utils.js";

export const typeLabels = {
  amPm: "AM/PM",
  bta: "Session",
  domain: "Domain",
  category: "Category",
  section: "Section",
  dayGroup: "Block",
  microcycle: "Microcycle",
  template: "Template",
};

export function createNode(type, label, items, options = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    typeLabel: typeLabels[type] || type,
    label: label || "Program",
    items: items || [],
    subtitle: options.subtitle || "",
    color: options.color || "",
    icon: options.icon || "",
    shortNote: options.shortNote || "",
    note: options.note || "",
    blockIndex: options.blockIndex || "",
  };
}

export function nextNodes(node, makeNode) {
  if (node.type === "amPm") return btaNodes(node.items, makeNode);
  if (node.type === "dayGroup") return sessionNodes(node.items, makeNode);
  if (node.type === "bta" || node.type === "session") return structureNodes(node.items, makeNode);
  if (node.type === "microcycle") return dayGroupNodesFromItems(node.items, makeNode);
  if (node.type === "domain") return categoryOrSectionNodes(node.items, makeNode);
  if (node.type === "category") return sectionOrExerciseNodes(node.items, makeNode);
  if (node.type === "section") return [];
  return structureNodes(node.items, makeNode);
}

function sessionTimeLabel(items) {
  const withTime = items.find((item) => item.sessionTime);
  return withTime ? withTime.sessionTime : "";
}

function sessionNameLabel(items) {
  const withName = items.find((item) => item.sessionName);
  return withName ? withName.sessionName : "";
}

// Combines a session's own custom name and its specific time (either may be
// absent) with the base AM/PM+training-phase label, in the same "name
// (badge)" convention already used for the cross-plan-copy picker's session
// list (builder-modals.js's pickerSessionLabel) - so the same session reads
// identically in Builder, the copy picker, and here.
function withSessionDetails(label, items) {
  const name = sessionNameLabel(items);
  const time = sessionTimeLabel(items);
  const withName = name ? `${name} (${label})` : label;
  return time ? `${time} · ${withName}` : withName;
}

export function btaNodes(items, makeNode) {
  const order = ["B", "T", "A", ""];
  const labels = { B: "Before training", T: "Training", A: "After training", "": "Session" };
  return order
    .map((keyValue) => {
      const filtered = items.filter((item) => (item.bta || "") === keyValue);
      if (!filtered.length) return null;
      return makeNode("bta", withSessionDetails(labels[keyValue], filtered), filtered, {
        subtitle: countLabel(filtered),
        color: keyValue === "B" ? "#487b65" : keyValue === "T" ? "#1f6f68" : keyValue === "A" ? "#9a6a3a" : "#667085",
      });
    })
    .filter(Boolean);
}

export function sessionNodes(items, makeNode) {
  const explicitItems = items.filter((item) => item.amPm === "AM" || item.amPm === "PM");
  const blankItems = items.filter((item) => item.amPm !== "AM" && item.amPm !== "PM");

  if (!explicitItems.length) {
    const nodes = btaNodes(items, makeNode);
    return nodes.length ? nodes : structureNodes(items, makeNode);
  }

  return [
    makeNode("amPm", "AM", explicitItems.filter((item) => item.amPm === "AM"), { color: "#2f6f8f" }),
    makeNode("amPm", "PM", explicitItems.filter((item) => item.amPm === "PM"), { color: "#6d5d9f" }),
    makeNode("session", withSessionDetails("Session", blankItems), blankItems, { subtitle: countLabel(blankItems), color: "#667085" }),
  ].filter((node) => node.items.length);
}

// Which structural level an item belongs at, for one grouping pass - the
// first level in `levels` (outermost first) the item actually has a real
// ancestor for, falling back to the last (most specific) level otherwise.
// Checked via *_node_id first (the real plan_nodes id, never just the
// snapshotted name - see groupNodes' own comment on why two same-named
// nodes must never merge), falling back to the name field only for rows
// that never got a node id at all.
function groupLevelForItem(item, levels) {
  return levels.find((level) => clean(item[`${level}_node_id`]) || clean(item[level])) || levels[levels.length - 1];
}

// Builds one level of the tree allowing a genuine MIX of levels among
// siblings - e.g. a category (with its own sections nested under it) sitting
// directly alongside a standalone section that has no category at all, both
// visible as their own top-level nodes in the same session/BTA group. The
// previous approach (one shared level for every item: domain, else
// category, else section - see the removed missingDomain/missingCategory
// checks) treated ANY item without a category as a signal to flatten
// EVERYTHING in the group to section level, silently dropping every
// category that DID exist alongside it - reported live: a "Morning
// activation" category's sections vanished from Weekly (though correctly
// shown in Builder) the moment a single standalone section shared its
// session. Each item is grouped by its own real *_node_id (never by name
// alone), and groups are emitted in first-occurrence order - since items
// already arrive sorted by their live hierarchy_sort_path (see
// migrations_v2/202608231000_weekly_plan_items_hierarchy_order.sql), that
// preserves Builder's exact ordering across the mixed levels for free.
function mixedStructureNodes(items, levels, makeNode) {
  const groups = new Map();
  const order = [];
  items.forEach((item) => {
    const level = groupLevelForItem(item, levels);
    const nodeId = clean(item[`${level}_node_id`]);
    const key = `${level}:${nodeId || `name:${clean(item[level]) || "GENERAL"}`}`;
    if (!groups.has(key)) {
      groups.set(key, { level, items: [] });
      order.push(key);
    }
    groups.get(key).items.push(item);
  });
  return order.map((key) => {
    const group = groups.get(key);
    const type = group.level;
    const meta = group.items.find(Boolean) || {};
    const label = clean(meta[type]) || "GENERAL";
    return makeNode(type, label, group.items, {
      subtitle: countLabel(group.items),
      color: meta[`${type}_color`] || "",
      icon: meta[`${type}_icon_url`] || "",
      shortNote: meta[`${type}_short_note`] || "",
      note: meta[`${type}_note`] || meta[`${type}_short_note`] || "",
    });
  });
}

export function structureNodes(items, makeNode) {
  return mixedStructureNodes(items, ["domain", "category", "section"], makeNode);
}

export function categoryOrSectionNodes(items, makeNode) {
  return mixedStructureNodes(items, ["category", "section"], makeNode);
}

export function sectionOrExerciseNodes(items, makeNode) {
  const sectionNames = orderedUnique(items, "section");
  if (sectionNames.length) return groupNodes(items, "section", makeNode);
  return [];
}

export function dayGroupNodesFromItems(items, makeNode) {
  const grouped = groupBy(items, (item) => item.dayNote || "Program");
  return grouped.map((group) => makeNode("dayGroup", group.label, group.items, { subtitle: countLabel(group.items) }));
}

export function groupNodes(items, type, makeNode) {
  // Group by the node's real id when the item carries one, not just its name --
  // two different nodes that happen to share a name (e.g. two sections both
  // named "Warming up") must stay separate instead of visually merging.
  return groupBy(items, (item) => item[`${type}_node_id`] || `name:${clean(item[type]) || "GENERAL"}`).map((group) => {
    const meta = group.items.find(Boolean) || {};
    const label = clean(meta[type]) || "GENERAL";
    return makeNode(type, label, group.items, {
      subtitle: countLabel(group.items),
      color: meta[`${type}_color`] || "",
      icon: meta[`${type}_icon_url`] || "",
      shortNote: meta[`${type}_short_note`] || "",
      note: meta[`${type}_note`] || meta[`${type}_short_note`] || "",
    });
  });
}
