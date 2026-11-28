import http from "node:http";
import { once } from "node:events";

const database = new URL(process.env.DATABASE_URL);
if (!["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) || !/^\/optimove_tests_[a-z0-9_]+$/.test(database.pathname)) {
  throw new Error("Source binding predecessor harness requires a disposable loopback database");
}

const { app } = await import("../../src/server.js");
const { createSession } = await import("../../src/auth.js");
const { pool } = await import("../../src/db.js");
const { setSourceFetchForTests } = await import("../../src/sourceConnectionService.js");
setSourceFetchForTests(() => { throw new Error("Unexpected provider call from Unbind"); });
const server = http.createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const token = await createSession(process.env.SPARSE_FIXTURE_ACTOR);
process.send({ port: server.address().port, cookie: "optimove_session=" + token });
process.on("message", async value => {
  if (value !== "stop") return;
  server.close();
  server.closeAllConnections();
  await pool.end();
  process.disconnect();
});
