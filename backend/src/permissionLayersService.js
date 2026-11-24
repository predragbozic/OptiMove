// The Roles R4-3 API (docs/ai/roles-r4-contract.md, section 9) over migration v92: the club's ceiling (the
// licence, set by a platform admin), the club's own versions of system roles, and the custom roles of one user bound
// to one holding. Mounted with the R2 routes (routes/permissionRoles.js) and written through R2's one write runner
// (permissionRolesService.js: requestKey replay, the bounded COMMIT verified by the request record, refusals as
// stable codes).
//
// Rules this module keeps (contract 7.6, 9, 10):
//   * 404 before anything else: a club, user, role or custom that does not exist, is of another club, is archived,
//     or that the caller has no right to see answers the identical 404 {"error":"notFound"}, decided from the
//     session's authorization context BEFORE the transaction (N5) - a caller without a right in a club never takes or
//     waits on that club's lock. A stable refusal code comes only after the caller's right there is proven again
//     under the locks;
//   * lock order: R2's request-key lock, then the club's ceiling lock (exclusive for the ceiling and every club
//     version write, shared for every custom write), then rows: the users rows (both in one statement for a write
//     that names another user), that user's holding row and custom rows, then public.lock_permission_actor (the
//     acting user's rows, the role rows - every system role FOR SHARE for a version writer - and the club's live
//     versions), then the clubs row FOR SHARE (a club archive waits), the request record last;
//   * a custom's holding_row_version is never carried through JavaScript: the insert copies it from the row in SQL
//     (a JavaScript Date loses the microseconds an equality compare needs); reads return it as text.
import { can, clubScope, ENFORCED_PERMISSIONS, PERMISSION_GROUPS, PERMISSIONS } from "./permissions.js";
import { lockClubCeiling } from "./clubCeilingLock.js";
import { customAliveSql, customsStillHolding, rolesInternals } from "./permissionRolesService.js";
import { pool } from "./db.js";

const {
  runWrite, boundedRead, refuse, NOT_FOUND, bad, requireUuid, requireText, requireWords, requestHashOf, isUuid,
  itemRuleRefusal, lockActor, holdsSql, lockedRole, scopeTypesOf, activeClub, isPlatform, CLUB_ADMIN_ROLE_ID,
  RULE7_REQUIRED, HONOURED,
} = rolesInternals;

const MODULES = new Set(PERMISSION_GROUPS.map((g) => g.key));
const CUSTOM_SCOPES = new Set(["club", "team"]);
const BASIC_HOLDING_SCOPE = Object.freeze({ club_admin: "club", team_coach: "team" });
const USERS_SQL = `select u.id from public.users u where u.id = any($1::uuid[]) order by u.id for share`;
const CLUB_ROW_SQL = `select coalesce(c.is_active, true) as active from public.clubs c where c.id = $1 for share`;
const STALE_END_REASON = "The holding this custom role was made on has ended.";
const MAX_WORD_REMOVAL = 200;

// Is a module effective for the ceiling yet (Q12): does any word of it act anywhere (ENFORCED_PERMISSIONS)?
const moduleEffective = (module) => Object.keys(ENFORCED_PERMISSIONS).some((w) => PERMISSIONS[w].module === module);

// ---------------------------------------------------------------------------
// The 404 gate before the transaction (contract 7.6, N5)
// ---------------------------------------------------------------------------
async function clubGate(ctx, clubIdRaw, want) {
  if (!isUuid(clubIdRaw)) throw NOT_FOUND();
  const clubId = await activeClub(String(clubIdRaw).toLowerCase());
  if (!clubId) throw NOT_FOUND();
  const platform = isPlatform(ctx);
  const scope = clubScope(clubId);
  const ok = platform
    || (want === "staff" && can(ctx.authz, "staff.assign", scope))
    || (want === "roles" && can(ctx.authz, "roles.manage", scope))
    || (want === "view" && (can(ctx.authz, "org.view", scope) || can(ctx.authz, "roles.manage", scope)));
  if (!ok) throw NOT_FOUND();
  return { clubId, platform };
}

// The same standing, evaluated again under the transaction (a replay included): the acting user's basis for `word`
// in the club, and the club still active. `platformOnly`: only a platform admin.
const standingIn = (ctx, word, { platformOnly = false } = {}) => async (client, clubId) => {
  if (!clubId) return false;
  const row = (await client.query(`select public.permission_actor_basis($1, $2, 'club', $3) as basis,
      exists (select 1 from public.clubs where id = $3 and coalesce(is_active, true)) as club_ok`, [ctx.userId, word, clubId])).rows[0];
  if (!row.club_ok) return false;
  return platformOnly ? row.basis === "platform_admin" : row.basis != null;
};
// Under the locks: the basis the request record will carry (the same derivation as its guard).
async function lockedBasis(client, ctx, word, clubId, { platformOnly = false } = {}) {
  const basis = (await client.query(`select public.permission_actor_basis($1, $2, 'club', $3) as basis`, [ctx.userId, word, clubId])).rows[0].basis;
  if (platformOnly ? basis !== "platform_admin" : basis == null) throw NOT_FOUND();
  return basis;
}
async function lockClubRow(client, clubId) {
  const row = (await client.query(CLUB_ROW_SQL, [clubId])).rows[0];
  if (!row || !row.active) throw NOT_FOUND();
}
const closedModulesOf = async (client, clubId) => (await client.query(`select public.permission_club_closed_modules($1) as m`, [clubId])).rows[0].m;
const optionalWords = (value, field) => (value === undefined || value === null ? [] : requireWords(value, field));

// The rules of a change of an item set (a club version or a custom role; contract 3.5), in the order of the refusals.
// `base`: the set before; returns the set after.
async function checkedItemChange(client, ctx, { basis, base, add, remove, basicKey, scopeTypes, clubId, closed }) {
  for (const w of add) if (base.includes(w)) throw bad("add names a permission the role already holds here.");
  for (const w of remove) if (!base.includes(w)) throw bad("remove names a permission the role does not hold here.");
  const ruled = itemRuleRefusal(add, { basicKey, scopeTypes });
  if (ruled) throw ruled;
  // O6: a word no route checks yet is never taken away either.
  const lockedOut = remove.filter((w) => !HONOURED.has(w));
  if (lockedOut.length) throw refuse("permission_not_available_yet", { words: lockedOut });
  const closedAdd = add.filter((w) => closed.includes(PERMISSIONS[w].module));
  if (closedAdd.length) throw refuse("closed_by_club_ceiling", { words: closedAdd });
  const next = [...base.filter((w) => !remove.includes(w)), ...add].sort();
  if (basicKey === "club_admin") {
    const lacking = RULE7_REQUIRED.filter((w) => !next.includes(w));
    if (lacking.length) throw refuse("club_admin_requires", { words: lacking });
  }
  // R2's dominance against the effective sets (the database repeats it at COMMIT): a club's admin holds every word of
  // the set after the change. A word of a closed module is held by nobody but a platform admin (step 6), so a set
  // that carries one is the licence's matter, named as such.
  if (basis !== "platform_admin") {
    const missing = [];
    for (const w of next) if (!(await holdsSql(client, ctx.userId, w, clubId))) missing.push(w);
    if (missing.length) {
      const closedMissing = missing.filter((w) => closed.includes(PERMISSIONS[w].module));
      if (closedMissing.length) throw refuse("closed_by_club_ceiling", { words: closedMissing });
      const notHeld = missing.filter((w) => add.includes(w));
      if (notHeld.length) throw refuse("permission_not_held", { words: notHeld });
      throw refuse("role_exceeds_your_permissions", { words: missing });
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// The ceiling (contract 7.1, 9)
// ---------------------------------------------------------------------------
async function ceilingView(client, clubId, platform) {
  const rows = (await client.query(`select m.word, m.label, c.closed_at, c.reason, c.closed_by_user_id
      from public.permission_modules m left join public.club_permission_ceiling c on c.club_id = $1 and c.module_word = m.word
     order by m.sort_order`, [clubId])).rows;
  const view = {
    clubId,
    modules: rows.map((r) => ({
      module: r.word, label: r.label, closed: r.closed_at != null, closedAt: r.closed_at, ceilingEffective: moduleEffective(r.word),
      ...(platform ? { reason: r.reason, closedBy: r.closed_by_user_id } : {}),
    })),
  };
  // The history of the licence: who and why is a platform admin's (as a system role's history, R2's S1).
  if (platform) {
    view.history = (await client.query(`select module_word, action, performed_by_user_id, reason, created_at
        from public.club_permission_ceiling_changes where club_id = $1 order by created_at desc, id limit 100`, [clubId])).rows
      .map((h) => ({ module: h.module_word, action: h.action, by: h.performed_by_user_id, reason: h.reason, at: h.created_at }));
  }
  return view;
}

export async function getCeiling(ctx, clubIdRaw) {
  const { clubId, platform } = await clubGate(ctx, clubIdRaw, "staff");
  return boundedRead((client) => ceilingView(client, clubId, platform));
}

function requireModules(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((m) => typeof m !== "string" || !MODULES.has(m))) throw bad(`${field} must be a list of parts of the app.`);
  if (new Set(value).size !== value.length) throw bad(`${field} names a part twice.`);
  return [...value].sort();
}

export async function setCeiling(ctx, clubIdRaw, body) {
  const { clubId } = await clubGate(ctx, clubIdRaw, "platform");
  const requestKey = requireUuid(body?.requestKey, "requestKey");
  const close = requireModules(body.close, "close");
  const open = requireModules(body.open, "open");
  const reason = requireText(body.reason, "reason", 500);
  if (!close.length && !open.length) throw bad("Nothing to change.");
  if (close.some((m) => open.includes(m))) throw bad("A part cannot be closed and opened at once.");
  if (close.includes("organization")) throw refuse("module_not_closable");
  const requestHash = requestHashOf("ceiling_change", { clubId, close, open, reason });
  const reread = async (client, rec) => ({ ...(await ceilingView(client, rec.ownerClubId ?? rec.owner_club_id, true)), ...(rec.extra || {}) });
  return runWrite(ctx, {
    operation: close.length ? "ceiling_close" : "ceiling_open", requestKey, requestHash,
    standingFor: standingIn(ctx, "staff.assign", { platformOnly: true }),
    reread,
    prepare: async (client) => {
      await lockClubCeiling(client, [clubId], "exclusive");
      await lockActor(client, ctx, { scopeType: "club", scopeId: clubId });
      const basis = await lockedBasis(client, ctx, "staff.assign", clubId, { platformOnly: true });
      await lockClubRow(client, clubId);
      const closedNow = await closedModulesOf(client, clubId);
      const toClose = close.filter((m) => !closedNow.includes(m));
      const toOpen = open.filter((m) => closedNow.includes(m));
      if (!toClose.length && !toOpen.length) throw refuse("ceiling_unchanged", { current: await ceilingView(client, clubId, true) });
      return { basis, toClose, toOpen };
    },
    write: async (client, p) => {
      let first = null;
      for (const m of p.toClose) {
        await client.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, $2, $3, $4)`, [clubId, m, ctx.userId, reason]);
        const id = (await client.query(`insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason)
            values ($1, $2, 'close', $3, $4) returning id`, [clubId, m, ctx.userId, reason])).rows[0].id;
        first ??= id;
      }
      for (const m of p.toOpen) {
        await client.query(`delete from public.club_permission_ceiling where club_id = $1 and module_word = $2`, [clubId, m]);
        const id = (await client.query(`insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason)
            values ($1, $2, 'open', $3, $4) returning id`, [clubId, m, ctx.userId, reason])).rows[0].id;
        first ??= id;
      }
      return { ceilingChangeId: first, ownerClubId: clubId, ids: { clubId }, extra: { closed: p.toClose, opened: p.toOpen } };
    },
  });
}

// ---------------------------------------------------------------------------
// A club's roles and the club versions (contract 3.3, 7.2, 9)
// ---------------------------------------------------------------------------
// What a default changed since the club's last answer: the role's change records after `answered`, folded in order.
async function defaultChangesSince(client, roleId, answered) {
  const rows = (await client.query(`select items_added, items_removed from public.permission_role_changes where role_id = $1 and revision_after > $2 order by revision_after`, [roleId, answered])).rows;
  const added = new Set();
  const removed = new Set();
  for (const r of rows) {
    for (const w of r.items_added) { if (removed.has(w)) removed.delete(w); else added.add(w); }
    for (const w of r.items_removed) { if (added.has(w)) added.delete(w); else removed.add(w); }
  }
  return { added: [...added].sort(), removed: [...removed].sort() };
}

const SYSTEM_ROLE_COLUMNS = `r.id, r.name, r.basic_key, r.revision, r.is_basic, r.owner_scope, r.owner_club_id, r.archived_at,
  r.assignable_club, r.assignable_team, r.assignable_private, r.assignable_global,
  array(select i.permission_word from public.permission_role_items i where i.role_id = r.id order by 1) as items`;

async function liveVersion(client, clubId, roleId) {
  return (await client.query(`select v.id, v.revision, v.based_on_revision, v.answered_revision,
        array(select i.permission_word from public.permission_club_role_version_items i where i.version_id = v.id order by 1) as items
      from public.permission_club_role_versions v where v.club_id = $1 and v.system_role_id = $2 and v.ended_at is null`, [clubId, roleId])).rows[0] || null;
}

async function clubRoleView(client, role, clubId, platform) {
  const v = await liveVersion(client, clubId, role.id);
  const pending = v != null && role.revision > v.answered_revision;
  const own = role.basic_key !== "club_admin" || platform;
  return {
    roleId: role.id, name: role.name, basicKey: role.basic_key, scopeTypes: scopeTypesOf(role),
    defaultRevision: role.revision, defaultItems: role.items,
    state: v == null ? "follows_default" : pending ? "question_pending" : "own_version",
    version: v && { id: v.id, revision: v.revision, basedOnRevision: v.based_on_revision, answeredRevision: v.answered_revision, items: v.items },
    effectiveItems: v ? v.items : role.items,
    question: pending ? { systemRevision: role.revision, defaultChanges: await defaultChangesSince(client, role.id, v.answered_revision) } : null,
    // Q3: only a platform admin changes Club admin in a club.
    actions: { change: own, answer: pending && own },
  };
}

export async function listClubRoles(ctx, clubIdRaw) {
  const { clubId, platform } = await clubGate(ctx, clubIdRaw, "view");
  return boundedRead(async (client) => {
    const system = (await client.query(`select ${SYSTEM_ROLE_COLUMNS} from public.permission_roles r
        where public.permission_versionable_role(r.id) order by r.is_basic desc, lower(r.name), r.id`)).rows;
    const roles = [];
    for (const r of system) roles.push(await clubRoleView(client, r, clubId, platform));
    const clubRoles = (await client.query(`select ${SYSTEM_ROLE_COLUMNS} from public.permission_roles r
        where r.owner_club_id = $1 and r.archived_at is null order by lower(r.name), r.id`, [clubId])).rows
      .map((r) => ({ roleId: r.id, name: r.name, revision: r.revision, scopeTypes: scopeTypesOf(r), items: r.items }));
    return { clubId, closedModules: await closedModulesOf(client, clubId), systemRoles: roles, clubRoles };
  });
}

// The system role of a version route: a versionable system role, else the identical 404.
async function versionGate(ctx, roleIdRaw, clubIdRaw) {
  const gate = await clubGate(ctx, clubIdRaw, "roles");
  if (!isUuid(roleIdRaw)) throw NOT_FOUND();
  const roleId = roleIdRaw.toLowerCase();
  const ok = (await pool.query(`select public.permission_versionable_role($1) as ok`, [roleId])).rows[0].ok;
  if (!ok) throw NOT_FOUND();
  return { ...gate, roleId };
}

const versionReread = (ctx) => async (client, rec) => {
  const changeId = rec.clubVersionChangeId ?? rec.club_version_change_id;
  const v = (await client.query(`select v.club_id, v.system_role_id from public.permission_club_role_version_changes c
      join public.permission_club_role_versions v on v.id = c.version_id where c.id = $1`, [changeId])).rows[0];
  if (!v) return null;
  const role = (await client.query(`select ${SYSTEM_ROLE_COLUMNS} from public.permission_roles r where r.id = $1`, [v.system_role_id])).rows[0];
  return { role: await clubRoleView(client, role, v.club_id, isPlatform(ctx)), ...(rec.extra || {}) };
};

// The locks of every club version write (contract 7.6): the club's lock EXCLUSIVE, then the acting user's rows with
// every non-archived system role row FOR SHARE and the club's live versions (H4), then the club row.
async function lockForVersion(client, ctx, clubId, roleId) {
  await lockClubCeiling(client, [clubId], "exclusive");
  await lockActor(client, ctx, { scopeType: "club", scopeId: clubId, roleForShare: roleId, allSystemRoles: true });
  const basis = await lockedBasis(client, ctx, "roles.manage", clubId);
  await lockClubRow(client, clubId);
  const role = await lockedRole(client, roleId);
  if (!role || role.archived_at || !(await client.query(`select public.permission_versionable_role($1) as ok`, [roleId])).rows[0].ok) throw NOT_FOUND();
  if (role.basic_key === "club_admin" && basis !== "platform_admin") throw refuse("admin_not_narrowable");
  return { basis, role };
}

export async function changeClubVersion(ctx, roleIdRaw, clubIdRaw, body) {
  const { clubId, roleId } = await versionGate(ctx, roleIdRaw, clubIdRaw);
  const requestKey = requireUuid(body?.requestKey, "requestKey");
  if (!Object.hasOwn(body, "expectedRevision")) throw bad("expectedRevision is required (null to make the club's version).");
  const expected = body.expectedRevision;
  if (expected !== null && (!Number.isInteger(expected) || expected < 1)) throw bad("expectedRevision must be a revision or null.");
  const add = optionalWords(body.add, "add");
  const remove = optionalWords(body.remove, "remove");
  const reason = requireText(body.reason, "reason", 500);
  if (!add.length && !remove.length) throw bad("Nothing to change.");
  if (add.some((w) => remove.includes(w))) throw bad("A permission cannot be added and removed at once.");
  const requestHash = requestHashOf("club_version_change", { clubId, roleId, expected, add, remove, reason });
  return runWrite(ctx, {
    operation: "club_version_change", requestKey, requestHash,
    standingFor: standingIn(ctx, "roles.manage"),
    reread: versionReread(ctx),
    prepare: async (client) => {
      const { basis, role } = await lockForVersion(client, ctx, clubId, roleId);
      const v = await liveVersion(client, clubId, roleId);
      if ((expected === null) !== (v == null) || (v && v.revision !== expected)) {
        throw refuse("version_changed", { current: await clubRoleView(client, role, clubId, basis === "platform_admin") });
      }
      const closed = await closedModulesOf(client, clubId);
      const next = await checkedItemChange(client, ctx, {
        basis, base: v ? v.items : role.items, add, remove, basicKey: role.basic_key, scopeTypes: scopeTypesOf(role), clubId, closed,
      });
      const stillHolding = await customsStillHolding(client, roleId, clubId, remove);
      return { basis, role, v, next, stillHolding };
    },
    write: async (client, p) => {
      let versionId;
      let revision;
      let itemsAdded;
      if (!p.v) {
        versionId = (await client.query(`insert into public.permission_club_role_versions (club_id, system_role_id, based_on_revision, answered_revision, created_by_user_id)
            values ($1, $2, $3, $3, $4) returning id`, [clubId, roleId, p.role.revision, ctx.userId])).rows[0].id;
        revision = 1;
        itemsAdded = p.next;
      } else {
        versionId = p.v.id;
        revision = p.v.revision + 1;
        itemsAdded = add;
        await client.query(`update public.permission_club_role_versions set revision = revision + 1 where id = $1`, [versionId]);
        for (const w of remove) await client.query(`delete from public.permission_club_role_version_items where version_id = $1 and permission_word = $2`, [versionId, w]);
      }
      for (const w of itemsAdded) await client.query(`insert into public.permission_club_role_version_items (version_id, permission_word) values ($1, $2)`, [versionId, w]);
      const clubVersionChangeId = (await client.query(`insert into public.permission_club_role_version_changes (version_id, revision_after, kind, performed_by_user_id, basis, reason, items_added, items_removed)
          values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [versionId, revision, p.v ? "change" : "create", ctx.userId, p.basis, reason, itemsAdded, p.v ? remove : []])).rows[0].id;
      return { clubVersionChangeId, ownerClubId: clubId, ids: { roleId, clubId }, extra: { customsStillHolding: p.stillHolding } };
    },
  });
}

export async function answerClubVersion(ctx, roleIdRaw, clubIdRaw, body) {
  const { clubId, roleId } = await versionGate(ctx, roleIdRaw, clubIdRaw);
  const requestKey = requireUuid(body?.requestKey, "requestKey");
  if (!Number.isInteger(body.systemRevision) || body.systemRevision < 1) throw bad("systemRevision must be a revision.");
  if (body.choice !== "accept_default" && body.choice !== "keep_mine") throw bad("choice is accept_default or keep_mine.");
  const { systemRevision, choice } = body;
  const requestHash = requestHashOf("club_version_answer", { clubId, roleId, systemRevision, choice });
  return runWrite(ctx, {
    operation: "club_version_answer", requestKey, requestHash,
    standingFor: standingIn(ctx, "roles.manage"),
    reread: versionReread(ctx),
    prepare: async (client) => {
      const { basis, role } = await lockForVersion(client, ctx, clubId, roleId);
      const v = await liveVersion(client, clubId, roleId);
      if (!v || role.revision !== systemRevision || role.revision <= v.answered_revision) {
        throw refuse("question_outdated", { current: await clubRoleView(client, role, clubId, basis === "platform_admin") });
      }
      // The database checks at COMMIT that a club's admin holds every word of a version it writes (an ended one
      // included); a word of a closed module is the licence's matter.
      if (basis !== "platform_admin") {
        const closed = await closedModulesOf(client, clubId);
        const missing = [];
        for (const w of v.items) if (!(await holdsSql(client, ctx.userId, w, clubId))) missing.push(w);
        const closedMissing = missing.filter((w) => closed.includes(PERMISSIONS[w].module));
        if (closedMissing.length) throw refuse("closed_by_club_ceiling", { words: closedMissing });
        if (missing.length) throw refuse("role_exceeds_your_permissions", { words: missing });
      }
      return { basis, role, v };
    },
    write: async (client, p) => {
      if (choice === "keep_mine") {
        await client.query(`update public.permission_club_role_versions set revision = revision + 1, answered_revision = $2 where id = $1`, [p.v.id, p.role.revision]);
      } else {
        await client.query(`update public.permission_club_role_versions set revision = revision + 1, ended_at = now(), ended_by_user_id = $2, end_kind = 'accepted_default' where id = $1`, [p.v.id, ctx.userId]);
      }
      const clubVersionChangeId = (await client.query(`insert into public.permission_club_role_version_changes (version_id, revision_after, kind, performed_by_user_id, basis)
          values ($1, $2, $3, $4, $5) returning id`, [p.v.id, p.v.revision + 1, choice === "keep_mine" ? "answer_keep" : "accept_default", ctx.userId, p.basis])).rows[0].id;
      return { clubVersionChangeId, ownerClubId: clubId, ids: { roleId, clubId } };
    },
  });
}

// ---------------------------------------------------------------------------
// Custom roles (contract 3.4, 7.3, 9)
// ---------------------------------------------------------------------------
async function customView(client, customId) {
  const c = (await client.query(`select c.id, c.user_id, c.base_role_id, r.name as role_name, c.scope_type, c.scope_id, c.club_id,
        c.holding_assignment_id, c.holding_row_table, c.holding_row_id, c.holding_row_version::text as holding_row_version,
        c.frozen_from, c.frozen_from_revision, c.frozen_from_version_id, c.revision, c.created_at, c.ended_at, c.end_kind,
        ${customAliveSql("c")} as live,
        array(select i.permission_word from public.permission_custom_role_items i where i.custom_role_id = c.id order by 1) as items,
        public.permission_role_club_items(c.base_role_id, c.club_id) as role_items
      from public.permission_custom_roles c join public.permission_roles r on r.id = c.base_role_id where c.id = $1`, [customId])).rows[0];
  if (!c) return null;
  return {
    id: c.id, userId: c.user_id, roleId: c.base_role_id, name: `${c.role_name} (custom)`, scopeType: c.scope_type, scopeId: c.scope_id,
    clubId: c.club_id, revision: c.revision, live: c.live, endedAt: c.ended_at, endKind: c.end_kind,
    holding: c.holding_assignment_id ? { assignmentId: c.holding_assignment_id }
      : { table: c.holding_row_table, rowId: c.holding_row_id, rowVersion: c.holding_row_version },
    frozenFrom: { kind: c.frozen_from, revision: c.frozen_from_revision, versionId: c.frozen_from_version_id },
    items: c.items,
    // The difference from the role as it is in the club now (club version or default).
    added: c.items.filter((w) => !c.role_items.includes(w)),
    removed: c.role_items.filter((w) => !c.items.includes(w)),
  };
}

// Q14: the removed words of a custom that the user still holds through another holding in that scope.
function stillHeldThrough(holdings, holding, removed, closed, roleNames) {
  const out = [];
  for (const w of removed) {
    if (closed.includes(PERMISSIONS[w].module)) continue;
    const through = holdings.filter((h) => h !== holding && h.words.includes(w)
      && ((h.scope_type === holding.scope_type && String(h.scope_id) === String(holding.scope_id))
        || (CUSTOM_SCOPES.has(holding.scope_type) && h.scope_type === "club" && String(h.scope_id) === String(holding.club_id))))
      .map((h) => roleNames.get(String(h.role_id)));
    if (through.length) out.push({ word: w, roles: [...new Set(through)].sort() });
  }
  return out;
}

async function userInClubView(client, userId, clubId) {
  const user = (await client.query(`select id, display_name from public.users where id = $1`, [userId])).rows[0];
  if (!user) return null;
  const holdings = (await client.query(`select h.* from public.permission_user_holdings($1) h where h.club_id = $2 order by h.scope_type, h.scope_id, h.role_id`, [userId, clubId])).rows;
  if (!holdings.length) return null;
  const closed = await closedModulesOf(client, clubId);
  const roleNames = new Map((await client.query(`select id, name from public.permission_roles where id = any($1::uuid[])`, [holdings.map((h) => h.role_id)])).rows.map((r) => [String(r.id), r.name]));
  const out = [];
  for (const h of holdings) {
    const roleItems = (await client.query(`select public.permission_role_club_items($1, $2) as w`, [h.role_id, clubId])).rows[0].w;
    const custom = h.custom_role_id ? await customView(client, h.custom_role_id) : null;
    out.push({
      roleId: h.role_id, roleName: roleNames.get(String(h.role_id)), displayName: custom ? custom.name : roleNames.get(String(h.role_id)),
      scopeType: h.scope_type, scopeId: h.scope_id, source: h.assignment_id ? "assignment" : "basic", assignmentId: h.assignment_id, expiresAt: h.expires_at,
      roleItems, effectiveItems: h.words.filter((w) => !closed.includes(PERMISSIONS[w].module)).sort(), custom,
      stillHeldThrough: custom ? stillHeldThrough(holdings, h, custom.removed, closed, roleNames) : [],
    });
  }
  const history = (await client.query(`select c.id from public.permission_custom_roles c where c.user_id = $1 and c.club_id = $2 and not ${customAliveSql("c")}
      order by c.created_at desc, c.id limit 50`, [userId, clubId])).rows;
  const ended = [];
  for (const r of history) ended.push(await customView(client, r.id));
  return { userId, name: user.display_name, clubId, closedModules: closed, holdings: out, customHistory: ended };
}

export async function getUserInClub(ctx, userIdRaw, clubIdRaw) {
  const { clubId } = await clubGate(ctx, clubIdRaw, "staff");
  if (!isUuid(userIdRaw)) throw NOT_FOUND();
  const userId = userIdRaw.toLowerCase();
  const view = await boundedRead((client) => userInClubView(client, userId, clubId));
  if (!view) throw NOT_FOUND();
  return view;
}

// The target's live holdings of the role in exactly that scope, locked FOR SHARE (contract 7.6 place 2).
async function lockHoldings(client, userId, role, scopeType, scopeId) {
  const basicScope = BASIC_HOLDING_SCOPE[role.basic_key];
  if (role.basic_key === "club_admin") {
    if (basicScope !== scopeType) return [];
    return (await client.query(`select r.id from public.user_club_roles r where r.user_id = $1 and r.club_id = $2 and r.role = 'club_admin' and r.is_active order by r.id for share`, [userId, scopeId])).rows
      .map((r) => ({ table: "user_club_roles", id: r.id }));
  }
  if (role.basic_key === "team_coach") {
    if (basicScope !== scopeType) return [];
    return (await client.query(`select r.id from public.user_team_roles r where r.user_id = $1 and r.team_id = $2 and r.role = 'team_coach' and r.is_active order by r.id for share`, [userId, scopeId])).rows
      .map((r) => ({ table: "user_team_roles", id: r.id }));
  }
  return (await client.query(`select a.id from public.user_role_assignments a
      where a.user_id = $1 and a.role_id = $2 and a.scope_type = $3 and a.scope_id = $4 and a.revoked_at is null
        and (a.expires_at is null or a.expires_at > now()) order by a.id for share`, [userId, role.id, scopeType, scopeId])).rows
    .map((r) => ({ assignmentId: r.id }));
}

// Does the user hold the Club admin role in the club (an old row)? O5: a club's admin never narrows another admin.
const holdsClubAdmin = async (client, userId, clubId) => (await client.query(`select 1 from public.user_club_roles
    where user_id = $1 and club_id = $2 and role = 'club_admin' and is_active`, [userId, clubId])).rowCount > 0;

const customReread = async (client, rec) => {
  let id = rec.customId;
  if (!id) id = (await client.query(`select custom_role_id from public.permission_custom_role_changes where id = $1`, [rec.custom_role_change_id])).rows[0]?.custom_role_id;
  if (!id) return null;
  const custom = await customView(client, id);
  return custom ? { custom, ...(rec.extra || {}) } : null;
};

// The end of a custom by a person (back to the club's role, or a stale custom whose holding ended), with its record.
async function endCustomRow(client, ctx, basis, custom, endKind, reason) {
  await client.query(`update public.permission_custom_roles set revision = revision + 1, ended_at = now(), ended_by_user_id = $2, end_kind = $3 where id = $1`, [custom.id, ctx.userId, endKind]);
  return (await client.query(`insert into public.permission_custom_role_changes (custom_role_id, revision_after, kind, performed_by_user_id, basis, reason)
      values ($1, $2, 'end', $3, $4, $5) returning id`, [custom.id, custom.revision + 1, ctx.userId, basis, reason])).rows[0].id;
}

export async function changeCustom(ctx, userIdRaw, clubIdRaw, body) {
  const { clubId } = await clubGate(ctx, clubIdRaw, "staff");
  if (!isUuid(userIdRaw)) throw NOT_FOUND();
  const userId = userIdRaw.toLowerCase();
  const roleId = requireUuid(body?.roleId, "roleId");
  if (!CUSTOM_SCOPES.has(body.scopeType)) throw bad("scopeType must be club or team.");
  const scopeType = body.scopeType;
  const scopeId = requireUuid(body.scopeId, "scopeId");
  const requestKey = requireUuid(body.requestKey, "requestKey");
  if (!Object.hasOwn(body, "expectedRevision")) throw bad("expectedRevision is required (null to make the custom role).");
  const expected = body.expectedRevision;
  if (expected !== null && (!Number.isInteger(expected) || expected < 1)) throw bad("expectedRevision must be a revision or null.");
  const add = optionalWords(body.add, "add");
  const remove = optionalWords(body.remove, "remove");
  const reason = requireText(body.reason, "reason", 500);
  if (!add.length && !remove.length) throw bad("Nothing to change.");
  if (add.some((w) => remove.includes(w))) throw bad("A permission cannot be added and removed at once.");
  // The scope lies in the club, the user and the role exist: else the identical 404 (another club's team or role,
  // a random id). Read without a lock; checked again under the locks.
  const scopeClub = scopeType === "club" ? scopeId : (await pool.query(`select club_id from public.teams where id = $1 and coalesce(is_active, true)`, [scopeId])).rows[0]?.club_id;
  if (!scopeClub || String(scopeClub) !== clubId) throw NOT_FOUND();
  const role = (await pool.query(`select owner_scope, owner_club_id from public.permission_roles where id = $1 and archived_at is null`, [roleId])).rows[0];
  if (!role || (role.owner_scope === "club" && String(role.owner_club_id) !== clubId)) throw NOT_FOUND();
  if (!(await pool.query(`select 1 from public.users where id = $1`, [userId])).rowCount) throw NOT_FOUND();
  if (userId === String(ctx.userId).toLowerCase()) throw refuse("self_custom");
  const requestHash = requestHashOf("custom_change", { clubId, userId, roleId, scopeType, scopeId, expected, add, remove, reason });
  return runWrite(ctx, {
    operation: "custom_change", requestKey, requestHash,
    standingFor: standingIn(ctx, "staff.assign"),
    reread: customReread,
    prepare: async (client) => {
      // Place 0: the club's lock, shared. Place 1: both users rows, one statement, id order.
      await lockClubCeiling(client, [clubId], "shared");
      await client.query(USERS_SQL, [[String(ctx.userId).toLowerCase(), userId]]);
      const r = await lockedRole(client, roleId);
      if (!r || r.archived_at) throw NOT_FOUND();
      // Place 2: the target's holding rows; place 3: the target's live customs of that key.
      const holdings = await lockHoldings(client, userId, r, scopeType, scopeId);
      const customs = (await client.query(`select c.id, c.revision, ${customAliveSql("c")} as live from public.permission_custom_roles c
          where c.user_id = $1 and c.base_role_id = $2 and c.scope_type = $3 and c.scope_id = $4 and c.ended_at is null order by c.id for update`,
      [userId, roleId, scopeType, scopeId])).rows;
      // Then the acting user's rows, the role rows and the club's versions; the club row.
      await lockActor(client, ctx, { scopeType, scopeId, roleForShare: roleId });
      const basis = await lockedBasis(client, ctx, "staff.assign", clubId);
      await lockClubRow(client, clubId);
      if (scopeType === "team" && !(await client.query(`select 1 from public.teams where id = $1 and coalesce(is_active, true)`, [scopeId])).rowCount) throw NOT_FOUND();
      const target = (await client.query(`select is_active from public.users where id = $1`, [userId])).rows[0];
      // Section 10: a custom of a role the user no longer holds (revoked meanwhile) is refused as not found.
      if (!target?.is_active || !holdings.length || r.basic_key === "platform_admin" || r.basic_key === "independent_coach") throw NOT_FOUND();
      if (holdings.length > 1) throw refuse("holding_ambiguous");
      // O5 and Q13: only a platform admin narrows an admin (the Club admin role, or any role of a club admin).
      if (basis !== "platform_admin" && (r.basic_key === "club_admin" || (await holdsClubAdmin(client, userId, clubId)))) throw refuse("admin_not_narrowable");
      const live = customs.find((c) => c.live) || null;
      const stale = customs.filter((c) => !c.live);
      if ((expected === null) !== (live == null) || (live && live.revision !== expected)) {
        throw refuse(expected === null ? "custom_exists" : "custom_changed", { current: live ? await customView(client, live.id) : null });
      }
      let base;
      let frozen = null;
      if (live) base = (await customView(client, live.id)).items;
      else {
        const v = r.owner_scope === "system" ? await liveVersion(client, clubId, roleId) : null;
        base = v ? v.items : r.items;
        frozen = v ? { kind: "club_version", revision: v.revision, versionId: v.id }
          : { kind: r.owner_scope === "club" ? "club_role" : "default", revision: r.revision, versionId: null };
      }
      const closed = await closedModulesOf(client, clubId);
      const next = await checkedItemChange(client, ctx, { basis, base, add, remove, basicKey: r.basic_key, scopeTypes: [scopeType], clubId, closed });
      return { basis, role: r, holding: holdings[0], live, stale, base, next, frozen, closed };
    },
    write: async (client, p) => {
      // A custom whose holding ended still holds the live key: its end is written first (contract 3.4).
      for (const s of p.stale) await endCustomRow(client, ctx, p.basis, s, "reset", STALE_END_REASON);
      let customId;
      let revision;
      let itemsAdded;
      if (!p.live) {
        const f = p.frozen;
        const common = [userId, roleId, scopeType, scopeId, clubId, f.kind, f.revision, f.versionId, ctx.userId];
        if (p.holding.assignmentId) {
          customId = (await client.query(`insert into public.permission_custom_roles (user_id, base_role_id, scope_type, scope_id, club_id, frozen_from, frozen_from_revision,
              frozen_from_version_id, created_by_user_id, holding_assignment_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
          [...common, p.holding.assignmentId])).rows[0].id;
        } else if (p.holding.table === "user_club_roles") {
          // holding_row_version is copied from the row in SQL (never through a JavaScript Date).
          customId = (await client.query(`insert into public.permission_custom_roles (user_id, base_role_id, scope_type, scope_id, club_id, frozen_from, frozen_from_revision,
              frozen_from_version_id, created_by_user_id, holding_row_table, holding_row_id, holding_row_version)
            select $1, $2, $3, $4, $5, $6, $7, $8, $9, 'user_club_roles', h.id, h.updated_at from public.user_club_roles h where h.id = $10 returning id`,
          [...common, p.holding.id])).rows[0].id;
        } else {
          customId = (await client.query(`insert into public.permission_custom_roles (user_id, base_role_id, scope_type, scope_id, club_id, frozen_from, frozen_from_revision,
              frozen_from_version_id, created_by_user_id, holding_row_table, holding_row_id, holding_row_version)
            select $1, $2, $3, $4, $5, $6, $7, $8, $9, 'user_team_roles', h.id, h.updated_at from public.user_team_roles h where h.id = $10 returning id`,
          [...common, p.holding.id])).rows[0].id;
        }
        revision = 1;
        itemsAdded = p.next;
      } else {
        customId = p.live.id;
        revision = p.live.revision + 1;
        itemsAdded = add;
        await client.query(`update public.permission_custom_roles set revision = revision + 1 where id = $1`, [customId]);
        for (const w of remove) await client.query(`delete from public.permission_custom_role_items where custom_role_id = $1 and permission_word = $2`, [customId, w]);
      }
      for (const w of itemsAdded) await client.query(`insert into public.permission_custom_role_items (custom_role_id, permission_word) values ($1, $2)`, [customId, w]);
      const customRoleChangeId = (await client.query(`insert into public.permission_custom_role_changes (custom_role_id, revision_after, kind, performed_by_user_id, basis, reason, items_added, items_removed)
          values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [customId, revision, p.live ? "change" : "create", ctx.userId, p.basis, reason, itemsAdded, p.live ? remove : []])).rows[0].id;
      const holdings = (await client.query(`select h.* from public.permission_user_holdings($1) h where h.club_id = $2`, [userId, clubId])).rows;
      const own = holdings.find((h) => String(h.custom_role_id) === String(customId));
      const removedNow = (await customView(client, customId)).removed;
      const names = new Map((await client.query(`select id, name from public.permission_roles where id = any($1::uuid[])`, [holdings.map((h) => h.role_id)])).rows.map((x) => [String(x.id), x.name]));
      const through = own ? stillHeldThrough(holdings, own, removedNow, p.closed, names) : [];
      return { customRoleChangeId, customId, ownerClubId: clubId, ids: { customId }, extra: { stillHeldThrough: through } };
    },
  });
}

export async function endCustom(ctx, userIdRaw, customIdRaw, body) {
  if (!isUuid(userIdRaw) || !isUuid(customIdRaw)) throw NOT_FOUND();
  const userId = userIdRaw.toLowerCase();
  const customId = customIdRaw.toLowerCase();
  const found = (await pool.query(`select user_id, club_id, scope_type, scope_id, base_role_id from public.permission_custom_roles where id = $1`, [customId])).rows[0];
  if (!found || String(found.user_id) !== userId) throw NOT_FOUND();
  const { clubId } = await clubGate(ctx, found.club_id, "staff");
  const requestKey = requireUuid(body?.requestKey, "requestKey");
  const reason = requireText(body.reason, "reason", 500);
  const requestHash = requestHashOf("custom_end", { customId, userId, reason });
  return runWrite(ctx, {
    operation: "custom_end", requestKey, requestHash,
    standingFor: standingIn(ctx, "staff.assign"),
    reread: customReread,
    prepare: async (client) => {
      await lockClubCeiling(client, [clubId], "shared");
      await client.query(USERS_SQL, [[String(ctx.userId).toLowerCase(), userId]]);
      const c = (await client.query(`select id, revision, ended_at, base_role_id from public.permission_custom_roles where id = $1 for update`, [customId])).rows[0];
      await lockActor(client, ctx, { scopeType: found.scope_type, scopeId: found.scope_id, roleForShare: found.base_role_id });
      const basis = await lockedBasis(client, ctx, "staff.assign", clubId);
      await lockClubRow(client, clubId);
      if (c.ended_at) throw refuse("custom_changed", { current: await customView(client, customId) });
      const baseKey = (await client.query(`select basic_key from public.permission_roles where id = $1`, [c.base_role_id])).rows[0].basic_key;
      if (basis !== "platform_admin" && (baseKey === "club_admin" || (await holdsClubAdmin(client, userId, clubId)))) throw refuse("admin_not_narrowable");
      return { basis, c };
    },
    write: async (client, p) => {
      const customRoleChangeId = await endCustomRow(client, ctx, p.basis, p.c, "reassigned", reason);
      return { customRoleChangeId, customId, ownerClubId: clubId, ids: { customId } };
    },
  });
}

// ---------------------------------------------------------------------------
// Drift and "Take it from them too" (Q15)
// ---------------------------------------------------------------------------
export async function getCustomDrift(ctx, clubIdRaw) {
  const { clubId } = await clubGate(ctx, clubIdRaw, "staff");
  return boundedRead(async (client) => {
    const rows = (await client.query(`select c.id, c.user_id, u.display_name, c.base_role_id, r.name as role_name, c.scope_type, c.scope_id,
          array(select i.permission_word from public.permission_custom_role_items i
                 where i.custom_role_id = c.id and not (i.permission_word = any(public.permission_role_club_items(c.base_role_id, c.club_id))) order by 1) as words
        from public.permission_custom_roles c join public.users u on u.id = c.user_id join public.permission_roles r on r.id = c.base_role_id
       where c.club_id = $1 and ${customAliveSql("c")}
       order by lower(r.name), lower(u.display_name), c.id`, [clubId])).rows;
    return {
      clubId,
      customs: rows.filter((r) => r.words.length).map((r) => ({
        customId: r.id, userId: r.user_id, name: r.display_name, roleId: r.base_role_id, roleName: r.role_name,
        scopeType: r.scope_type, scopeId: r.scope_id, words: r.words,
      })),
    };
  });
}

export async function removeWordFromCustoms(ctx, roleIdRaw, clubIdRaw, body) {
  const { clubId } = await clubGate(ctx, clubIdRaw, "staff");
  if (!isUuid(roleIdRaw)) throw NOT_FOUND();
  const roleId = roleIdRaw.toLowerCase();
  const role = (await pool.query(`select owner_scope, owner_club_id from public.permission_roles where id = $1`, [roleId])).rows[0];
  if (!role || (role.owner_scope === "club" && String(role.owner_club_id) !== clubId)) throw NOT_FOUND();
  const requestKey = requireUuid(body?.requestKey, "requestKey");
  if (typeof body.word !== "string" || !Object.hasOwn(PERMISSIONS, body.word)) throw bad("word must be a permission.");
  const word = body.word;
  if (!Array.isArray(body.customIds) || !body.customIds.length || body.customIds.length > MAX_WORD_REMOVAL) throw bad(`customIds must list 1 to ${MAX_WORD_REMOVAL} custom roles.`);
  const customIds = [...new Set(body.customIds.map((id) => requireUuid(id, "customIds")))].sort();
  if (customIds.length !== body.customIds.length) throw bad("customIds names a custom role twice.");
  const reason = requireText(body.reason, "reason", 500);
  // Every named custom is of this role in this club, else the identical 404 (another club's custom, a random id).
  const found = (await pool.query(`select id, user_id from public.permission_custom_roles where id = any($1::uuid[]) and club_id = $2 and base_role_id = $3`, [customIds, clubId, roleId])).rows;
  if (found.length !== customIds.length) throw NOT_FOUND();
  if (!HONOURED.has(word)) throw refuse("permission_not_available_yet", { words: [word] });
  const users = [...new Set(found.map((f) => String(f.user_id)))];
  const requestHash = requestHashOf("custom_word_removal", { clubId, roleId, word, customIds, reason });
  return runWrite(ctx, {
    operation: "custom_word_removal", requestKey, requestHash,
    standingFor: standingIn(ctx, "staff.assign"),
    reread: async (client, rec) => {
      const changeId = rec.customRoleChangeId ?? rec.custom_role_change_id;
      const ids = (await client.query(`select x.custom_role_id from public.permission_custom_role_changes x
          where x.xmin = (select y.xmin from public.permission_custom_role_changes y where y.id = $1) and x.kind = 'word_removal' order by 1`, [changeId])).rows;
      const customs = [];
      for (const r of ids) customs.push(await customView(client, r.custom_role_id));
      return { customs };
    },
    prepare: async (client) => {
      await lockClubCeiling(client, [clubId], "shared");
      await client.query(USERS_SQL, [[String(ctx.userId).toLowerCase(), ...users]]);
      const rows = (await client.query(`select c.id, c.user_id, c.revision, c.base_role_id, ${customAliveSql("c")} as live,
            exists (select 1 from public.permission_custom_role_items i where i.custom_role_id = c.id and i.permission_word = $2) as holds,
            array(select i.permission_word from public.permission_custom_role_items i where i.custom_role_id = c.id order by 1) as items
          from public.permission_custom_roles c where c.id = any($1::uuid[]) order by c.id for update`, [customIds, word])).rows;
      await lockActor(client, ctx, { scopeType: "club", scopeId: clubId, roleForShare: roleId });
      const basis = await lockedBasis(client, ctx, "staff.assign", clubId);
      await lockClubRow(client, clubId);
      const r = await lockedRole(client, roleId);
      const changed = rows.filter((c) => !c.live || !c.holds).map((c) => c.id);
      if (changed.length) throw refuse("custom_changed", { customIds: changed });
      if (basis !== "platform_admin") {
        if (r.basic_key === "club_admin") throw refuse("admin_not_narrowable");
        for (const c of rows) if (await holdsClubAdmin(client, c.user_id, clubId)) throw refuse("admin_not_narrowable", { customIds: [c.id] });
        // The database repeats R2's dominance at COMMIT: the acting admin holds every word left in each custom.
        const closed = await closedModulesOf(client, clubId);
        const missing = new Set();
        for (const c of rows) for (const w of c.items) if (w !== word && !(await holdsSql(client, ctx.userId, w, clubId))) missing.add(w);
        const closedMissing = [...missing].filter((w) => closed.includes(PERMISSIONS[w].module));
        if (closedMissing.length) throw refuse("closed_by_club_ceiling", { words: closedMissing.sort() });
        if (missing.size) throw refuse("role_exceeds_your_permissions", { words: [...missing].sort() });
      }
      return { basis, rows };
    },
    write: async (client, p) => {
      let first = null;
      for (const c of p.rows) {
        await client.query(`update public.permission_custom_roles set revision = revision + 1 where id = $1`, [c.id]);
        await client.query(`delete from public.permission_custom_role_items where custom_role_id = $1 and permission_word = $2`, [c.id, word]);
        const id = (await client.query(`insert into public.permission_custom_role_changes (custom_role_id, revision_after, kind, performed_by_user_id, basis, reason, items_removed)
            values ($1, $2, 'word_removal', $3, $4, $5, $6) returning id`, [c.id, c.revision + 1, ctx.userId, p.basis, reason, [word]])).rows[0].id;
        first ??= id;
      }
      return { customRoleChangeId: first, ownerClubId: clubId, ids: { clubId } };
    },
  });
}
