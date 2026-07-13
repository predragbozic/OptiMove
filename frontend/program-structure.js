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

export function btaNodes(items, makeNode) {
  const order = ["B", "T", "A", ""];
  const labels = { B: "Before training", T: "Training", A: "After training", "": "Session" };
  return order
    .map((keyValue) => {
      const filtered = items.filter((item) => (item.bta || "") === keyValue);
      if (!filtered.length) return null;
      return makeNode("bta", labels[keyValue], filtered, {
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
    makeNode("session", "Session", blankItems, { subtitle: countLabel(blankItems), color: "#667085" }),
  ].filter((node) => node.items.length);
}

export function structureNodes(items, makeNode) {
  const domainNames = orderedUnique(items, "domain");
  const missingDomain = items.some((item) => !clean(item.domain));
  if (domainNames.length && !missingDomain) return groupNodes(items, "domain", makeNode);

  const categoryNames = orderedUnique(items, "category");
  const missingCategory = items.some((item) => !clean(item.category));
  if (categoryNames.length && !missingCategory) return groupNodes(items, "category", makeNode);

  const sectionNames = orderedUnique(items, "section");
  if (sectionNames.length) return groupNodes(items, "section", makeNode);

  return [];
}

export function categoryOrSectionNodes(items, makeNode) {
  const categoryNames = orderedUnique(items, "category");
  const missingCategory = items.some((item) => !clean(item.category));
  if (categoryNames.length && !missingCategory) return groupNodes(items, "category", makeNode);

  const sectionNames = orderedUnique(items, "section");
  if (sectionNames.length) return groupNodes(items, "section", makeNode);

  return [];
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
  return groupBy(items, (item) => clean(item[type]) || "GENERAL").map((group) => {
    const meta = group.items.find(Boolean) || {};
    return makeNode(type, group.label, group.items, {
      subtitle: countLabel(group.items),
      color: meta[`${type}_color`] || "",
      icon: meta[`${type}_icon_url`] || "",
      shortNote: meta[`${type}_short_note`] || "",
      note: meta[`${type}_note`] || meta[`${type}_short_note`] || "",
    });
  });
}
