import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";
import { asActor, fixtures, key, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

async function seedNativeRoleLayers(fixture) {
  const f = fixtures(fixture.client);
  const club = await f.club("Builder staging");
  const team = await f.team(club);
  const platform = await f.user("Builder staging admin");
  const coach = await f.user("Builder native coach");
  await f.grantPlatform(platform);
  await f.grantTeam(coach, team);
  const versionCoach = await f.user("Builder version coach");
  await f.grantTeam(versionCoach, team);
  const role = ROLE_IDS.team_coach;
  return asActor(fixture.url, platform, async tx => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [version] } = await tx.query(
      `insert into public.permission_club_role_versions
         (club_id,system_role_id,based_on_revision,answered_revision,created_by_user_id)
       select $1,id,revision,revision,$3 from public.permission_roles where id=$2 returning id`, [club,role,platform],
    );
    await tx.query("insert into public.permission_club_role_version_items select $1,permission_word from public.permission_role_items where role_id=$2", [version.id,role]);
    await tx.query(
      `insert into public.permission_club_role_version_changes
         (version_id,revision_after,kind,performed_by_user_id,basis,reason,items_added)
       values($1,1,'create',$2,'platform_admin','Rehearsal version',
         array(select permission_word from public.permission_club_role_version_items where version_id=$1))`, [version.id,platform],
    );
    const { rows: [custom] } = await tx.query(
      `insert into public.permission_custom_roles
        (user_id,base_role_id,scope_type,scope_id,club_id,holding_row_table,holding_row_id,holding_row_version,
        frozen_from,frozen_from_revision,created_by_user_id)
       select $1,$2,'team',$3,$4,'user_team_roles',r.id,r.updated_at,'default',p.revision,$5
       from public.user_team_roles r join public.permission_roles p on p.id=$2
       where r.user_id=$1 and r.team_id=$3 returning id`, [coach,role,team,club,platform],
    );
    await tx.query("insert into public.permission_custom_role_items select $1,permission_word from public.permission_role_items where role_id=$2", [custom.id,role]);
    await tx.query(
      `insert into public.permission_custom_role_changes
         (custom_role_id,revision_after,kind,performed_by_user_id,basis,reason,items_added)
       values($1,1,'create',$2,'platform_admin','Rehearsal custom',
         array(select permission_word from public.permission_custom_role_items where custom_role_id=$1))`, [custom.id,platform],
    );
    return { versionId: version.id, customId: custom.id, club, team, platform, coach, versionCoach };
  });
}

function roleData(client) {
  return client.query(
    `select
      (select jsonb_agg(r order by id) from public.permission_roles r) as roles,
      (select jsonb_agg(i order by role_id,permission_word) from public.permission_role_items i) as role_items,
      (select jsonb_agg(a order by role_id,revision_after) from public.permission_role_changes a) as role_audit,
      (select jsonb_agg(r order by id) from public.permission_club_role_versions r) as versions,
      (select jsonb_agg(i order by version_id,permission_word) from public.permission_club_role_version_items i) as version_items,
      (select jsonb_agg(a order by version_id,revision_after) from public.permission_club_role_version_changes a) as version_audit,
      (select jsonb_agg(r order by id) from public.permission_custom_roles r) as custom,
      (select jsonb_agg(i order by custom_role_id,permission_word) from public.permission_custom_role_items i) as custom_items,
      (select jsonb_agg(a order by custom_role_id,revision_after) from public.permission_custom_role_changes a) as custom_audit`,
  ).then(({ rows }) => rows[0]);
}

test("v106 apply, unused rollback restores the catalogue, then reapply", async () => {
  const fixture = await createPagesDatabase({ through: "202612071000", label: "rpe_v106" });
  const { client } = fixture;
  const read = (name) => readFile(new URL(`../../docs/runbooks/builder-rpe-v106-${name}.sql`, import.meta.url), "utf8");
  const catalogue = async () => (await client.query(
    "select relname, relkind from pg_class where relnamespace='training_load'::regnamespace order by relname, relkind",
  )).rows;
  const wordState = async () => (await client.query(
    `select public.permission_word_honoured('programs.rpe_settings') as honoured,
       (select count(*)::integer from public.permission_role_items where permission_word='programs.rpe_settings') as grants`,
  )).rows[0];
  try {
    const { versionId, customId } = await seedNativeRoleLayers(fixture);
    const original = await catalogue();
    const rolesBefore = await roleData(client);
    assert.deepEqual(await wordState(), { honoured: false, grants: 0 });
    const rollback = await read("rollback");
    const [preflight] = await client.query(await read("preflight"));
    assert.ok(Object.values(preflight.rows[0]).every(check => check === true), JSON.stringify(preflight.rows[0]));
    await fixture.applyThrough("202612081000");
    const installed = await catalogue();
    const { rows: seed } = await client.query("select layer,id,words from training_load.builder_rpe_v106_seed order by layer,id");
    assert.deepEqual(seed.filter(row => row.layer !== "role"), [
      { layer: "custom", id: customId, words: ["programs.rpe_settings"] },
      { layer: "version", id: versionId, words: ["programs.rpe_settings"] },
    ]);
    assert.deepEqual(await wordState(), { honoured: true, grants: 2 });
    assert.notDeepEqual(installed, original);
    const [postcheck, use, opening, nativeSeed] = await client.query(await read("postcheck"));
    assert.equal(postcheck.rows[0].exact_v106, true);
    assert.equal(Number(use.rows[0].first_use_rows), 0);
    assert.equal(Number(opening.rows[0].opening_plans), 0);
    assert.deepEqual(nativeSeed.rows[0], { native_word_staged: true, permission_body_exact: true });
    assert.equal((await client.query("select * from training_load.builder_rpe_provenance_use")).rowCount, 0);
    await client.query(rollback);
    assert.deepEqual(await catalogue(), original);
    assert.deepEqual(await roleData(client), rolesBefore);
    assert.deepEqual(await wordState(), { honoured: false, grants: 0 });
    await fixture.applyThrough("202612081000");
    assert.deepEqual(await catalogue(), installed);
    await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values('migrations_v2/202612081100_rehearsal_later.sql',repeat('0',64),'test')");
    await assert.rejects(client.query(rollback), /later migration/);
    await client.query("rollback");
    assert.deepEqual(await catalogue(), installed);
    assert.deepEqual(await wordState(), { honoured: true, grants: 2 });
    assert.equal((await client.query("select * from training_load.builder_rpe_provenance_use")).rowCount, 0);
  } finally {
    await fixture.drop();
  }
});

test("both Settings builds preserve the staged word and both native layers can write", async () => {
  const fixture = await createPagesDatabase({ through: "202612071000", label: "rpe_overlap" });
  const { client } = fixture;
  let current, previous;
  try {
    const { versionId, customId, club, team, platform, coach, versionCoach } = await seedNativeRoleLayers(fixture);
    const f = fixtures(client);
    const viewer = await f.user("No role");
    const athleteUser = await f.user("Builder athlete");
    await f.makeAthlete(athleteUser);
    const { rows: [athlete] } = await client.query("select id,athlete_id from public.athletes where user_id=$1", [athleteUser]);
    await client.query("insert into public.athlete_memberships(athlete_id,club_id,team_id,membership_type,status) values($1,$2,$3,'team','active')", [athlete.id,club,team]);
    await client.query(
      "insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null),($2,'team',$4),($3,'team',$4)",
      [platform,coach,versionCoach,team],
    );
    current = await startServer(fixture.url);
    previous = await previousDashboardServer(fixture.url, {}, "4d7d0ced4f9f2eb5f2eb8d9b726295282d7e0555");
    const platformCookie = await current.cookieFor(platform);
    const customCookie = await current.cookieFor(coach);
    const versionCookie = await current.cookieFor(versionCoach);
    const viewerCookie = await current.cookieFor(viewer);
    const oldPost = async (cookie, path, body) => {
      const response = await fetch(previous.baseUrl + path, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: JSON.parse(text), text };
    };
    const oldDraft = async (cookie, weekStart) => {
      const draft = await oldPost(cookie, "/api/builder/plans", {
        name: "Saved by the previous build", planType: "weekly", weekStart, athleteIds: [athlete.athlete_id],
      });
      assert.equal(draft.status, 201, draft.text);
      return draft.body.plan.id;
    };
    const legacyId = await oldDraft(versionCookie, "2027-09-13");
    await fixture.applyThrough("202612081000");
    const marker = () => client.query("select 1 from training_load.builder_rpe_provenance_use").then(result => result.rowCount);
    const tracked = (id) => client.query("select 1 from training_load.builder_rpe_plan_baselines where plan_id=$1", [id]).then(result => result.rowCount);
    assert.equal(await marker(), 0);
    assert.equal(await tracked(legacyId), 0);

    const root = "/api/organization/roles";
    const roleId = ROLE_IDS.team_coach;
    const word = "programs.rpe_settings";
    const roleChange = root + "/" + roleId + "/change";
    const versionPath = root + "/" + roleId + "/clubs/" + club + "/version";
    const customPath = root + "/users/" + coach + "/clubs/" + club + "/custom";
    const customScope = { roleId, scopeType: "team", scopeId: team };
    const words = async () => (await client.query(
      `select array(select permission_word from public.permission_role_items where role_id=$1 order by 1) as "default",
         array(select permission_word from public.permission_club_role_version_items where version_id=$2 order by 1) as version,
         array(select permission_word from public.permission_custom_role_items where custom_role_id=$3 order by 1) as custom`,
      [roleId,versionId,customId],
    )).rows[0];
    const revisions = async () => (await client.query(
      `select (select revision from public.permission_roles where id=$1) as "default",
        (select revision from public.permission_club_role_versions where id=$2) as version,
        (select revision from public.permission_custom_roles where id=$3) as custom`, [roleId,versionId,customId],
    )).rows[0];
    for (const send of [
      (path, body) => oldPost(platformCookie, path, body),
      (path, body) => current.api(platformCookie, path, { method: "POST", body }),
    ]) {
      const before = await words();
      const revision = await revisions();
      for (const [path, input] of [
        [roleChange, { expectedRevision: revision.default, items: before.default.filter(item => item !== word) }],
        [versionPath, { expectedRevision: revision.version, remove: [word] }],
        [customPath, { ...customScope, expectedRevision: revision.custom, remove: [word] }],
      ]) {
        const rejected = await send(path, { requestKey: key(), reason: "Staged item remains locked", ...input });
        assert.equal(rejected.status, 409, rejected.text);
        assert.equal(rejected.body.error, "permission_not_available_yet", rejected.text);
      }
      assert.deepEqual(await words(), before);
      assert.deepEqual(await revisions(), revision);
      const unrelated = await send(roleChange, {
        requestKey: key(), reason: "Keep staged item", expectedRevision: revision.default,
        items: before.default, description: "Overlap " + key(),
      });
      assert.equal(unrelated.status, 200, unrelated.text);
      for (const [path, input, field] of [
        [versionPath, { expectedRevision: revision.version }, "version"],
        [customPath, { ...customScope, expectedRevision: revision.custom }, "custom"],
      ]) {
        const change = before[field].includes("athletes.remove") ? { remove: ["athletes.remove"] } : { add: ["athletes.remove"] };
        const allowed = await send(path, { ...input, ...change, requestKey: key(), reason: "Unrelated role adjustment" });
        assert.equal(allowed.status, 200, allowed.text);
      }
      assert.ok(Object.values(await words()).every(items => items.includes(word)));
    }

    const patchDefaults = (cookie, id, enabled) => current.api(cookie, "/api/builder/plans/" + id + "/training-load-settings", {
      method: "PATCH", body: { trackTrainingLoadDefault: enabled, requestRpeDefault: enabled },
    });
    const noOp = await patchDefaults(versionCookie, legacyId, false);
    assert.equal(noOp.status, 200, noOp.text);
    assert.equal(await marker(), 0);
    const denied = await patchDefaults(viewerCookie, legacyId, true);
    assert.ok([403,404].includes(denied.status), denied.text);
    assert.equal(await marker(), 0);
    const accepted = await patchDefaults(versionCookie, legacyId, true);
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(await tracked(legacyId), 0);
    assert.equal(await marker(), 1);
    const rollback = await readFile(new URL("../../docs/runbooks/builder-rpe-v106-rollback.sql", import.meta.url), "utf8");
    await assert.rejects(client.query(rollback), /refuses recorded Builder provenance or checked writer use/);
    await client.query("rollback");
    const customLegacy = await oldDraft(customCookie, "2027-09-20");
    const customAccepted = await patchDefaults(customCookie, customLegacy, true);
    assert.equal(customAccepted.status, 200, customAccepted.text);
    const { rows } = await client.query("select request_rpe_default from plans.plans where id=any($1::uuid[]) order by id", [[legacyId,customLegacy]]);
    assert.deepEqual(rows.map(row => row.request_rpe_default), [true,true]);
  } finally {
    await client.query("rollback").catch(() => {});
    await previous?.stop();
    await current?.stop();
    await fixture.drop();
  }
});