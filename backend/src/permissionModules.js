// The licence hierarchy (P-4, the owner's decision of 2026-11-25; migration v96; docs/ai/roles-v-steps-plan.md 12.1).
// A closed parent module closes its children for the club as well; a child can still be closed on its own. One level
// only. Its own file so that authz.js (which builds each holding's closed modules) and permissions.js (can()) share it
// without importing each other. The database twin is public.permission_module_parent (v96), pinned equal by
// backend/tests/roles-v96-licence-hierarchy.test.mjs.
export const MODULE_PARENTS = Object.freeze({
  dashboards: "training_load",
  imports: "training_load",
  data_configuration: "training_load",
});

// The EFFECTIVE closed modules of a club from its stored ceiling rows: the rows themselves plus every child of a closed
// parent, sorted. The database twin is public.permission_club_module_closed (v96). Pure.
export function effectiveClosedModules(stored) {
  const closed = new Set((stored || []).map(String));
  for (const [child, parent] of Object.entries(MODULE_PARENTS)) if (closed.has(parent)) closed.add(child);
  return [...closed].sort();
}
