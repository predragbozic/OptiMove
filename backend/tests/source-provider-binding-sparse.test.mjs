import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { fixtures } from "./support/permission-roles-world.mjs";

const pointerFixture = new URL("./support/source-provider-binding-generation-fixture.sql", import.meta.url);
const pointers = "training_load.gpexe_team_settings";
const bindings = "training_load.source_team_bindings";

test("bound set, team and approved pointer snapshots advance independently with Sources closed", async t => {
  const lab = await createPagesDatabase({ through: "202612191000", label: "binding_generations" });
  const { client } = lab;
  let peer;
  try {
    const world = fixtures(client);
    const club = await world.club("Binding generations home");
    const otherClub = await world.club("Binding generations other");
    const actor = await world.user("Binding generation actor");
    const selected = await world.team(club, "Selected");
    const adjacent = await world.team(club, "Adjacent");
    const legacy = await world.team(club, "Legacy");
    const create = async (label) => (await client.query(
      `insert into training_load.source_credential_connections(source_system,owner_scope,owner_club_id,host_key,account_label,credential_kind,created_by_user_id)
      values('gpexe','club',$1,'server3',$2,'exchanged_token',$3) returning id`, [club,label,actor],
    )).rows[0].id;
    const subjectConnection = await create("Subject");
    const legacyConnection = await create("Legacy");
    const approve = (team, pair) => client.query(
      `insert into ${pointers}(owner_team_id,gpexe_team_id,configured_by_user_id) values($1,$2,$3)`, [team,pair,actor],
    );
    const repoint = (team, pair) => client.query(
      `update ${pointers} set gpexe_team_id=$2,change_reason='Approved change in disposable fixture',configured_at=clock_timestamp()
      where owner_team_id=$1`, [team,pair],
    );
    const bind = async (team, pair, connection = subjectConnection, executor = client) => (await executor.query(
      `insert into ${bindings}(team_id,connection_id,source_system,source_team_id,bound_by_user_id,legacy_gpexe_settings_team_id)
      values($1,$2,'gpexe',$3,$4,$1) returning id`, [team,connection,pair,actor],
    )).rows[0].id;
    const unbind = (id) => client.query(
      `update ${bindings} set state='ended',ended_at=clock_timestamp(),ended_by_user_id=$2,end_reason='Disposable unbind'
      where id=$1 and state='active'`, [id,actor],
    );
    const team = async (id = selected) => (await client.query(
      "select club_id,is_active,provider_generation from public.teams where id=$1", [id],
    )).rows[0];
    const pointer = async (id = selected) => (await client.query(
      `select coalesce((select provider_generation from ${pointers} where owner_team_id=$1),0) as generation`, [id],
    )).rows[0].generation;
    const history = async (id = selected) => (await client.query(
      "select count(*)::int hits from training_load.gpexe_team_settings_history where owner_team_id=$1", [id],
    )).rows[0].hits;
    const snapshot = async (id = subjectConnection, executor = client) => { const {generation,oracle,active} = (await executor.query(
      `select training_load.source_binding_sparse_generation($1) as generation, training_load.source_binding_generation($1) as oracle,
        array(select team_id from ${bindings} where connection_id=$1 and state='active' order by team_id) as active`, [id],
    )).rows[0]; assert.equal(generation,oracle); return {generation,active}; };
    const move = (owner, id = selected) => client.query("update public.teams set club_id=$2 where id=$1", [id,owner]);

    await approve(legacy, "00701");
    const historical = await bind(legacy, "701", legacyConnection);
    await unbind(historical);
    await client.query(await readFile(pointerFixture, "utf8"));
    const readDraft = name => readFile(new URL(`./support/source-provider-binding-sparse-${name}.draft.sql`, import.meta.url), "utf8");
    const up = await readDraft("up");
    const down = await readDraft("down");
    await client.query(`
      create role anon;
      create role authenticated;
      create role service_role;
      alter default privileges in schema training_load grant all on tables to anon,authenticated,service_role;
      alter default privileges in schema training_load grant execute on functions to anon,authenticated,service_role;
    `);
    const getTriggers = async () => (await client.query(`
      select tgname,tgenabled,tgtype,md5(prosrc) as body
      from pg_trigger t join pg_proc p on t.tgfoid=p.oid
      where tgrelid='training_load.source_team_bindings'::regclass and not tgisinternal
      order by tgname
    `)).rows;
    const pre = await getTriggers();
    await t.test("draft SQL cleans the API defaults and immediate down restores the trigger catalogue", async () => {
      await client.query(up);
      const privateAcl = await client.query(`
        select rolname from pg_roles
        where rolname in ('anon','authenticated','service_role')
          and (has_table_privilege(oid,'training_load.source_binding_sparse_delta','SELECT,UPDATE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            or has_function_privilege(oid,'training_load.source_binding_sparse_generation(uuid)','EXECUTE'))
      `);
      assert.equal(privateAcl.rowCount, 0);
      await client.query(down);
      assert.deepEqual(await getTriggers(), pre);
      assert.equal((await client.query("select to_regclass('training_load.source_binding_sparse_delta') as delta")).rows[0].delta, null);
      await client.query(up);
    });

    let activeBinding;
    await t.test("old rows keep their history; missing and first-approved pointer snapshots differ", async () => {
      assert.equal(await pointer(legacy), "1");
      assert.deepEqual(await snapshot(legacyConnection), { generation: "2", active: [] });
      assert.equal(await pointer(), "0");
      assert.equal((await team()).provider_generation, "0");
      await approve(selected, "00981");
      assert.equal(await pointer(), "1");
      const priorHistory = await history();
      const repeated = await client.query(
        `update ${pointers} set gpexe_team_id=gpexe_team_id,provider_generation=500 where owner_team_id=$1`, [selected],
      );
      assert.equal(repeated.rowCount, 0, "the legacy guard still cancels exact no-ops");
      assert.equal(await history(), priorHistory);
      await repoint(selected, "981");
      assert.equal(await history(), priorHistory + 1, "raw canonical reformat keeps the legacy audit behavior");
      assert.equal(await pointer(), "1", "the effective approved pair did not change");
      assert.equal(await pointer(adjacent), "0");
    });

    await t.test("Bind and Unbind preserve the approved pair and existing SQL refusals", async () => {
      await assert.rejects(bind(selected, "982"), { code: "23514", constraint: "source_team_bindings_approved_pair" });
      assert.deepEqual(await snapshot(), { generation: "0", active: [] });
      activeBinding = await bind(selected, "981");
      assert.deepEqual(await snapshot(), { generation: "1", active: [selected] });
      await assert.rejects(repoint(selected, "983"), { code: "23514", constraint: "gpexe_team_settings_bound_team_final" });
      await assert.rejects(move(otherClub), { code: "23514" });
      assert.equal((await team()).provider_generation, "0");
      const ended = await unbind(activeBinding);
      assert.equal(ended.rowCount, 1);
      assert.equal((await unbind(activeBinding)).rowCount, 0);
      await assert.rejects(client.query(`delete from ${bindings} where id=$1`, [activeBinding]), /keeps history/i);
      assert.deepEqual(await snapshot(), { generation: "2", active: [] });
      assert.equal(await pointer(), "1");
      assert.equal((await team()).provider_generation, "0");
    });

    await t.test("real pointer and team changes, including round trips, invalidate their own snapshots", async () => {
      await repoint(selected, "983");
      assert.equal(await pointer(), "2");
      await move(otherClub);
      assert.deepEqual(await team(), { club_id: otherClub, is_active: true, provider_generation: "1" });
      await assert.rejects(bind(selected, "983"), { code: "23514" });
      await move(club);
      assert.equal((await team()).provider_generation, "2");
      await client.query("update public.teams set name='Updated display',provider_generation=9000 where id=$1", [selected]);
      assert.equal((await team()).provider_generation, "2", "display-only updates leave the version unchanged");
      for (const active of [false, true]) {
        await client.query("update public.teams set is_active=$2 where id=$1", [selected,active]);
      }
      assert.equal((await team()).provider_generation, "4");
      assert.equal((await team(adjacent)).provider_generation, "0");
      await approve(adjacent, "984");
      await client.query("begin");
      try {
        await repoint(adjacent, "985");
        await move(otherClub, adjacent);
        assert.equal(await pointer(adjacent), "2");
        assert.equal((await team(adjacent)).provider_generation, "1");
      } finally {
        await client.query("rollback");
      }
      assert.equal(await pointer(adjacent), "1");
      assert.equal((await team(adjacent)).provider_generation, "0");
      assert.deepEqual(await snapshot(), { generation: "2", active: [] });
    });

    await t.test("independent binds on one connection can commit in reverse order without generation loss", async () => {
      peer = new client.constructor({ connectionString: lab.url });
      await peer.connect();
      await peer.query("set lock_timeout='2s'");
      await client.query("begin");
      try {
        activeBinding = await bind(selected, "983");
        await bind(adjacent, "984", subjectConnection, peer);
        assert.deepEqual(await snapshot(subjectConnection, peer), { generation: "3", active: [adjacent] });
        await client.query("commit");
      } finally {
        await client.query("rollback");
      }
      assert.deepEqual(await snapshot(), { generation: "4", active: [selected,adjacent].sort() });
      assert.deepEqual(await snapshot(legacyConnection), { generation: "2", active: [] });
      await unbind(activeBinding);
      assert.deepEqual(await snapshot(), { generation: "5", active: [adjacent] });
    });

    await t.test("direct ended insert increments twice, rollback may not leave a delta", async () => {
      const previously = await snapshot();
      const directEnded = () => client.query(
        `insert into ${bindings}(team_id,connection_id,source_system,source_team_id,bound_by_user_id,state,ended_at,ended_by_user_id,end_reason)
         values($1,$2,'gpexe','986',$3,'ended',clock_timestamp(),$3,'Disposable historical insert')`,
        [legacy, subjectConnection, actor],
      );
      await client.query("begin");
      try {
        await directEnded();
        assert.deepEqual(await snapshot(), {generation: String(Number(previously.generation)+2), active: previously.active});
      } finally {
        await client.query("rollback");
      }
      assert.deepEqual(await snapshot(), previously);
      await directEnded();
      assert.deepEqual(await snapshot(), {generation: String(Number(previously.generation)+2), active: previously.active});
    });

    await t.test("generation captured by the actual binding writer prevents rollback", async () => {
      const before = await snapshot();
      await assert.rejects(client.query(down), /Sparse generation already captured/);
      await client.query("rollback");
      assert.deepEqual(await snapshot(), before);
    });
    assert.deepEqual((await client.query("select enabled,epoch from training_load.source_provider_admission")).rows,
      [{ enabled: false, epoch: "0" }]);
    assert.equal((await client.query("select 1 from training_load.source_provider_attempts")).rowCount, 0);
  } finally {
    await peer?.end();
    await lab.drop();
  }
});
