import { createHash } from "crypto";

const itemFields = [
  "date",
  "day_note",
  "session_order",
  "am_pm",
  "bta",
  "node_type",
  "node_name",
  "node_order",
  "item_type",
  "title",
  "description",
  "short_note",
  "note",
  "image_url",
  "video_url",
  "sets",
  "reps",
  "load",
  "item_order",
  "exercise_order",
  "source_row_ref",
  "domain_name",
  "category_name",
  "section_name",
  "domain_color",
  "category_color",
  "section_color",
  "domain_icon_url",
  "category_icon_url",
  "section_icon_url",
  "domain_short_note",
  "category_short_note",
  "section_short_note",
  "domain_note",
  "category_note",
  "section_note",
  "domain_order",
  "category_order",
  "section_order",
  "exercise_key_type",
  "exercise_key",
];

const countFields = ["days", "sessions", "sections", "exerciseItems", "noteItems", "totalItems"];

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function normalizedNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : String(value);
}

function sortKey(item) {
  return stableStringify([
    item.date ?? null,
    normalizedNumber(item.session_order),
    item.am_pm ?? null,
    item.bta ?? null,
    normalizedNumber(item.node_order),
    normalizedNumber(item.item_order),
    item.source_row_ref ?? null,
    item.exercise_key_type ?? null,
    item.exercise_key ?? null,
    item.title ?? null,
    item.description ?? null,
    item.note ?? null,
  ]);
}

export function canonicalizeLegacySignature(normalized) {
  return {
    counts: Object.fromEntries(countFields.map((field) => [field, normalized.counts?.[field] ?? 0])),
    items: (normalized.items || [])
      .map((item) => Object.fromEntries(itemFields.map((field) => [field, item[field] ?? null])))
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
  };
}

export function legacySignatureChecksum(normalized) {
  return createHash("sha256").update(stableStringify(canonicalizeLegacySignature(normalized)), "utf8").digest("hex");
}

export const legacySignatureItemFields = itemFields;
