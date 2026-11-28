import assert from "node:assert/strict";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { fixtures } from "./support/permission-roles-world.mjs";

const connections = "training_load.source_credential_connections";
const hosts = "training_load.source_host_catalog";

test("host and connection generations track comparable state while Sources admission stays closed", async t => {
  const lab = await createPagesDatabase({ through: "202612181000", label: "provider_generations" });
  const { client } = lab;
  let peer;
  try {
    const world = fixtures(client);
    const club = await world.club("Generation club");
    const actor = await world.user("Generation actor");
    const create = async (label) => (await client.query(
      `insert into ${connections}(source_system,owner_scope,owner_club_id,host_key,account_label,credential_kind,created_by_user_id)
      values('gpexe','club',$1,'server3',$2,'exchanged_token',$3) returning id`, [club,label,actor],
    )).rows[0].id;
    const changed = await create("Generation subject");
    const untouched = await create("Independent connection");
    const movable = await create("Host reassignment");
    const host = async (key = "server3") => (await client.query(
      `select state,provider_generation from ${hosts} where source_system='gpexe' and host_key=$1`, [key],
    )).rows[0];
    const connection = async (id = changed) => (await client.query(
      `select state,host_key,provider_generation from ${connections} where id=$1`, [id],
    )).rows[0];
    const generation = async (id) => (await connection(id)).provider_generation;
    await lab.applyThrough("202612191000");

    await t.test("existing and new rows start at zero; legacy display fields and forged counters leave them unchanged", async () => {
      assert.equal(await generation(), "0");
      assert.equal(await generation(await create("After installation")), "0");
      assert.equal((await host()).provider_generation, "0");
      await client.query(`update ${hosts} set label='Updated display', note='Updated note', provider_generation=9000 where host_key='server3'`);
      await client.query(`update ${connections} set account_label='Updated display', updated_at=clock_timestamp(),
        last_error_at=clock_timestamp(), provider_generation=9000 where id=$1`, [changed]);
      assert.equal((await host()).provider_generation, "0");
      assert.equal(await generation(), "0");
    });

    await t.test("a host retirement and re-approval never restore an earlier snapshot token", async () => {
      assert.equal((await host()).state, "approved");
      await client.query(`update ${hosts} set state='retired' where host_key='server3'`);
      assert.deepEqual(await host(), { state: "retired", provider_generation: "1" });
      await client.query(`update ${hosts} set state='retired' where host_key='server3'`);
      assert.equal((await host()).provider_generation, "1");
      await client.query(`update ${hosts} set state='approved' where host_key='server3'`);
      assert.deepEqual(await host(), { state: "approved", provider_generation: "2" });
      assert.equal((await host("e03")).provider_generation, "0");
      assert.equal(await generation(), "0", "host changes do not fan out to dependent connections");
    });

    await t.test("credential, state, and valid host changes mark only the affected connection", async () => {
      await client.query(`update ${connections} set state='verified', last_verified_at=clock_timestamp(),
        credential_ciphertext=decode('ff','hex'), credential_nonce=decode(repeat('01',12),'hex'),
        credential_auth_tag=decode(repeat('02',16),'hex'), credential_key_version=1 where id=$1`, [changed]);
      assert.equal(await generation(), "1", "one generation for an update to several fields");
      await client.query(`update ${connections} set state='verified', last_verified_at=clock_timestamp(), updated_at=clock_timestamp()
        where id=$1`, [changed]);
      assert.equal(await generation(), "1", "a verified Test with unchanged credentials leaves the authorization snapshot valid");
      await client.query(`update ${connections} set credential_nonce=decode(repeat('03',12),'hex') where id=$1`, [changed]);
      assert.equal(await generation(), "2");
      await client.query(`update ${connections} set state='needs_reconnect', last_error_code='source_auth_rejected'
        where id=$1 and state='verified'`, [changed]);
      assert.equal(await generation(), "3");
      await client.query(`update ${connections} set state='verified' where id=$1`, [changed]);
      assert.equal(await generation(), "4");
      await client.query(`update ${connections} set host_key='e03' where id=$1`, [movable]);
      assert.deepEqual(await connection(movable), { state: "not_connected", host_key: "e03", provider_generation: "1" });
      assert.equal(await generation(untouched), "0");
    });

    await t.test("each encrypted field independently changes the connection generation", async () => {
      const id = await create("Independent encrypted fields");
      await client.query(`update ${connections} set state='verified', last_verified_at=clock_timestamp(),
        credential_ciphertext=decode('ff','hex'), credential_nonce=decode(repeat('01',12),'hex'),
        credential_auth_tag=decode(repeat('02',16),'hex'), credential_key_version=1 where id=$1`, [id]);
      for (const [field, expected] of [
        ["credential_ciphertext=decode('ee','hex')", "2"],
        ["credential_auth_tag=decode(repeat('04',16),'hex')", "3"],
        ["credential_key_version=2", "4"],
      ]) {
        await client.query(`update ${connections} set ${field} where id=$1`, [id]);
        assert.equal(await generation(id), expected);
      }
    });

    await t.test("failed writes and rolled back changes leave the version and prior host guards intact", async () => {
      const prevHost = await host();
      const prevConnection = await connection();
      await assert.rejects(client.query(`update ${hosts} set api_family='api' where host_key='server3'`), /API family of a host key is immutable/i);
      await assert.rejects(client.query(`update ${connections} set host_key='e03' where id=$1`, [changed]), /credential context changed/i);
      await client.query("begin");
      try {
        await client.query(`update ${hosts} set state='retired' where host_key='server3'`);
        await client.query(`update ${connections} set state='needs_reconnect', last_error_code='source_auth_rejected' where id=$1`, [changed]);
        assert.equal((await host()).provider_generation, "3");
        assert.equal(await generation(), "5");
      } finally {
        await client.query("rollback");
      }
      assert.deepEqual(await host(), prevHost);
      assert.deepEqual(await connection(), prevConnection);
    });

    await t.test("same-row concurrent generations serialize; other rows remain writable", async () => {
      peer = new client.constructor({ connectionString: lab.url });
      await peer.connect();
      await peer.query("set lock_timeout='2s'");
      await client.query("begin");
      let restore;
      try {
        await client.query(`update ${connections} set state='needs_reconnect', last_error_code='source_auth_rejected' where id=$1`, [changed]);
        await peer.query(`update ${connections} set host_key='e03' where id=$1`, [untouched]);
        assert.equal(await generation(untouched), "1");
        restore = peer.query(`update ${connections} set state='verified' where id=$1 returning provider_generation`, [changed]);
        restore.catch(() => {});
        let blocked = false;
        for (let i = 0; i < 45; i++) {
          const { rows: [{ waiting }] } = await client.query("select cardinality(pg_blocking_pids($1))>0 as waiting", [peer.processID]);
          if (waiting) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 15));
        }
        assert.equal(blocked, true);
        await client.query("commit");
        assert.equal((await restore).rows[0].provider_generation, "6");
      } finally {
        await client.query("rollback");
        await restore?.catch(() => {});
      }
      assert.equal(await generation(), "6");
    });

    const store = "training_load.source_provider_admission";
    assert.deepEqual((await client.query(`select enabled,epoch from ${store}`)).rows, [{ enabled: false, epoch: "0" }]);
    await assert.rejects(client.query(`update ${store} set enabled=true,epoch=1`), /Sources provider storage is closed/);
    assert.equal((await client.query("select 1 from training_load.source_provider_attempts")).rowCount, 0);
  } finally {
    await peer?.end();
    await lab.drop();
  }
});
