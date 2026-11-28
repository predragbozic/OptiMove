import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { fixtures } from "./support/permission-roles-world.mjs";

const pointerFixture = new URL("./support/source-provider-binding-generation-fixture.sql", import.meta.url);
const pointers = "training_load.gpexe_team_settings";
const bindings = "training_load.source_team_bindings";
const migration = new URL("../../migrations_v2/202612201000_training_load_v118_sources_provider_binding_generations.sql", import.meta.url);
const readRunbook = name => readFile(new URL(`../../docs/runbooks/sources-provider-v118-${name}.sql`, import.meta.url), "utf8");

test("bound set, team and approved pointer snapshots advance independently with Sources closed", async t => {
  const lab = await createPagesDatabase({ through: "202612191000", label: "binding_generations" });
  const { client } = lab;
  let peer;
  let previousWriter;
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
    const overlapTeam = await world.team(club, "Previous server");
    const overlapConnection = await create("Previous server");
    await approve(overlapTeam, "755");
    const overlapBinding = await bind(overlapTeam, "755", overlapConnection);
    await client.query("insert into public.user_global_roles (user_id,role,is_active) values($1,'platform_admin',true)", [actor]);
    await client.query("insert into public.user_workspace_preferences (user_id,workspace_type,scope_id) values($1,'platform',null)", [actor]);
    previousWriter = fork(new URL("./support/source-provider-binding-old-writer.mjs", import.meta.url), {
      env: { ...process.env, DATABASE_URL: lab.url, SPARSE_FIXTURE_ACTOR: actor },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const [previousEndpoint] = await Promise.race([
      once(previousWriter, "message", { signal: AbortSignal.timeout(10000) }),
      once(previousWriter, "exit").then(([code]) => { throw new Error(`Previous writer exited with ${code}`); }),
    ]);
    await client.query(await readFile(pointerFixture, "utf8"));
    const up = "begin;\n" + await readFile(migration, "utf8") + "\ncommit;";
    const down = await readRunbook("rollback");
    const checks = async name => {
      const results = await client.query(await readRunbook(name));
      const row = results.find(result => result.command === "SELECT")?.rows[0];
      assert.ok(row && Object.values(row).every(Boolean), JSON.stringify(row));
    };
    await checks("preflight");
    await client.query(`
      create role anon;
      create role authenticated;
      create role service_role;
      create role sparse_fixture_writer nologin;
      grant usage on schema training_load, public to sparse_fixture_writer;
      grant select, insert on training_load.source_team_bindings to sparse_fixture_writer;
      grant select, update on training_load.source_credential_connections, training_load.source_host_catalog, public.teams to sparse_fixture_writer;
      alter default privileges in schema training_load grant all on tables to anon,authenticated,service_role;
      alter default privileges in schema training_load grant execute on functions to anon,authenticated,service_role;
    `);
    const getTriggers = async () => (await client.query(`
      select tgname,tgenabled,tgtype,md5(prosrc) as body
      from pg_trigger t join pg_proc p on t.tgfoid=p.oid
      where tgrelid='training_load.source_team_bindings'::regclass and not tgisinternal
      order by tgname
    `)).rows;
    const dumpDb = new URL(lab.url);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(dumpDb.hostname));
    assert.match(dumpDb.port, /^\d+$/);
    assert.match(dumpDb.pathname, /^\/optimove_tests_[a-z0-9_]+$/);
    const dumpSchema = () => execFileSync("pg_dump", [
      "--schema-only", "--no-password", "--host", dumpDb.hostname.replace(/^\[|\]$/g, ""), "--port", dumpDb.port,
      "--username", decodeURIComponent(dumpDb.username), "--dbname", dumpDb.pathname.slice(1),
    ], {
      env: { ...process.env, PGPASSWORD: decodeURIComponent(dumpDb.password) },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }).split(/\r?\n/).filter(line => !/^\\(?:un)?restrict /.test(line)).join("\n");
    const beforeSchema = dumpSchema();
    const peerCheck = new client.constructor({ connectionString: lab.url });
    await peerCheck.connect();
    try {
      await peerCheck.query("begin");
      await peerCheck.query(`update ${bindings} set end_reason=end_reason where false`);
      await assert.rejects(client.query(up), { code: "55P03" });
      await client.query("rollback");
      assert.equal(dumpSchema(), beforeSchema);
    } finally {
      await peerCheck.query("rollback");
      await peerCheck.end();
    }
    const pre = await getTriggers();
    await t.test("v118 cleans the API defaults and immediate down restores the trigger catalogue", async () => {
      await lab.applyThrough("202612201000");
      await checks("postcheck");
      const privateAcl = await client.query(`
        select rolname from pg_roles
        where rolname in ('anon','authenticated','service_role')
          and (has_table_privilege(oid,'training_load.source_binding_sparse_delta','SELECT,UPDATE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            or has_function_privilege(oid,'training_load.source_binding_sparse_generation(uuid)','EXECUTE'))
      `);
      assert.equal(privateAcl.rowCount, 0);
      const capture = "training_load.capture_binding_sparse_delta()";
      const insertAsLegacyWriter = async () => {
        await client.query("begin");
        try {
          await client.query("set local role sparse_fixture_writer");
          await client.query(`
            insert into ${bindings}(team_id,connection_id,source_system,source_team_id,bound_by_user_id,state,ended_at,ended_by_user_id,end_reason)
            values($1,$2,'gpexe','701',$3,'ended',clock_timestamp(),$3,'Restricted predecessor exercise')
          `, [legacy, legacyConnection, actor]);
          await client.query("reset role");
          assert.deepEqual(await snapshot(legacyConnection), { generation: "4", active: [] });
        } finally {
          await client.query("rollback");
        }
      };
      assert.equal((await client.query(`
        select has_table_privilege('sparse_fixture_writer','training_load.source_binding_sparse_delta','INSERT') as can_write
      `)).rows[0].can_write, false);
      await insertAsLegacyWriter();
      for (const [mutation, restore] of [
        ["security invoker", "security definer"],
        ["reset search_path", "set search_path = pg_catalog"],
        ["owner to sparse_fixture_writer", "owner to current_user"],
      ]) {
        await client.query(`alter function ${capture} ${mutation}`);
        try {
          await assert.rejects(checks("postcheck"), /function attributes or ownership drifted/);
          await client.query("rollback");
          await assert.rejects(client.query(down), /function attributes or ownership drifted/);
          await client.query("rollback");
          if (mutation === "security invoker") {
            await assert.rejects(insertAsLegacyWriter(), { code: "42501" });
          }
        } finally {
          await client.query(`alter function ${capture} ${restore}`);
        }
      }
      await checks("postcheck");
      await client.query(down);
      assert.deepEqual(await getTriggers(), pre);
      assert.equal(dumpSchema(), beforeSchema);
      assert.equal((await client.query("select to_regclass('training_load.source_binding_sparse_delta') as delta")).rows[0].delta, null);
      await lab.applyThrough("202612201000");
      await checks("postcheck");
    });

    await t.test("v117 HTTP Unbind process started before capture invalidates the same witness once", async () => {
      const { port, cookie } = previousEndpoint;
      const body = { requestKey: randomUUID(), reason: "Disposable predecessor test",
        expected: { teamId: overlapTeam, sourceTeamId: "755" } };
      const send = () => fetch(`http://127.0.0.1:${port}/api/training-load/sources/gpexe/connections/${overlapConnection}/bindings/${overlapBinding}/unbind`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      assert.deepEqual(await snapshot(overlapConnection), { generation: "1", active: [overlapTeam] });
      const first = await send();
      assert.equal(first.status, 200, await first.text());
      assert.deepEqual(await snapshot(overlapConnection), { generation: "2", active: [] });
      const replay = await send();
      assert.equal(replay.status, 200, await replay.text());
      assert.deepEqual(await snapshot(overlapConnection), { generation: "2", active: [] });
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
    if (previousWriter?.exitCode === null && previousWriter.connected) {
      const ended = once(previousWriter, "exit", { signal: AbortSignal.timeout(10000) });
      previousWriter.send("stop");
      try { await ended; } catch { previousWriter.kill(); }
    }
    await peer?.end();
    await lab.drop();
  }
});

test("actual cap rejects 10,001 pre-existing rows with no capture DDL left behind", async () => {
  const lab = await createPagesDatabase({ through: "202612191000", label: "binding_cap" });
  const { client } = lab;
  try {
    const world = fixtures(client);
    const actor = await world.user("Cap actor");
    const club = await world.club("Cap club");
    const team = await world.team(club, "Cap team");
    const {rows: [connection]} = await client.query(`
      insert into training_load.source_credential_connections
      (source_system,owner_scope,owner_club_id,host_key,account_label,credential_kind,created_by_user_id)
      values('gpexe','club',$1,'server3','Cap account','exchanged_token',$2) returning id
    `, [club, actor]);
    await client.query(`
      insert into ${bindings}(team_id,connection_id,source_system,source_team_id,bound_by_user_id,state,ended_at,ended_by_user_id,end_reason)
      select $1,$2,'gpexe',i::text,$3,'ended',statement_timestamp(),$3,'Disposable cap fixture'
      from generate_series(1,10001) i
    `, [team, connection.id, actor]);
    const up = "begin;\n" + await readFile(migration, "utf8") + "\ncommit;";
    await assert.rejects(client.query(up), /exceeds the 10000-row cap/);
    await client.query("rollback");
    const {rows: [state]} = await client.query(`
      select (select count(*)::int from ${bindings} where connection_id=$1) as history,
        to_regclass('training_load.source_binding_sparse_base') as base,
        to_regclass('training_load.source_binding_sparse_delta') as delta,
        to_regprocedure('training_load.capture_binding_sparse_delta()') as capture
    `, [connection.id]);
    assert.deepEqual(state, {history:10001,base:null,delta:null,capture:null});
  } finally {
    await lab.drop();
  }
});
