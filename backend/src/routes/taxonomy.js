import { Router } from "express";
import { query } from "../db.js";
import { isPlatformAdmin } from "../access.js";

const router = Router();
const NODE_TYPES = new Set(["domain", "category", "section"]);
const SCOPES = new Set(["system", "club", "team", "user"]);
const LIBRARY_LOOKUPS = {
  domain: { table: "domains", parentColumn: null },
  category: { table: "categories", parentColumn: "domain_id" },
  section: { table: "sections", parentColumn: "category_id" },
  tag: { table: "tags", parentColumn: null },
  attractor: { table: "attractors", parentColumn: null },
};

router.get("/node-presets", async (req, res, next) => {
  try {
    const nodeType = clean(req.query?.nodeType);
    if (nodeType && !NODE_TYPES.has(nodeType)) return res.status(400).json({ error: "Invalid node type." });
    const presets = await loadVisibleNodePresets(req.user, nodeType);
    res.json({ presets });
  } catch (error) {
    next(error);
  }
});

router.post("/node-presets", async (req, res, next) => {
  try {
    const nodeType = clean(req.body?.nodeType);
    const name = clean(req.body?.name);
    if (!NODE_TYPES.has(nodeType)) return res.status(400).json({ error: "Invalid node type." });
    if (!name) return res.status(400).json({ error: "Name is required." });
    const owner = await resolveOwnerScope(req.user, req.body);
    if (owner.error) return res.status(owner.status).json({ error: owner.error });
    const result = await query(
      `insert into library.node_presets (node_type, name, slug, color, icon_url, owner_scope, owner_club_id, owner_team_id, owner_user_id, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (node_type, slug, owner_scope, coalesce(owner_club_id, '00000000-0000-0000-0000-000000000000'), coalesce(owner_team_id, '00000000-0000-0000-0000-000000000000'), coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'))
       do update set name = excluded.name, color = excluded.color, icon_url = excluded.icon_url, is_active = true, updated_at = now()
       returning *`,
      [nodeType, name, slugify(name), clean(req.body?.color), clean(req.body?.iconUrl), owner.scope, owner.clubId, owner.teamId, owner.userId, req.user.id],
    );
    res.status(201).json({ preset: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.patch("/node-presets/:presetId", async (req, res, next) => {
  try {
    const preset = await loadNodePreset(req.params.presetId);
    if (!preset) return res.status(404).json({ error: "Preset not found." });
    if (!(await canManagePreset(req.user, preset))) return res.status(403).json({ error: "Preset is outside your access." });
    const name = clean(req.body?.name) || preset.name;
    const result = await query(
      `update library.node_presets
       set name = $2, slug = $3, color = $4, icon_url = $5, updated_at = now()
       where id = $1
       returning *`,
      [preset.id, name, slugify(name), clean(req.body?.color) || preset.color, clean(req.body?.iconUrl) || preset.icon_url],
    );
    res.json({ preset: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.delete("/node-presets/:presetId", async (req, res, next) => {
  try {
    const preset = await loadNodePreset(req.params.presetId);
    if (!preset) return res.status(404).json({ error: "Preset not found." });
    if (preset.owner_scope === "system" && !isPlatformAdmin(req.user)) {
      await query(
        `insert into library.node_preset_hidden (preset_id, user_id) values ($1, $2) on conflict (preset_id, user_id) do nothing`,
        [preset.id, req.user.id],
      );
      return res.json({ hidden: true });
    }
    if (!(await canManagePreset(req.user, preset))) return res.status(403).json({ error: "Preset is outside your access." });
    await query(`update library.node_presets set is_active = false, updated_at = now() where id = $1`, [preset.id]);
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

router.get("/template-tags", async (req, res, next) => {
  try {
    const tags = await loadVisibleTemplateTags(req.user);
    res.json({ tags });
  } catch (error) {
    next(error);
  }
});

router.post("/template-tags", async (req, res, next) => {
  try {
    const name = clean(req.body?.name);
    if (!name) return res.status(400).json({ error: "Name is required." });
    const owner = await resolveOwnerScope(req.user, req.body);
    if (owner.error) return res.status(owner.status).json({ error: owner.error });
    const result = await query(
      `insert into library.program_tag_definitions (name, slug, owner_scope, owner_club_id, owner_team_id, owner_user_id, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (slug, owner_scope, coalesce(owner_club_id, '00000000-0000-0000-0000-000000000000'), coalesce(owner_team_id, '00000000-0000-0000-0000-000000000000'), coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'))
       do update set name = excluded.name, is_active = true, updated_at = now()
       returning *`,
      [name, slugify(name), owner.scope, owner.clubId, owner.teamId, owner.userId, req.user.id],
    );
    res.status(201).json({ tag: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.patch("/template-tags/:tagId", async (req, res, next) => {
  try {
    const tag = await loadTemplateTag(req.params.tagId);
    if (!tag) return res.status(404).json({ error: "Tag not found." });
    if (!(await canManagePreset(req.user, tag))) return res.status(403).json({ error: "Tag is outside your access." });
    const name = clean(req.body?.name) || tag.name;
    const result = await query(
      `update library.program_tag_definitions set name = $2, slug = $3, updated_at = now() where id = $1 returning *`,
      [tag.id, name, slugify(name)],
    );
    res.json({ tag: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.delete("/template-tags/:tagId", async (req, res, next) => {
  try {
    const tag = await loadTemplateTag(req.params.tagId);
    if (!tag) return res.status(404).json({ error: "Tag not found." });
    if (tag.owner_scope === "system" && !isPlatformAdmin(req.user)) {
      await query(
        `insert into library.program_tag_hidden (tag_id, user_id) values ($1, $2) on conflict (tag_id, user_id) do nothing`,
        [tag.id, req.user.id],
      );
      return res.json({ hidden: true });
    }
    if (!(await canManagePreset(req.user, tag))) return res.status(403).json({ error: "Tag is outside your access." });
    await query(`update library.program_tag_definitions set is_active = false, updated_at = now() where id = $1`, [tag.id]);
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

router.get("/library/:kind", async (req, res, next) => {
  try {
    const config = LIBRARY_LOOKUPS[req.params.kind];
    if (!config) return res.status(400).json({ error: "Invalid filter kind." });
    const rows = await loadVisibleLibraryRows(req.user, req.params.kind, config);
    res.json({ rows });
  } catch (error) {
    next(error);
  }
});

router.post("/library/:kind", async (req, res, next) => {
  try {
    const config = LIBRARY_LOOKUPS[req.params.kind];
    if (!config) return res.status(400).json({ error: "Invalid filter kind." });
    const name = clean(req.body?.name);
    if (!name) return res.status(400).json({ error: "Name is required." });
    const owner = await resolveOwnerScope(req.user, req.body);
    if (owner.error) return res.status(owner.status).json({ error: owner.error });
    const columns = ["name", "slug", "owner_scope", "owner_club_id", "owner_team_id", "owner_user_id", "created_by_user_id"];
    const values = [name, slugify(name), owner.scope, owner.clubId, owner.teamId, owner.userId, req.user.id];
    if (config.parentColumn) {
      columns.push(config.parentColumn);
      values.push(clean(req.body?.parentId) || null);
    }
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
    const result = await query(
      `insert into library.${config.table} (${columns.join(", ")}) values (${placeholders}) returning *`,
      values,
    );
    res.status(201).json({ row: result.rows[0] });
  } catch (error) {
    if (error?.code === "23503") return res.status(400).json({ error: "Selected parent does not exist." });
    next(error);
  }
});

router.patch("/library/:kind/:id", async (req, res, next) => {
  try {
    const config = LIBRARY_LOOKUPS[req.params.kind];
    if (!config) return res.status(400).json({ error: "Invalid filter kind." });
    const row = await loadLibraryRow(config, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found." });
    if (!(await canManagePreset(req.user, row))) return res.status(403).json({ error: "Outside your access." });
    const name = clean(req.body?.name) || row.name;
    const setParts = ["name = $2", "slug = $3", "updated_at = now()"];
    const values = [row.id, name, slugify(name)];
    if (config.parentColumn) {
      setParts.push(`${config.parentColumn} = $4`);
      values.push(clean(req.body?.parentId) || row[config.parentColumn]);
    }
    const result = await query(
      `update library.${config.table} set ${setParts.join(", ")} where id = $1 returning *`,
      values,
    );
    res.json({ row: result.rows[0] });
  } catch (error) {
    if (error?.code === "23503") return res.status(400).json({ error: "Selected parent does not exist." });
    next(error);
  }
});

router.delete("/library/:kind/:id", async (req, res, next) => {
  try {
    const config = LIBRARY_LOOKUPS[req.params.kind];
    if (!config) return res.status(400).json({ error: "Invalid filter kind." });
    const row = await loadLibraryRow(config, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found." });
    if (row.owner_scope === "system" && !isPlatformAdmin(req.user)) {
      await query(
        `insert into library.filter_hidden (kind, item_id, user_id) values ($1, $2, $3) on conflict (kind, item_id, user_id) do nothing`,
        [req.params.kind, row.id, req.user.id],
      );
      return res.json({ hidden: true });
    }
    if (!(await canManagePreset(req.user, row))) return res.status(403).json({ error: "Outside your access." });
    await query(`update library.${config.table} set is_active = false, updated_at = now() where id = $1`, [row.id]);
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

async function loadVisibleNodePresets(user, nodeType) {
  const admin = isPlatformAdmin(user);
  const result = await query(
    `select p.*,
       (
         $3::boolean
         or (p.owner_scope = 'user' and p.owner_user_id = $1)
         or (p.owner_scope = 'club' and p.owner_club_id in (select club_id from public.user_club_roles where user_id = $1 and is_active = true))
         or (p.owner_scope = 'team' and (
           p.owner_team_id in (select team_id from public.user_team_roles where user_id = $1 and is_active = true)
           or p.owner_team_id in (
             select t.id from public.teams t
             join public.user_club_roles ucr on ucr.club_id = t.club_id
             where ucr.user_id = $1 and ucr.is_active = true
           )
         ))
       ) as can_manage
     from library.node_presets p
     where p.is_active = true
       and ($2::varchar is null or p.node_type = $2)
       and (
         (p.owner_scope = 'system' and not exists (select 1 from library.node_preset_hidden h where h.preset_id = p.id and h.user_id = $1))
         or (p.owner_scope = 'club' and p.owner_club_id in (select club_id from public.user_club_roles where user_id = $1 and is_active = true))
         or (p.owner_scope = 'team' and p.owner_team_id in (select team_id from public.user_team_roles where user_id = $1 and is_active = true))
         or (p.owner_scope = 'user' and p.owner_user_id = $1)
       )
     order by p.owner_scope, p.name`,
    [user.id, nodeType || null, admin],
  );
  return result.rows;
}

async function loadVisibleTemplateTags(user) {
  const admin = isPlatformAdmin(user);
  const result = await query(
    `select t.*,
       (
         $2::boolean
         or (t.owner_scope = 'user' and t.owner_user_id = $1)
         or (t.owner_scope = 'club' and t.owner_club_id in (select club_id from public.user_club_roles where user_id = $1 and is_active = true))
         or (t.owner_scope = 'team' and (
           t.owner_team_id in (select team_id from public.user_team_roles where user_id = $1 and is_active = true)
           or t.owner_team_id in (
             select tm.id from public.teams tm
             join public.user_club_roles ucr on ucr.club_id = tm.club_id
             where ucr.user_id = $1 and ucr.is_active = true
           )
         ))
       ) as can_manage
     from library.program_tag_definitions t
     where t.is_active = true
       and (
         (t.owner_scope = 'system' and not exists (select 1 from library.program_tag_hidden h where h.tag_id = t.id and h.user_id = $1))
         or (t.owner_scope = 'club' and t.owner_club_id in (select club_id from public.user_club_roles where user_id = $1 and is_active = true))
         or (t.owner_scope = 'team' and t.owner_team_id in (select team_id from public.user_team_roles where user_id = $1 and is_active = true))
         or (t.owner_scope = 'user' and t.owner_user_id = $1)
       )
     order by t.owner_scope, t.name`,
    [user.id, admin],
  );
  return result.rows;
}

async function loadVisibleLibraryRows(user, kind, config) {
  const admin = isPlatformAdmin(user);
  const result = await query(
    `select r.*,
       (
         $2::boolean
         or (r.owner_scope = 'user' and r.owner_user_id = $1)
         or (r.owner_scope = 'club' and r.owner_club_id in (select club_id from public.user_club_roles where user_id = $1 and is_active = true))
         or (r.owner_scope = 'team' and (
           r.owner_team_id in (select team_id from public.user_team_roles where user_id = $1 and is_active = true)
           or r.owner_team_id in (
             select t.id from public.teams t
             join public.user_club_roles ucr on ucr.club_id = t.club_id
             where ucr.user_id = $1 and ucr.is_active = true
           )
         ))
       ) as can_manage
     from library.${config.table} r
     where r.is_active = true
       and (
         (r.owner_scope = 'system' and not exists (select 1 from library.filter_hidden h where h.kind = $3 and h.item_id = r.id and h.user_id = $1))
         or (r.owner_scope = 'club' and r.owner_club_id in (select club_id from public.user_club_roles where user_id = $1 and is_active = true))
         or (r.owner_scope = 'team' and r.owner_team_id in (select team_id from public.user_team_roles where user_id = $1 and is_active = true))
         or (r.owner_scope = 'user' and r.owner_user_id = $1)
       )
     order by r.owner_scope, r.name`,
    [user.id, admin, kind],
  );
  return result.rows;
}

async function loadLibraryRow(config, id) {
  const result = await query(`select * from library.${config.table} where id = $1`, [id]);
  return result.rows[0] || null;
}

async function loadNodePreset(presetId) {
  const result = await query(`select * from library.node_presets where id = $1`, [presetId]);
  return result.rows[0] || null;
}

async function loadTemplateTag(tagId) {
  const result = await query(`select * from library.program_tag_definitions where id = $1`, [tagId]);
  return result.rows[0] || null;
}

async function canManagePreset(user, owned) {
  if (isPlatformAdmin(user)) return true;
  if (owned.owner_scope === "system") return false;
  if (owned.owner_scope === "user") return owned.owner_user_id === user.id;
  if (owned.owner_scope === "club") {
    const result = await query(`select 1 from public.user_club_roles where user_id = $1 and club_id = $2 and is_active = true`, [user.id, owned.owner_club_id]);
    return result.rowCount > 0;
  }
  if (owned.owner_scope === "team") {
    const result = await query(
      `select 1
       from public.teams t
       where t.id = $2
         and (
           exists (select 1 from public.user_team_roles utr where utr.user_id = $1 and utr.team_id = t.id and utr.is_active = true)
           or exists (select 1 from public.user_club_roles ucr where ucr.user_id = $1 and ucr.club_id = t.club_id and ucr.is_active = true)
         )`,
      [user.id, owned.owner_team_id],
    );
    return result.rowCount > 0;
  }
  return false;
}

async function resolveOwnerScope(user, body) {
  const scope = SCOPES.has(clean(body?.scope)) ? clean(body?.scope) : "user";
  if (scope === "system") {
    if (!isPlatformAdmin(user)) return { error: "Only platform admin can create shared defaults.", status: 403 };
    return { scope, clubId: null, teamId: null, userId: null };
  }
  if (scope === "club") {
    const clubId = clean(body?.clubId);
    if (!clubId) return { error: "Club is required for club-scoped entries.", status: 400 };
    const allowed = await canManagePreset(user, { owner_scope: "club", owner_club_id: clubId });
    if (!allowed) return { error: "Club is outside your access.", status: 403 };
    return { scope, clubId, teamId: null, userId: null };
  }
  if (scope === "team") {
    const teamId = clean(body?.teamId);
    if (!teamId) return { error: "Team is required for team-scoped entries.", status: 400 };
    const allowed = await canManagePreset(user, { owner_scope: "team", owner_team_id: teamId });
    if (!allowed) return { error: "Team is outside your access.", status: 403 };
    return { scope, clubId: null, teamId, userId: null };
  }
  return { scope: "user", clubId: null, teamId: null, userId: user.id };
}

function clean(value) {
  return String(value || "").trim();
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default router;
