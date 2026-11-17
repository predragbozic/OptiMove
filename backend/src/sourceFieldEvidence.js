// G1 (docs/ai/gpexe-field-inventory-plan.md, section 8): which evidence statuses of a source revision (T2b) prove it.
// `verified` is proven by documents (M2b, C97); `source_stated` by the unit word the source sends, checked by a platform
// admin on the board (D-INV-2, route O). Both open a field for a mapping version and the board; nothing else does. The
// database's twins are v52's activation guard and v65's T9i guard as G1's migration (v74) replaces them.
export const PROVEN_STATUSES = Object.freeze(["verified", "source_stated"]);
const PROVEN = new Set(PROVEN_STATUSES);
export const statusProven = (status) => PROVEN.has(status);
// A revision whose unit may be shown and used: proven, with its unit set.
export const revisionProven = (revision) => Boolean(revision) && statusProven(revision.evidence_status) && revision.source_unit !== null && revision.source_unit !== undefined;
