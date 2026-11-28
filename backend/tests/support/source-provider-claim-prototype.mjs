import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

export async function installClaimFixture(client) {
  const { rows: [{ name }] } = await client.query("select current_database() as name");
  if (!/^optimove_tests_[a-z0-9_]+$/.test(name)) throw new Error("Disposable database required");
  await client.query(await readFile(new URL("./source-provider-claim-fixture.sql", import.meta.url), "utf8"));
}

async function transaction(pool, body, commit = (client) => client.query("commit")) {
  const client = await pool.connect();
  let committing = false;
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '2s'");
    await client.query("set local statement_timeout = '4s'");
    const answer = await body(client);
    committing = true;
    await commit(client);
    client.release();
    return answer;
  } catch (error) {
    if (committing) client.release(true);
    else {
      const cleaned = await client.query("rollback").then(() => true, () => false);
      client.release(!cleaned);
    }
    throw error;
  }
}

async function lockAxes(client, { actor, connection }) {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,21))", ["source-auth-throttle:" + actor]);
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,21))", ["source-claim-connection:" + connection]);
}

async function lockFenceControl(client, exclusive = false) {
  await client.query(exclusive
    ? "select pg_advisory_xact_lock(hashtextextended('source-claim-control-fixture',21))"
    : "select pg_advisory_xact_lock_shared(hashtextextended('source-claim-control-fixture',21))");
}

async function tryTeamFence(client, teamId) {
  const { rows: [row] } = await client.query(
    "select pg_try_advisory_xact_lock(hashtextextended($1,21)) as locked", ["gpexe-import-team:" + teamId],
  );
  return row.locked;
}

async function liveFence(client, connection, teams) {
  return (await client.query(`
    select 1 from source_claim_fixture p
    where p.state in ('reserved','dispatching','unknown') and p.expires_at>clock_timestamp()
      and (p.connection=$1 or exists(select 1 from source_claim_team_fence_fixture t where t.attempt=p.id and t.team=any($2::uuid[])))
    limit 1
  `, [connection ?? null, teams])).rowCount > 0;
}

export function setBusyFenceFixture(pool, { enabled, previousDrained = false, rollback = false }) {
  return transaction(pool, async (client) => {
    await lockFenceControl(client, true);
    if (enabled && !previousDrained) return { status: "previous_producers_running" };
    if (rollback && (await client.query("select 1 from source_claim_fixture where state in ('reserved','dispatching') limit 1")).rowCount) {
      return { status: "pending_claims" };
    }
    if (rollback && (await client.query(
      "select 1 from source_claim_fence_control_fixture where first_effect_at is not null union all select 1 from source_claim_fixture where state='unknown' and counted limit 1",
    )).rowCount) return { status: "durable_claim_evidence" };
    await client.query("update source_claim_fence_control_fixture set enabled=$1, previous_drained=previous_drained or $2 where singleton", [enabled, previousDrained]);
    return { status: "ok" };
  });
}

// Conflicts apply only to the operations in the deployed lock matrix. A
// bounded waiting writer discards its checkout between each retry.
export async function withScopedBusyFenceFixture(pool, { operation, connection, team, waitMs = 0 }, write) {
  const deadline = Date.now() + waitMs;
  const connectionConflict = operation === "unbind";
  const teamConflict = ["unbind", "import", "check", "approved_pointer"].includes(operation);
  if (!connectionConflict && !teamConflict) return transaction(pool, write);
  do {
    const result = await transaction(pool, async (client) => {
      if (connectionConflict) {
        const { rows: [row] } = await client.query(
          "select pg_try_advisory_xact_lock(hashtextextended($1,21)) as locked", ["source-claim-connection:" + connection],
        );
        if (!row.locked) return { status: "busy" };
      }
      if (teamConflict && !await tryTeamFence(client, team)) return { status: "busy" };
      return await liveFence(client, connectionConflict ? connection : null, teamConflict ? [team] : [])
        ? { status: "busy" } : await write(client);
    });
    if (result.status !== "busy" || Date.now() >= deadline) return result;
    await delay(Math.min(15, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return { status: "busy" };
}

async function timeOf(client) {
  return (await client.query("select clock_timestamp() as now")).rows[0].now;
}

async function expire(client, input, now) {
  await client.query(`
    with stale as (
      select id from source_claim_fixture
      where state in ('reserved','dispatching') and expires_at<=$3 and (actor=$1 or connection=$2)
      order by id for update skip locked
    )
    update source_claim_fixture set state=case when state='reserved' then 'not_sent' else 'unknown' end, counted=(state='dispatching')
    where id in (select id from stale)
  `, [input.actor, input.connection, now]);
}

async function findClaim(client, id) {
  return (await client.query("select * from source_claim_fixture where id=$1", [id])).rows[0];
}

function sameScope(row, input) {
  return row?.actor === input.actor && row.connection === input.connection
    && row.club === input.club && row.operation === input.operation;
}

export function claimPrototype({ pool, authorize, apply, adapter, leaseMs, ioMs, prepareCommit, dispatchCommit, finalizeCommit, busyFence = false }) {
  if (!(Number.isInteger(ioMs) && ioMs > 0 && Number.isInteger(leaseMs) && leaseMs > ioMs)) {
    throw new Error("Provider deadline must end before its claim expires");
  }

  async function prepare(input, reservation) {
    try {
      return await transaction(pool, async (client) => {
        if (busyFence) {
          await lockFenceControl(client);
          const control = await client.query("select enabled from source_claim_fence_control_fixture where singleton");
          if (!control.rows[0]?.enabled) return { status: "disabled" };
        }
        await lockAxes(client, input);
        const snapshot = await authorize(client, input);
        if (!snapshot) return { status: "missing" };
        const now = await timeOf(client);
        await expire(client, input, now);
        const found = await findClaim(client, input.id);
        if (found) return { status: sameScope(found, input) && isDeepStrictEqual(found.snapshot, snapshot) ? (["reserved","dispatching"].includes(found.state) ? "pending" : found.state) : "missing" };
        const teams = busyFence ? [...new Set(snapshot.teams ?? (snapshot.team ? [snapshot.team] : []))].sort() : [];
        for (const team of teams) if (!await tryTeamFence(client, team)) return { status: "busy" };
        if (busyFence && await liveFence(client, input.connection, teams)) return { status: "busy" };
        const inFlight = await client.query("select 1 from source_claim_fixture where (actor=$1 or connection=$2) and state in ('reserved','dispatching','unknown') and expires_at>clock_timestamp()", [input.actor, input.connection]);
        if (inFlight.rowCount) return { status: "busy" };
        const { rows: [used] } = await client.query(`
          with debits as (
            select id,actor,connection from source_claim_fixture where counted and coalesce(dispatched_at,reserved_at)>$3::timestamptz-interval '15 minutes'
            union
            select id,actor,connection from source_claim_legacy_budget_fixture where reached_at>$3::timestamptz-interval '15 minutes'
          )
          select count(*) filter(where actor=$1)::int as by_actor,
                 count(*) filter(where connection=$2)::int as by_connection from debits
        `, [input.actor, input.connection, now]);
        if (used.by_actor >= 5 || used.by_connection >= 5) return { status: "throttled" };
        await client.query(`
          insert into source_claim_fixture (id,reservation,actor,connection,club,operation,snapshot,state,counted,reserved_at,expires_at)
          values ($1,$2,$3,$4,$5,$6,$7,'reserved',true,$8,$9)
        `, [input.id, reservation, input.actor, input.connection, input.club, input.operation, snapshot, now, new Date(+now + leaseMs)]);
        if (teams.length) await client.query("insert into source_claim_team_fence_fixture select $1,unnest($2::uuid[])", [input.id, teams]);
        return { status: "reserved", expiresAt: +now + leaseMs };
      }, prepareCommit);
    } catch {
      // A lost reservation COMMIT is verified once. Only the invocation that
      // generated the persisted nonce may dispatch; a caller retry never can.
      return transaction(pool, async (client) => {
        await lockAxes(client, input);
        const row = await findClaim(client, input.id);
        const snapshot = await authorize(client, input);
        if (!snapshot) return { status: "missing" };
        const now = await timeOf(client);
        return sameScope(row, input) && row.reservation === reservation && row.state === "reserved"
          && +row.expires_at > +now + ioMs && isDeepStrictEqual(row.snapshot, snapshot)
          ? { status: "reserved", expiresAt: +row.expires_at } : { status: "unknown" };
      }).catch(() => ({ status: "unknown" }));
    }
  }

  async function finalize(input, reservation, outcome) {
    try {
      return await transaction(pool, async (client) => {
        await lockAxes(client, input);
        const row = await findClaim(client, input.id);
        const snapshot = await authorize(client, input);
        const now = await timeOf(client);
        if (!sameScope(row, input) || row.reservation !== reservation || row.state !== "dispatching") {
          return { status: snapshot ? "unknown" : "missing" };
        }
        const authorized = isDeepStrictEqual(row.snapshot, snapshot);
        let current = +row.expires_at > +now;
        if (busyFence && current) {
          for (const team of [...new Set(row.snapshot.teams ?? (row.snapshot.team ? [row.snapshot.team] : []))].sort()) {
            if (!await tryTeamFence(client, team)) { current = false; break; }
          }
        }
        const state = authorized && current ? outcome.status : "unknown";
        if (state === "succeeded" || (state === "failed" && outcome.value?.applyEffect)) {
          await apply(client, input, outcome.value);
        }
        if (busyFence && state === "succeeded") {
          await client.query("update source_claim_fence_control_fixture set first_effect_at=clock_timestamp() where singleton and first_effect_at is null");
        }
        await client.query("update source_claim_fixture set state=$2,counted=$3 where id=$1",
          [input.id, state, state !== "not_sent" && !(state === "succeeded" && input.operation === "bind")]);
        return { status: authorized ? state : "missing" };
      }, finalizeCommit);
    } catch {
      // Verification is read-only and can never dispatch again.
      return transaction(pool, async (client) => {
        await lockAxes(client, input);
        const row = await findClaim(client, input.id);
        const snapshot = await authorize(client, input);
        if (!snapshot) return { status: "missing" };
        return { status: sameScope(row, input) && row.reservation === reservation
          && !["reserved","dispatching"].includes(row.state) && isDeepStrictEqual(row.snapshot, snapshot) ? row.state : "unknown" };
      }).catch(() => ({ status: "unknown" }));
    }
  }

  async function consumeDispatch(input, reservation) {
    try {
      return await transaction(pool, async client => {
        if (busyFence) await lockFenceControl(client);
        await lockAxes(client, input);
        const row = await findClaim(client, input.id);
        if (!sameScope(row, input) || row.state !== "reserved" || row.reservation !== reservation) return "unknown";
        const snapshot = await authorize(client, input);
        const control = busyFence ? (await client.query("select enabled from source_claim_fence_control_fixture where singleton")).rows[0] : null;
        if (!isDeepStrictEqual(row.snapshot, snapshot) || (busyFence && !control?.enabled)) {
          await client.query("update source_claim_fixture set state='not_sent', counted=false where id=$1", [row.id]);
          return snapshot ? "not_sent" : "missing";
        }
        const transition = await client.query(`
          update source_claim_fixture set state='dispatching', dispatched_at=clock_timestamp()
          where id=$1 and reservation=$2 and state='reserved'
            and expires_at>clock_timestamp()+($3::integer*interval '1 millisecond')
        `, [row.id, reservation, ioMs]);
        if (transition.rowCount === 1) return "dispatching";
        await client.query("update source_claim_fixture set state='not_sent', counted=false where id=$1", [row.id]);
        return "not_sent";
      }, dispatchCommit);
    } catch {
      // An ambiguous dispatch COMMIT is never permission to send. The
      // persisted claim fences both axes until reconciliation or expiry.
      return "unknown";
    }
  }

  return async function run(input) {
    const reservation = randomUUID();
    const prepared = await prepare(input, reservation);
    if (prepared.status !== "reserved") return prepared;
    const started = performance.now();
    const dispatch = await consumeDispatch(input, reservation);
    if (dispatch !== "dispatching") return { status: dispatch };
    // Conservatively count the entire consume roundtrip against the DB-checked budget.
    const remaining = Math.floor(ioMs - (performance.now() - started));
    if (remaining <= 0) return finalize(input, reservation, { status: "not_sent" });
    const signal = AbortSignal.timeout(remaining);
    const result = await Promise.race([
      Promise.resolve().then(() => adapter(input.operation, signal, input)).then(
        (value) => ({ status: value.sent === false ? "not_sent" : value.ok ? "succeeded" : "failed", value }),
        () => ({ status: "unknown" }),
      ),
      new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: "unknown" }), { once: true })),
    ]);
    return finalize(input, reservation, result);
  };
}
