import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import pg from "pg";
import { createDisposableDatabase } from "./support/disposable-db.mjs";
import { claimPrototype, installClaimFixture, setBusyFenceFixture, withScopedBusyFenceFixture } from "./support/source-provider-claim-prototype.mjs";
import { compatibleProviderClaimFixture, chosenTeamBindClaimFixture } from "./support/source-provider-claim-compatibility.mjs";

async function fixture(run) {
  const db = await createDisposableDatabase({ prefix: "source_claim", label: "prototype", baseDatabaseUrl: process.env.DATABASE_URL });
  const pool = new pg.Pool({ connectionString: db.url });
  const actor = randomUUID();
  const connection = randomUUID();
  const club = randomUUID();
  const otherActor = randomUUID();
  const otherConnection = randomUUID();
  const otherClub = randomUUID();
  const team = randomUUID();
  const otherTeam = randomUUID();
  try {
    await installClaimFixture(pool);
    await pool.query(`
      create table fixture_authority(actor uuid not null, club uuid not null, allowed boolean not null, primary key(actor,club));
      create table fixture_provider_connection(id uuid primary key, club uuid not null, revision integer not null, verified boolean not null default true, host_generation int not null default 1, credential_generation int not null default 1, binding_generation int not null default 1);
      create table fixture_team(id uuid primary key, club uuid not null, source_team text not null, active boolean not null default true, generation int not null default 1);
      create table fixture_effect(attempt uuid primary key, value text not null);
    `);
    await pool.query("insert into fixture_authority values ($1,$3,true),($2,$3,true),($2,$4,true)", [actor, otherActor, club, otherClub]);
    await pool.query("insert into fixture_provider_connection(id,club,revision) values ($1,$3,1),($2,$3,1)", [connection, otherConnection, club]);
    await pool.query("insert into fixture_team(id,club,source_team) values ($1,$3,'981'),($2,$4,'982')", [team, otherTeam, club, otherClub]);
    const input = (overrides = {}) => ({ actor, connection, club, id: randomUUID(), operation: "connect", ...overrides });
    const authorize = async (client, actual) => {
      const row = (await client.query(`
        select c.revision,c.verified,c.host_generation,c.credential_generation,c.binding_generation from fixture_authority a join fixture_provider_connection c on c.club=a.club
        where a.actor=$1 and a.club=$2 and c.id=$3 and a.allowed for share of a,c
      `, [actual.actor, actual.club, actual.connection])).rows[0];
      if (!row) return null;
      const generation = {
        revision: row.revision, hostGeneration: row.host_generation,
        credentialGeneration: row.credential_generation, bindingGeneration: row.binding_generation,
      };
      if (actual.operation !== "bind" || !actual.team) {
        const teams = [...new Set(actual.fenceTeams ?? [])].sort();
        const owned = teams.length ? (await client.query("select id,generation from fixture_team where id=any($1::uuid[]) and club=$2 and active order by id", [teams, actual.club])).rows : [];
        return owned.length === teams.length ? { ...generation, ...(teams.length ? { teams, teamGenerations: owned.map(team => team.generation) } : {}) } : null;
      }
      const pair = (await client.query("select id,source_team,generation from fixture_team where id=$1 and club=$2 and source_team=$3 and active for share",
        [actual.team, actual.club, actual.sourceTeam])).rows[0];
      return row.verified && pair ? { ...generation, team: pair.id, sourceTeam: pair.source_team, teamGeneration: pair.generation } : null;
    };
    const apply = (client, actual, value) => client.query(
      "insert into fixture_effect values ($1,$2)", [actual.id, value.note ?? JSON.stringify(value.result)],
    );
    const gates = opts => claimPrototype({ pool, authorize, apply, leaseMs: 4_000, ioMs: 2_000, ...opts });
    const rows = async () => (await pool.query("select * from source_claim_fixture order by reserved_at")).rows;
    const effects = async () => (await pool.query("select * from fixture_effect order by attempt")).rows;
    await run({ pool, actor, otherActor, otherConnection, otherClub, connection, club, team, otherTeam, input, gates, rows, effects });
  } finally {
    await pool.end();
    await db.drop();
  }
}

function latch() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

test("a pending fake call fences actor and connection independently and holds no database row locks", async () => fixture(async f => {
  const started = latch();
  const finish = latch();
  let calls = 0;
  const run = f.gates({ adapter: async () => { calls++; started.release(); await finish.promise; return { ok: true, note: "fake success" }; } });
  const first = f.input();
  const pending = run(first);
  try {
    await started.promise;
    assert.deepEqual(await run(f.input({ connection: f.otherConnection })), { status: "busy" });
    assert.deepEqual(await run(f.input({ actor: f.otherActor })), { status: "busy" });
    assert.deepEqual(await run(first), { status: "pending" });
    assert.equal(calls, 1);
    const writer = await f.pool.connect();
    try {
      await writer.query("begin");
      await writer.query("set local lock_timeout='200ms'");
      const changed = await writer.query("update fixture_provider_connection set revision=revision+1 where id=$1", [f.connection]);
      assert.equal(changed.rowCount, 1, "provider I/O held no DB lock across the call");
      await writer.query("rollback");
    } finally {
      writer.release();
    }
  } finally {
    finish.release();
  }
  assert.deepEqual(await pending, { status: "succeeded" });
  assert.deepEqual(await run(first), { status: "succeeded" });
  assert.equal(calls, 1);
  assert.equal((await f.effects()).length, 1);
}));

test("both 5/15 minute budgets count distinct attempts and success Bind remains exempt", async () => fixture(async f => {
  let calls = 0;
  const run = f.gates({ adapter: async () => { calls++; return { ok: true, note: "fake success" }; } });
  const old = f.input();
  await f.pool.query("insert into source_claim_legacy_budget_fixture values ($1,$2,$3,now())", [old.id, old.actor, old.connection]);
  for (let n = 0; n < 4; n++) assert.deepEqual(await run(f.input()), { status: "succeeded" });
  assert.deepEqual(await run(f.input({ connection: f.otherConnection })), { status: "throttled" });
  assert.deepEqual(await run(f.input({ actor: f.otherActor })), { status: "throttled" });
  assert.equal(calls, 4);
  const binds = f.input({ actor: f.otherActor, connection: f.otherConnection, operation: "bind" });
  assert.deepEqual(await run(binds), { status: "succeeded" });
  assert.equal((await f.rows()).find(row => row.id === binds.id).counted, false);
  assert.equal(calls, 5);
}));

test("revocation suppresses effects and protected replay after I/O", async () => fixture(async f => {
  const started = latch();
  const finish = latch();
  const run = f.gates({ adapter: async () => { started.release(); await finish.promise; return { ok: true, note: "private fake" }; } });
  const request = f.input();
  const pending = run(request);
  try {
    await started.promise;
    await f.pool.query("update fixture_authority set allowed=false where actor=$1 and club=$2", [f.actor, f.club]);
  } finally {
    finish.release();
  }
  assert.deepEqual(await pending, { status: "missing" });
  assert.deepEqual(await run(request), { status: "missing" });
  assert.deepEqual(await run({ ...request, actor: f.otherActor, club: f.otherClub }), { status: "missing" });
  assert.equal((await f.effects()).length, 0);
  assert.deepEqual((await f.rows()).map(row => [row.state, row.counted]), [["unknown", true]]);
}));

test("uncertain reserve and finalize prove one effect and never send the same attempt twice", async () => fixture(async f => {
  let calls = 0;
  const lost = async client => { await client.query("commit"); throw new Error("Lost fake COMMIT reply"); };
  const run = f.gates({ adapter: async () => { calls++; return { ok: true, note: "committed" }; }, prepareCommit: lost, finalizeCommit: lost });
  const request = f.input();
  assert.deepEqual(await run(request), { status: "succeeded" });
  assert.deepEqual(await run(request), { status: "unknown" });
  assert.equal(calls, 1);
  assert.equal((await f.effects()).length, 1);
  const refused = f.gates({ adapter: async () => { throw new Error("Must never call"); }, prepareCommit: async client => { await client.query("rollback"); throw new Error("Lost and rolled back"); } });
  const unsuccessful = f.input();
  assert.deepEqual(await refused(unsuccessful), { status: "unknown" });
  assert.equal((await f.rows()).some(row => row.id === unsuccessful.id), false);
}));

test("deadline and expired pending claims cannot overwrite a later fake effect or resend", async () => fixture(async f => {
  const started = latch();
  const finish = latch();
  let calls = 0;
  const slow = f.gates({ ioMs: 75, leaseMs: 1_000, adapter: async () => {
    calls++; started.release(); await finish.promise; return { ok: true, note: "late fake result" };
  } });
  const first = f.input();
  const pending = slow(first);
  await started.promise;
  await delay(100);
  assert.deepEqual(await pending, { status: "unknown" });
  const next = f.input();
  const run = f.gates({ adapter: async () => { calls++; return { ok: true, note: "next authorized result" }; } });
  assert.deepEqual(await run(next), { status: "busy" });
  finish.release();
  await delay(1_050);
  assert.deepEqual(await run(next), { status: "succeeded" });
  assert.deepEqual(await run(first), { status: "unknown" });
  assert.equal(calls, 2);
  assert.deepEqual((await f.effects()).map(row => row.attempt), [next.id]);
}));

test("expired dispatch is unknown even if its previous handler never finalized", async () => fixture(async f => {
  const first = f.input();
  await f.pool.query(`insert into source_claim_fixture
    values ($1,$2,$3,$4,$5,$6,'{"revision":1,"hostGeneration":1,"credentialGeneration":1,"bindingGeneration":1}','dispatching',true,now()-interval '5 seconds',now()-interval '1 second',now()-interval '4 seconds')`,
  [first.id, randomUUID(), first.actor, first.connection, first.club, first.operation]);
  let calls = 0;
  const run = f.gates({ adapter: async () => { calls++; return { ok: true, note: "new dispatch" }; } });
  const second = f.input();
  assert.deepEqual(await run(second), { status: "succeeded" });
  assert.deepEqual(await run(first), { status: "unknown" });
  assert.equal(calls, 1);
  assert.deepEqual((await f.effects()).map(row => row.attempt), [second.id]);
}));

test("a changed connection generation invalidates a completed fake reply", async () => fixture(async f => {
  const started = latch();
  const finish = latch();
  const run = f.gates({ adapter: async () => { started.release(); await finish.promise; return { ok: true, note: "superseded" }; } });
  const pending = run(f.input());
  try {
    await started.promise;
    await f.pool.query("update fixture_provider_connection set revision=revision+1 where id=$1", [f.connection]);
  } finally {
    finish.release();
  }
  assert.deepEqual(await pending, { status: "missing" });
  assert.equal((await f.effects()).length, 0);
  assert.deepEqual((await f.rows()).map(row => [row.state, row.counted]), [["unknown", true]]);
}));

test("the compatibility adapter is closed until explicitly enabled and keeps existing protocol and state outcomes", async () => fixture(async f => {
  const make = (extra) => f.gates(extra);
  const disabled = compatibleProviderClaimFixture(() => { throw new Error("No reservation while disabled"); });
  assert.deepEqual(await disabled(f.input()), { status: "disabled" });
  assert.equal((await f.rows()).length, 0);

  const row = { source_system: "gpexe", host_key: "server3" };
  const catalog = { ...row, state: "approved" };
  const providerBase = "https://server3.gpexe.com/";
  const simulatedPair = { username: "fake@example.invalid", password: "fake-input" };
  const simulatedToken = "fixture-token";
  const cases = [
    { operation: "connect", status: "succeeded", http: 200, state: "verified", error: null, exchange: 200, read: 200 },
    { operation: "reconnect", status: "failed", http: 409, state: null, error: "source_auth_rejected", exchange: 401 },
    { operation: "reconnect", status: "failed", http: 200, state: "linked_untested", error: "source_unavailable", exchange: 200, read: 503 },
    { operation: "test", status: "failed", http: 200, state: "needs_reconnect", error: "source_auth_rejected", read: 401 },
    { operation: "test", status: "failed", http: 200, state: "source_unavailable", error: "source_unavailable", read: 503 },
  ];
  for (const expected of cases) {
    const calls = [];
    const offline = compatibleProviderClaimFixture(make, {
      enabled: true, row, catalog, bindings: [{ source_team_id: "981", team_active: true }],
      inputPair: simulatedPair, storedToken: simulatedToken,
      fetchFixture: async (url, init) => {
        const relative = String(url).replace(providerBase, "");
        calls.push([init.method ?? "GET", relative, init.redirect]);
        if (relative === "api-token-auth/") {
          const fields = new URLSearchParams(init.body);
          assert.deepEqual(Object.fromEntries(fields), simulatedPair);
          return Response.json({ token: simulatedToken }, { status: expected.exchange });
        }
        assert.equal(init.headers.Authorization, "Token " + simulatedToken);
        if (relative === "rest/v1/team/") {
          return Response.json([{ id: 981, name: "Fake team" }],
            { status: expected.read, headers: { "x-total-count": "1" } });
        }
        assert.equal(relative, "rest/v1/team/981/");
        return Response.json({ id: 981, name: "Fake team" }, { status: 200 });
      },
    });
    const request = f.input({ operation: expected.operation });
    assert.deepEqual(await offline(request), { status: expected.status });
    const publicEffect = JSON.parse((await f.effects()).find(effect => effect.attempt === request.id).value);
    assert.deepEqual([publicEffect.http, publicEffect.state, publicEffect.error], [expected.http, expected.state, expected.error]);
    const trace = [];
    if (expected.exchange) trace.push(["POST", "api-token-auth/", "manual"]);
    if (expected.read) trace.push(["GET", "rest/v1/team/", "manual"]);
    if (expected.read === 200) trace.push(["GET", "rest/v1/team/981/", "manual"]);
    assert.deepEqual(calls, trace);
    const replay = await offline(request);
    assert.deepEqual(replay, { status: expected.status });
    assert.deepEqual(calls, trace, "replay never reaches the fake provider again");
    assert.equal((await f.rows()).find(claim => claim.id === request.id).counted, true);
    assert.equal(JSON.stringify(await f.rows()).includes(simulatedToken), false);
  }
  // Five reached attempts charge both axes. The legacy threshold permits no
  // sixth call on either of the independently varied axes.
  const forbidden = compatibleProviderClaimFixture(make, { enabled: true, row, catalog, bindings: [],
    fetchFixture: () => assert.fail("A throttled attempt may not send") });
  assert.deepEqual(await forbidden(f.input({ actor: f.otherActor, operation: "test" })), { status: "throttled" });
  assert.deepEqual(await forbidden(f.input({ connection: f.otherConnection, operation: "test" })), { status: "throttled" });
}));

test("chosen-team Bind verifies only the approved team and successful distinct bindings do not consume either quota", async () => fixture(async f => {
  const row = { source_system: "gpexe", host_key: "server3" };
  const catalog = { ...row, state: "approved" };
  const calls = [];
  const offline = chosenTeamBindClaimFixture(f.gates, {
    enabled: true, row, catalog, storedToken: "fake-token",
    fetchFixture: async (url, init) => {
      const match = String(url).match(/^https:\/\/server3\.gpexe\.com\/rest\/v1\/team\/(\d+)\/$/);
      assert.ok(match, "only the exact chosen-team read is allowed");
      assert.equal(init.method ?? "GET", "GET");
      assert.equal(init.redirect, "manual");
      calls.push(match[1]);
      return Response.json({ id: Number(match[1]), name: "Fake team" });
    },
  });
  const bind = (overrides = {}) => f.input({ operation: "bind", team: f.team, sourceTeam: "981", ...overrides });
  assert.deepEqual(await offline(bind({ team: f.otherTeam, sourceTeam: "982" })), { status: "missing" });
  assert.deepEqual(await offline(bind({ actor: f.otherActor, club: f.otherClub, team: f.otherTeam, sourceTeam: "982" })), { status: "missing" });
  assert.deepEqual(await offline(bind({ sourceTeam: "982" })), { status: "missing" });
  await f.pool.query("update fixture_team set active=false where id=$1", [f.team]);
  assert.deepEqual(await offline(bind()), { status: "missing" });
  await f.pool.query("update fixture_team set active=true where id=$1", [f.team]);
  await f.pool.query("update fixture_provider_connection set verified=false where id=$1", [f.connection]);
  assert.deepEqual(await offline(bind()), { status: "missing" });
  await f.pool.query("update fixture_provider_connection set verified=true where id=$1", [f.connection]);
  assert.deepEqual(calls, []);

  for (const sourceTeam of ["981", "983", "984", "985", "986", "987"]) {
    const team = sourceTeam === "981" ? f.team : randomUUID();
    if (team !== f.team) await f.pool.query("insert into fixture_team(id,club,source_team) values($1,$2,$3)", [team, f.club, sourceTeam]);
    const request = bind({ team, sourceTeam });
    assert.deepEqual(await offline(request), { status: "succeeded" });
    assert.deepEqual(await offline(request), { status: "succeeded" });
    assert.deepEqual(JSON.parse((await f.effects()).find(effect => effect.attempt === request.id).value), {
      http: 201, outcome: "ok", error: null, bind: true, markNeedsReconnect: false,
    });
  }
  assert.deepEqual(calls, ["981", "983", "984", "985", "986", "987"]);
  assert.ok((await f.rows()).every(claim => claim.counted === false));
}));

test("chosen-team Bind charges reached errors once on both axes, and a pointer change fences a pending error", async () => fixture(async f => {
  const row = { source_system: "gpexe", host_key: "server3" };
  const catalog = { ...row, state: "approved" };
  let calls = 0;
  const called = latch();
  const upstream = latch();
  const offline = chosenTeamBindClaimFixture(f.gates, {
    enabled: true, row, catalog, storedToken: "fake-token",
    fetchFixture: async (url) => {
      calls++;
      if (calls === 1) {
        called.release();
        assert.ok(String(url).endsWith("/team/981/"));
        await upstream.promise;
      } else assert.ok(String(url).endsWith("/team/989/"));
      return Response.json({}, { status: calls === 2 ? 401 : 503 });
    },
  });
  const bind = (overrides = {}) => f.input({ operation: "bind", team: f.team, sourceTeam: "981", ...overrides });
  const stale = bind();
  const pending = offline(stale);
  try {
    await called.promise;
    await f.pool.query("update fixture_team set source_team='989' where id=$1", [f.team]);
  } finally {
    upstream.release();
  }
  assert.deepEqual(await pending, { status: "missing" });
  assert.deepEqual(await offline(stale), { status: "missing" });
  assert.equal((await f.effects()).length, 0);
  assert.deepEqual(await offline(bind({ sourceTeam: "989" })), { status: "busy" });
  await delay(4_050);
  for (let i = 0; i < 4; i++) {
    const failed = bind({ sourceTeam: "989" });
    assert.deepEqual(await offline(failed), { status: "failed" });
    assert.deepEqual(await offline(failed), { status: "failed" });
    const effect = JSON.parse((await f.effects()).find(entry => entry.attempt === failed.id).value);
    assert.deepEqual(effect, i === 0
      ? { http: 409, outcome: "refused", error: "source_auth_rejected", bind: false, markNeedsReconnect: true }
      : { http: 502, outcome: "failed", error: "source_unavailable", bind: false, markNeedsReconnect: false });
  }
  assert.deepEqual(await offline(bind({ connection: f.otherConnection, sourceTeam: "989" })), { status: "throttled" });
  assert.deepEqual(await offline(bind({ actor: f.otherActor, sourceTeam: "989" })), { status: "throttled" });
  assert.equal(calls, 5);
}));

test("scoped durable fence preserves fast team busy, bounded wait and unrelated activity during fake I/O", async () => fixture(async f => {
  const started = latch();
  const finish = latch();
  const run = f.gates({ busyFence: true, adapter: async () => {
    started.release();
    await finish.promise;
    return { ok: true, note: "current fake" };
  } });
  const request = f.input({ fenceTeams: [f.team] });
  assert.deepEqual(await run(request), { status: "disabled" });
  assert.deepEqual(await setBusyFenceFixture(f.pool, { enabled: true }), { status: "previous_producers_running" });
  assert.deepEqual(await setBusyFenceFixture(f.pool, { enabled: true, previousDrained: true }), { status: "ok" });

  const busyRun = run(request);
  await started.promise;
  const writer = (where, write = async () => ({ status: "ok" })) => withScopedBusyFenceFixture(f.pool, where, write);
  let waiting;
  try {
    assert.deepEqual(await writer({ operation: "import", team: f.team }), { status: "busy" });
    assert.deepEqual(await writer({ operation: "approved_pointer", team: f.team, waitMs: 45 }), { status: "busy" });
    assert.deepEqual(await writer({ operation: "unbind", team: f.otherTeam, connection: f.connection }), { status: "busy" });
    assert.deepEqual(await writer({ operation: "import", team: f.otherTeam }), { status: "ok" });
    assert.deepEqual(await writer({ operation: "unbind", team: f.otherTeam, connection: f.otherConnection }), { status: "ok" });
    assert.deepEqual(await writer({ operation: "ordinary_team_read", team: f.team }), { status: "ok" });
    assert.deepEqual(await setBusyFenceFixture(f.pool, { enabled: false, rollback: true }), { status: "pending_claims" });
    assert.deepEqual(await setBusyFenceFixture(f.pool, { enabled: false }), { status: "ok" });
    assert.deepEqual(await run(f.input({ connection: f.otherConnection })), { status: "disabled" });
    assert.deepEqual(await writer({ operation: "check", team: f.team }), { status: "busy" });
    waiting = writer({ operation: "approved_pointer", team: f.team, waitMs: 300 });
  } finally {
    finish.release();
  }
  assert.deepEqual(await busyRun, { status: "succeeded" });
  assert.deepEqual(await waiting, { status: "ok" });
  assert.deepEqual(await setBusyFenceFixture(f.pool, { enabled: false, rollback: true }), { status: "durable_claim_evidence" });
}));

test("a legacy bypass illustrates why claim producers and conflicting writers must participate before enablement", async () => fixture(async f => {
  const started = latch();
  const finish = latch();
  await setBusyFenceFixture(f.pool, { enabled: true, previousDrained: true });
  const run = f.gates({ busyFence: true, adapter: async () => {
    started.release();
    await finish.promise;
    return { ok: true, note: "stale fake" };
  } });
  const first = f.input({ fenceTeams: [f.team] });
  const pending = run(first);
  try {
    await started.promise;
    // This simulates an old worker that uses the preexisting advisory but
    // ignores the durable fence after the provider released its transaction.
    const old = await f.pool.connect();
    try {
      await old.query("begin");
      const { rows: [held] } = await old.query(
        "select pg_try_advisory_xact_lock(hashtextextended($1,21)) locked", ["gpexe-import-team:" + f.team],
      );
      assert.equal(held.locked, true);
      await old.query("update fixture_provider_connection set revision=revision+1 where id=$1", [f.connection]);
      await old.query("commit");
    } finally {
      old.release();
    }
  } finally {
    finish.release();
  }
  assert.deepEqual(await pending, { status: "missing" });
  assert.deepEqual(await f.effects(), []);
  assert.equal((await f.rows())[0].state, "unknown");
}));

test("database protects the atomic pair, nonce, fence and private snapshot before and after terminalization", async () => fixture(async f => {
  assert.deepEqual(await setBusyFenceFixture(f.pool, { enabled: false, rollback: true }), { status: "ok" });
  await setBusyFenceFixture(f.pool, { enabled: true, previousDrained: true });
  const started = latch();
  const finish = latch();
  const run = f.gates({ busyFence: true, adapter: async () => {
    started.release();
    await finish.promise;
    return { ok: true, note: "ok" };
  } });
  const input = f.input({ fenceTeams: [f.team] });
  const pending = run(input);
  try {
    await started.promise;
    const rejected = query => assert.rejects(query, { code: "23514" });
    await rejected(f.pool.query("update source_claim_fixture set connection=$2 where id=$1", [input.id, f.otherConnection]));
    await rejected(f.pool.query("update source_claim_fixture set reservation=$2 where id=$1", [input.id, randomUUID()]));
    await rejected(f.pool.query("update source_claim_fixture set expires_at=expires_at+interval '1 hour' where id=$1", [input.id]));
    await rejected(f.pool.query("insert into source_claim_team_fence_fixture values($1,$2)", [input.id, f.otherTeam]));
    await rejected(f.pool.query("delete from source_claim_team_fence_fixture where attempt=$1", [input.id]));
    await rejected(f.pool.query("insert into source_claim_fixture values($1,$2,$3,$4,$5,'connect',$6,'reserved',true,now(),now()+interval '2 seconds')",
      [randomUUID(), randomUUID(), f.otherActor, randomUUID(), f.club, { revision: 1, token: "forbidden test value" }]));
    await rejected(f.pool.query("insert into source_claim_fixture values($1,$2,$3,$4,$5,'connect',$6,'reserved',true,now(),now()+interval '2 seconds')",
        [randomUUID(), randomUUID(), f.otherActor, randomUUID(), f.club, { revision: 1, teams: [{ token: "nested test value" }] }]));
  } finally {
    finish.release();
  }
  assert.deepEqual(await pending, { status: "succeeded" });
  await assert.rejects(f.pool.query("update source_claim_fixture set state='unknown' where id=$1", [input.id]), { code: "23514" });
  await assert.rejects(f.pool.query("delete from source_claim_fixture where id=$1", [input.id]), { code: "23514" });
  await assert.rejects(f.pool.query("update source_claim_fence_control_fixture set first_effect_at=null"), { code: "23514" });
  assert.deepEqual(await setBusyFenceFixture(f.pool, { enabled: false, rollback: true }), { status: "durable_claim_evidence" });
}));

test("each existing holder generation fences a captured Bind independently", async () => fixture(async f => {
  const pointer = async () => {
    await f.pool.query("update fixture_team set source_team='982',generation=generation+1 where id=$1", [f.team]);
    await f.pool.query("update fixture_team set source_team='981',generation=generation+1 where id=$1", [f.team]);
  };
  const writers = [
    ["approved pointer ABA", pointer],
    ["credential", () => f.pool.query("update fixture_provider_connection set credential_generation=credential_generation+1 where id=$1", [f.connection])],
    ["active bindings", () => f.pool.query("update fixture_provider_connection set binding_generation=binding_generation+1 where id=$1", [f.connection])],
    ["host", () => f.pool.query("update fixture_provider_connection set host_generation=host_generation+1 where id=$1", [f.connection])],
  ];
  for (const [label, change] of writers) {
    const called = latch();
    const complete = latch();
    const run = f.gates({ ioMs: 200, leaseMs: 600, adapter: async () => {
      called.release();
      await complete.promise;
      return { ok: true, note: "old generation" };
    } });
    const old = f.input({ operation: "bind", team: f.team, sourceTeam: "981" });
    const pending = run(old);
    try {
      await Promise.race([called.promise, pending.then(answer => assert.fail(label + ": " + JSON.stringify(answer)))]);
      await change();
    } finally {
      complete.release();
    }
    assert.deepEqual(await pending, { status: "missing" }, label);
    await delay(650);
  }
  assert.deepEqual(await f.effects(), []);
  assert.deepEqual((await f.rows()).map(row => [row.state, row.counted]), writers.map(() => ["unknown", true]));
}));

test("an unconfirmed dispatch consume never sends and preserves the crash fence", async () => fixture(async f => {
  await setBusyFenceFixture(f.pool, { enabled: true, previousDrained: true });
  let calls = 0;
  const run = f.gates({
    busyFence: true,
    ioMs: 150,
    leaseMs: 600,
    adapter: async () => { calls++; return { ok: true, note: "fake provider effect" }; },
    dispatchCommit: async client => {
      await client.query("commit");
      throw new Error("Dispatch COMMIT acknowledgement lost");
    },
  });
  const request = f.input({ fenceTeams: [f.team] });
  assert.deepEqual(await run(request), { status: "unknown" });
  const [claimed] = await f.rows();
  assert.equal(claimed.state, "dispatching");
  assert.ok(claimed.dispatched_at);
  assert.equal(claimed.counted, true);
  const receiving = f.gates({ busyFence: true, adapter: async () => { calls++; return { ok: true, note: "fake provider effect" }; } });
  assert.deepEqual(await receiving(request), { status: "pending" });
  assert.deepEqual(await withScopedBusyFenceFixture(f.pool, { operation: "check", team: f.team }, async () => ({ status: "ok" })), { status: "busy" });
  await delay(650);
  const next = f.input({ fenceTeams: [f.team] });
  assert.deepEqual(await receiving(next), { status: "succeeded" });
  assert.deepEqual(await receiving(request), { status: "unknown" });
  assert.equal(calls, 1);
  assert.deepEqual((await f.effects()).map(row => row.attempt), [next.id]);
}));

test("expiry of an unconsumed reservation releases the tentative debit", async () => fixture(async f => {
  const request = f.input();
  await f.pool.query(`insert into source_claim_fixture
    values ($1,$2,$3,$4,$5,$6,'{"revision":1,"hostGeneration":1,"credentialGeneration":1,"bindingGeneration":1}','reserved',true,now()-interval '5 seconds',now()-interval '1 second')`,
  [request.id, randomUUID(), request.actor, request.connection, request.club, request.operation]);
  let calls = 0;
  const run = f.gates({ adapter: async () => { calls++; return { ok: true, note: "fake provider effect" }; } });
  assert.deepEqual(await run(request), { status: "not_sent" });
  const [expired] = await f.rows();
  assert.equal(expired.counted, false);
  assert.equal(expired.dispatched_at, null);
  assert.equal(calls, 0);
}));
