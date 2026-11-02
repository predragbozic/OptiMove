// Who reads what of a GPEXE import candidate (phase 9, 9-B; contract J17
// section 6.1). Pure: no database. One audience per request, three levels,
// computed once by the route from its own access snapshot and passed down to
// every surface that returns a candidate or a part of its preview (the list,
// the detail, the approval's refusals, the batch results, the candidate read
// inside an approval's answer, and the list read again after a check):
//   * platform  - an active platform admin: the stored preview as it is;
//   * club_admin - the owning club's active admin in that club's workspace:
//     the precise codes, except the three source-instance codes, which read
//     as mapping_not_usable (no one but a platform admin learns that another
//     instance or holder exists);
//   * other     - everyone else (a coach, a granted coach): the blocking codes
//     replaced by one stable code and sentence, no activation, mapping
//     version or parameter fingerprint, no source reason, a club variable's
//     name only where C99 admits the viewer to it (R17), and of the source
//     fields only the count of those not switched on.
// A missing or unknown level is "other". The projection never writes: it
// returns a copy. The preview hash stays the one of the stored preview.
import { BLOCK_MESSAGES } from "./gpexeImportPreview.js";

export const IMPORT_AUDIENCES = Object.freeze(["platform", "club_admin", "other"]);
export function normalizeImportAudience(level) {
  return IMPORT_AUDIENCES.includes(level) ? level : "other";
}

// J17 section 6: the eight codes that block a whole candidate.
export const BLOCKING_CODES = Object.freeze(new Set([
  "mapping_not_usable", "source_threshold_contract_mismatch", "source_unit_mismatch", "source_shape_mismatch", "no_mapped_values",
  "source_instance_held", "source_instance_changed", "session_imported_under_another_instance",
]));
export const PLATFORM_ONLY_CODES = Object.freeze(new Set(["source_instance_held", "source_instance_changed", "session_imported_under_another_instance"]));
// The two Left-out reasons of C110: every level reads their plain words; the
// code itself is for the two administrators.
export const LEFT_OUT_ADMIN_CODES = Object.freeze(new Set(["required_value_missing", "canonical_value_out_of_range"]));
export const STABLE_CODE = "data_setup_incomplete";
export const COACH_SENTENCE = "This session can't be imported until an administrator finishes its data setup.";
export const CLUB_VARIABLE_LABEL = "Club variable";

const ADMIN_VALUE_FIELDS = ["activationId", "mappingVersionId", "sourceParameterFingerprint"];

function projectBlock(blocked, level) {
  if (!blocked || typeof blocked !== "object") return blocked;
  if (level === "platform") return blocked;
  if (level === "club_admin") {
    return PLATFORM_ONLY_CODES.has(blocked.code) ? { code: "mapping_not_usable", message: BLOCK_MESSAGES.mapping_not_usable } : blocked;
  }
  return BLOCKING_CODES.has(blocked.code) ? { code: STABLE_CODE, message: COACH_SENTENCE } : blocked;
}

// A candidate summary's blockedCode / blockedSourceCode (the list, the batch).
export function projectBlockedCodes(summary, level) {
  const l = normalizeImportAudience(level);
  const source = summary?.blockedSourceCode;
  if (l === "platform" || typeof source !== "string") return summary;
  if (l === "club_admin") return PLATFORM_ONLY_CODES.has(source) ? { ...summary, blockedSourceCode: "mapping_not_usable" } : summary;
  return BLOCKING_CODES.has(source) ? { ...summary, blockedSourceCode: STABLE_CODE } : summary;
}

function projectValue(v, level, namesClubVariables) {
  const out = { ...v };
  for (const field of ADMIN_VALUE_FIELDS) delete out[field];
  if (out.variableScope === "club" && !namesClubVariables) {
    out.label = CLUB_VARIABLE_LABEL;
    delete out.variableKey;
  }
  if (level === "other") {
    delete out.sourceReason;
    if (LEFT_OUT_ADMIN_CODES.has(out.reason)) delete out.reason;
  }
  return out;
}

// Whether a preview names a club variable anywhere (R17 is decided only then).
export function previewHasClubVariable(preview) {
  const has = (list) => Array.isArray(list) && list.some((v) => v?.variableScope === "club");
  return Boolean(preview && typeof preview === "object" && (
    (preview.athletes ?? []).some((a) => (a.results ?? []).some((r) => has(r.values)) || has(a.skippedValues))
    || (preview.changesToImported ?? []).some((c) => has(c.values))));
}

export function projectPreview(preview, level, { namesClubVariables = false } = {}) {
  const l = normalizeImportAudience(level);
  if (!preview || typeof preview !== "object" || l === "platform") return preview;
  const out = structuredClone(preview);
  out.blocked = projectBlock(out.blocked, l);
  if (l === "club_admin") return out;
  const values = (list) => (Array.isArray(list) ? list.map((v) => projectValue(v, l, namesClubVariables)) : list);
  for (const athlete of out.athletes ?? []) {
    for (const result of athlete.results ?? []) result.values = values(result.values);
    athlete.skippedValues = values(athlete.skippedValues);
  }
  for (const change of out.changesToImported ?? []) change.values = values(change.values);
  delete out.unmappedSourceFields;
  delete out.unactivatedSourceMetrics;
  return out;
}
