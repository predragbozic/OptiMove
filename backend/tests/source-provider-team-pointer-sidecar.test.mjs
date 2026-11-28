import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { fixtures } from "./support/permission-roles-world.mjs";

const fixture = new URL("../../migrations_v2/202612211000_training_load_v119_sources_provider_team_pointer_generations.sql", import.meta.url);
const rollback = new URL("../../docs/runbooks/sources-provider-v119-rollback.sql", import.meta.url);
const preflight = new URL("../../docs/runbooks/sources-provider-v119-preflight.sql", import.meta.url);
const postcheck = new URL("../../docs/runbooks/sources-provider-v119-postcheck.sql", import.meta.url);
const previousBuild = "5016ba1cfcf1396379eac4b40aca6a4b0c87a67d";
const ptr = "training_load.gpexe_team_settings";
const teamSide = "training_load.source_provider_team_generations";
const pointerSide = "training_load.source_provider_pointer_generations";
const bindings = "training_load.source_team_bindings";
const roles = ["anon", "authenticated", "service_role"];

test("closed private team and pointer sidecars preserve legacy scoped SQL and transactional generations", async t => {
  const lab = await createPagesDatabase({ through: "202612201000", label: "source_sidecars" });
  const { client } = lab;
  let peer, previous, grants = false;
  const created = [];
  try {
    const f = fixtures(client);
    const own = await f.club("Sidecar owning club");
    const outside = await f.club("Sidecar other club");
    const actor = await f.user("Disposable sidecar actor");
    const selected = await f.team(own, "Selected");
    const other = await f.team(own, "Other team");
    const free = await f.team(own, "No dependent keys");
    const settings = async (team, pair, c = client) => c.query(
      `insert into ${ptr}(owner_team_id,gpexe_team_id,configured_by_user_id) values($1,$2,$3)`, [team,pair,actor],
    );
    const repoint = async (team, pair, c = client) => c.query(
      `update ${ptr} set gpexe_team_id=$2,change_reason='Disposable approved change',configured_at=clock_timestamp() where owner_team_id=$1`,
      [team,pair],
    );
    const version = async (relation, team = selected, c = client) => (await c.query(
      `select coalesce((select generation from ${relation} where team_id=$1),0) as generation`, [team],
    )).rows[0].generation;
    const move = (club, team = selected) => client.query("update public.teams set club_id=$2 where id=$1", [team,club]);
    const history = async (team) => (await client.query(
      "select count(*)::int as count from training_load.gpexe_team_settings_history where owner_team_id=$1", [team],
    )).rows[0].count;
    await settings(other, "0902");
    await client.query("update public.teams set is_active=false where id=$1", [free]);
    for (const role of roles) {
      if (!(await client.query("select from pg_roles where rolname=$1", [role])).rowCount) {
        await client.query("create role " + role + " nologin");
        created.push(role);
      }
    }
    await client.query("alter default privileges in schema training_load grant all on tables to public,anon,authenticated,service_role");
    await client.query("alter default privileges in schema training_load grant execute on functions to anon,authenticated,service_role");
    grants = true;
    await client.query("grant select, update(is_active) on public.teams to authenticated");
    await client.query("grant usage on schema training_load to authenticated");
    await client.query("create table training_load.sidecar_acl_sentinel(id uuid)");
    try {
      for (const role of roles) {
        assert.equal((await client.query(
          "select has_table_privilege($1,'training_load.sidecar_acl_sentinel','SELECT') as available", [role],
        )).rows[0].available, true);
      }
    } finally {
      await client.query("drop table training_load.sidecar_acl_sentinel");
    }
    const legacyGuards = async () => (await client.query(`
      select t.tgname as name, md5(pg_get_triggerdef(t.oid) || '/' || t.tgenabled::text ||
        '/' || pg_get_functiondef(t.tgfoid)) as digest
      from pg_trigger t
      where not t.tgisinternal and t.tgrelid in ('public.teams'::regclass, 'training_load.gpexe_team_settings'::regclass)
        and t.tgname not in ('zz_source_provider_team_sidecar','zz_source_provider_pointer_sidecar')
      order by t.tgname collate "C"
    `)).rows;
    const guardsBefore = await legacyGuards();
    assert.equal(guardsBefore.length, 8);
    const apply = async () => {
      await client.query("begin");
      try {
        await client.query(await readFile(fixture, "utf8"));
        await client.query(
          "insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,$2,'v119-rehearsal')",
          ["migrations_v2/202612211000_training_load_v119_sources_provider_team_pointer_generations.sql", "55178f2f8ed4cdb7a738431383997532b15d4b03f7001b76004e1119029df99d"],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    };
    await t.test("installation refuses changed guards and occupied relations without partial changes", async () => {
      await client.query("alter table public.teams disable trigger teams_source_binding_guard_move");
      try {
        await assert.rejects(apply(), /legacy trigger fingerprint changed/);
        assert.equal((await client.query(`select to_regclass('${teamSide}') as relation`)).rows[0].relation, null);
      } finally {
        await client.query("alter table public.teams enable trigger teams_source_binding_guard_move");
      }
      const blocker = new client.constructor({ connectionString: lab.url });
      await blocker.connect();
      try {
        await blocker.query("begin; lock table training_load.gpexe_team_settings in row exclusive mode");
        await assert.rejects(apply(), { code: "55P03" });
        assert.equal((await client.query(`select to_regclass('${pointerSide}') as relation`)).rows[0].relation, null);
      } finally {
        await blocker.query("rollback");
        await blocker.end();
      }
    });
    let exerciseOld;
    let oldBaseline;
    if (process.env.OPTIMOVE_SOURCES_V119_PREVIOUS_SERVER) {
      const worktree = path.resolve(process.env.OPTIMOVE_SOURCES_V119_PREVIOUS_SERVER);
      const previousGit = (...args) => execFileSync("git", ["-C", worktree, ...args], { encoding:"utf8" }).trim();
      assert.equal(previousGit("rev-parse", "HEAD"), previousBuild);
      assert.equal(previousGit("status", "--porcelain", "--untracked-files=no"), "");
      await f.grantPlatform(actor);
      const { startServer } = await import(pathToFileURL(path.join(worktree, "backend/tests/support/permission-roles-world.mjs")).href);
      previous = await startServer(lab.url);
      const cookie = await previous.cookieFor(actor);
      exerciseOld = async (tag, sourceTeamId) => {
        const org = "/api/organization/teams";
        const perform = async (url, method, body) => {
          const response = await previous.api(cookie, url, { method, body });
          assert.equal(response.status, method === "POST" ? 201 : 200, response.text);
          return response.body;
        };
        const created = await perform(org, "POST", { name: tag, clubId: own });
        const teamId = created.team.id;
        await perform(org + "/" + teamId, "PUT", { name: tag + " renamed" });
        await perform(org + "/" + teamId, "DELETE");
        await perform(org + "/" + teamId + "/restore", "PUT");
        const pointer = "/api/training-load/gpexe/teams/" + teamId + "/settings";
        const linked = await perform(pointer, "PUT", { gpexeTeamId: sourceTeamId });
        const repeated = await perform(pointer, "PUT", { gpexeTeamId: sourceTeamId });
        return {
          teamId, history:await history(teamId),
          keys:[Object.keys(created.team).sort(),Object.keys(linked).sort(),Object.keys(repeated).sort()],
        };
      };
      oldBaseline = await exerciseOld("Previous server before v119", "9301");
    }

    await client.query(await readFile(preflight, "utf8"));
    await apply();
    await client.query(await readFile(postcheck, "utf8"));

    await t.test("apply, down and reapply preserve the exact legacy trigger and relation shape", async () => {
      const down = await readFile(rollback, "utf8");
      const installed = async () => (await client.query(`
        select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as definition, md5(p.prosrc) as body
        from pg_trigger t join pg_proc p on p.oid=t.tgfoid
        where t.tgrelid in ('public.teams'::regclass,'training_load.gpexe_team_settings'::regclass)
          and t.tgname in ('zz_source_provider_team_sidecar','zz_source_provider_pointer_sidecar')
        order by t.tgname
      `)).rows;
      const fingerprints = await installed();
      assert.equal(fingerprints.length, 2);
      assert.ok(fingerprints.every(row => row.tgenabled === "O"));
      assert.deepEqual(await legacyGuards(), guardsBefore);
      await client.query("alter table public.teams disable trigger zz_source_provider_team_sidecar");
      await assert.rejects(client.query(down), /rollback refused: capture trigger changed/);
      await client.query("rollback");
      await client.query("alter table public.teams enable trigger zz_source_provider_team_sidecar");
      const later = "migrations_v2/209912311000_disposable_sidecar_guard.sql";
      await client.query(
        "insert into public.schema_migrations(migration_name,checksum,runner_version,applied_at) values($1,repeat('0',64),'rehearsal','2000-01-01')",
        [later],
      );
      await assert.rejects(client.query(down), /rollback refused: registry changed/);
      await client.query("rollback");
      await client.query("delete from public.schema_migrations where migration_name=$1", [later]);
      const verify = await readFile(postcheck, "utf8");
      const [{ owner }] = (await client.query("select quote_ident(current_user) as owner")).rows;
      const differentOwner = "sidecar_drift_" + randomUUID().replaceAll("-", "");
      await client.query("create role " + differentOwner + " nologin");
      try {
        for (const object of [
          "function training_load.capture_source_team_sidecar()",
          "table training_load.source_provider_pointer_generations",
        ]) {
          await client.query("alter " + object + " owner to " + differentOwner);
          try {
            await assert.rejects(client.query(verify), /capture trigger changed/);
            await client.query("rollback");
            await assert.rejects(client.query(down), /capture trigger changed/);
            await client.query("rollback");
          } finally {
            await client.query("rollback");
            await client.query("alter " + object + " owner to " + owner);
          }
        }
      } finally {
        await client.query("drop role " + differentOwner);
      }
      await client.query(`grant select(generation) on ${teamSide} to authenticated`);
      await assert.rejects(client.query(verify), /sidecar isolation changed/);
      await client.query("rollback");
      await assert.rejects(client.query(down), /sidecar isolation changed/);
      await client.query("rollback");
      await client.query(`revoke select(generation) on ${teamSide} from authenticated`);
      await client.query("grant execute on function training_load.capture_source_pointer_sidecar() to service_role");
      await assert.rejects(client.query(verify), /sidecar isolation changed/);
      await client.query("rollback");
      await client.query("revoke execute on function training_load.capture_source_pointer_sidecar() from service_role");
      await client.query(`grant select(generation) on ${pointerSide} to public`);
      await assert.rejects(client.query(verify), /sidecar isolation changed/);
      await client.query("rollback");
      await client.query(`revoke select(generation) on ${pointerSide} from public`);
      await client.query(down);
      assert.deepEqual(await installed(), []);
      assert.deepEqual(await legacyGuards(), guardsBefore);
      assert.deepEqual((await client.query(`
        select to_regclass('${teamSide}') as team, to_regclass('${pointerSide}') as pointer,
          to_regprocedure('training_load.capture_source_team_sidecar()') as team_fn,
          to_regprocedure('training_load.capture_source_pointer_sidecar()') as pointer_fn
      `)).rows, [{ team:null, pointer:null, team_fn:null, pointer_fn:null }]);
      await lab.applyThrough("202612211000");
      assert.deepEqual(await installed(), fingerprints);
    });
    await t.test("the exact preceding server performs the same team and pointer writes", {
      skip: !exerciseOld && "Set OPTIMOVE_SOURCES_V119_PREVIOUS_SERVER to the exact predecessor checkout",
    }, async () => {
      const migrated = await exerciseOld("Previous server after v119", "9302");
      assert.deepEqual(migrated.keys, oldBaseline.keys);
      assert.equal(migrated.history, oldBaseline.history);
      assert.equal(await version(teamSide, oldBaseline.teamId), "0");
      assert.equal(await version(pointerSide, oldBaseline.teamId), "0");
      assert.equal(await version(teamSide, migrated.teamId), "3");
      assert.equal(await version(pointerSide, migrated.teamId), "1");
    });
    await t.test("privileged trigger writes remain private even with API-readable public team rows", async () => {
      for (const role of roles) {
        const check = (await client.query(`select
          has_table_privilege($1,'${teamSide}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as team_access,
          has_table_privilege($1,'${pointerSide}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as pointer_access,
          has_function_privilege($1,'training_load.capture_source_team_sidecar()','execute') as team_execute,
          has_function_privilege($1,'training_load.capture_source_pointer_sidecar()','execute') as pointer_execute`, [role])).rows[0];
        assert.deepEqual(check, { team_access:false, pointer_access:false, team_execute:false, pointer_execute:false });
      }
      const grants = await client.query(`select from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        where c.oid in ('${teamSide}'::regclass,'${pointerSide}'::regclass) and a.grantee=0`);
      assert.equal(grants.rowCount, 0);
      assert.equal((await client.query(`select count(*)::int as n from pg_constraint where contype='f' and
        conrelid in ('${teamSide}'::regclass,'${pointerSide}'::regclass)`)).rows[0].n, 0);
      await client.query("set role authenticated");
      try {
        const row = (await client.query("select to_jsonb(t) as row from public.teams t where id=$1", [free])).rows[0].row;
        assert.equal(Object.keys(row).some(field => field.includes("generation")), false);
        assert.equal((await client.query("update public.teams set is_active=true where id=$1", [free])).rowCount, 1);
        await assert.rejects(client.query(`select * from ${teamSide}`), { code: "42501" });
      } finally {
        await client.query("reset role");
      }
      assert.equal(await version(teamSide, free), "1");
    });

    await t.test("pointer versions follow canonical changes and preserve existing history and no-ops", async () => {
      assert.equal(await version(pointerSide, other), "0", "existing pointers need no backfill");
      assert.equal(await version(pointerSide), "0");
      await settings(selected, "00981");
      assert.equal(await version(pointerSide), "1");
      const recorded = await history(selected);
      assert.equal((await client.query(`update ${ptr} set gpexe_team_id=gpexe_team_id where owner_team_id=$1`, [selected])).rowCount, 0);
      assert.equal(await history(selected), recorded);
      await repoint(selected, "981");
      assert.equal(await history(selected), recorded + 1);
      assert.equal(await version(pointerSide), "1");
      await repoint(selected, "983");
      await repoint(selected, "981");
      assert.equal(await version(pointerSide), "3", "round trip to the same pair invalidates a snapshot");
      assert.equal(await version(pointerSide, other), "0");
      assert.equal(await version(teamSide), "0");
    });

    await t.test("active binding still pins both scopes and rejected or rolled back writes leave no generations", async () => {
      const { rows: [connection] } = await client.query(
        "insert into training_load.source_credential_connections(source_system,owner_scope,owner_club_id,host_key,account_label,credential_kind,created_by_user_id) values('gpexe','club',$1,'server3','Sidecar control','exchanged_token',$2) returning id",
        [own,actor]);
      const { rows: [binding] } = await client.query(
        `insert into ${bindings}(team_id,connection_id,source_system,source_team_id,bound_by_user_id,legacy_gpexe_settings_team_id)
        values($1,$2,'gpexe','981',$3,$1) returning id`, [selected,connection.id,actor]);
      await assert.rejects(repoint(selected, "983"), { code: "23514", constraint: "gpexe_team_settings_bound_team_final" });
      await assert.rejects(move(outside), { code: "23514" });
      assert.equal(await version(teamSide), "0");
      assert.equal(await version(pointerSide), "3");
      await client.query(`update ${bindings} set state='ended',ended_at=clock_timestamp(),ended_by_user_id=$2,end_reason='Disposable end' where id=$1`, [binding.id,actor]);
      await client.query("begin");
      try {
        await repoint(selected, "983");
        await move(outside);
        assert.equal(await version(pointerSide), "4");
        assert.equal(await version(teamSide), "1");
      } finally {
        await client.query("rollback");
      }
      assert.equal(await version(pointerSide), "3");
      assert.equal(await version(teamSide), "0");
      await move(outside);
      await move(own);
      assert.equal(await version(teamSide), "2");
      await client.query("update public.teams set name='Display-only rename' where id=$1", [selected]);
      assert.equal(await version(teamSide), "2");
    });

    await t.test("record primary-key moves, delete and ID reuse without an FK added to public teams", async () => {
      const id = randomUUID();
      await client.query("update public.teams set id=$2 where id=$1", [free,id]);
      assert.equal(await version(teamSide, free), "2");
      assert.equal(await version(teamSide, id), "1");
      await client.query("delete from public.teams where id=$1", [id]);
      assert.equal(await version(teamSide, id), "2");
      await client.query("insert into public.teams(id,club_id,name) values($1,$2,'Reused empty team key')", [id,own]);
      assert.equal(await version(teamSide, id), "3");
    });

    await t.test("separate sidecar rows add no contention across team and pointer writes", async () => {
      peer = new client.constructor({ connectionString: lab.url });
      await peer.connect();
      await peer.query("set lock_timeout='2s'");
      await client.query("begin");
      try {
        await client.query("update public.teams set is_active=false where id=$1", [selected]);
        await repoint(selected, "983", peer);
        await peer.query("update public.teams set is_active=false where id=$1", [other]);
        assert.equal(await version(pointerSide, selected, peer), "4");
        assert.equal(await version(teamSide, other, peer), "1");
        assert.equal(await version(teamSide, selected, peer), "2");
      } finally {
        await client.query("rollback");
      }
      assert.equal(await version(teamSide), "2");
      assert.equal(await version(pointerSide), "4");
    });

    await t.test("rollback refuses after captures and preserves history", async () => {
      await assert.rejects(client.query(await readFile(rollback, "utf8")), /rollback refused: admission or generation evidence/);
      await client.query("rollback");
      assert.equal(await version(teamSide), "2");
      assert.equal(await version(pointerSide), "4");
    });
    assert.deepEqual((await client.query("select enabled, epoch from training_load.source_provider_admission")).rows,
      [{ enabled:false, epoch:"0" }]);
    assert.equal((await client.query("select 1 from training_load.source_provider_attempts")).rowCount, 0);
  } finally {
    await previous?.stop();
    await peer?.end();
    if (grants) {
      await client.query("revoke select, update(is_active) on public.teams from authenticated");
      await client.query("revoke usage on schema training_load from authenticated");
      await client.query("alter default privileges in schema training_load revoke all on tables from public,anon,authenticated,service_role");
      await client.query("alter default privileges in schema training_load revoke execute on functions from anon,authenticated,service_role");
    }
    for (const role of created) await client.query("drop role " + role);
    await lab.drop();
  }
});
