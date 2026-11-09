// `npm run e2e:demo` (repository root): the whole application on a disposable database with one demo
// account per role. Prints the address and the logins, then runs until Ctrl-C, which stops the server
// and drops the database. Synthetic data only; the passwords are random and exist for this run only.
import { startWorld } from "./lib/world.mjs";
import { FAKE_PASSWORD, FAKE_USERNAME } from "../backend/tests/support/gpexe-fake-source.mjs";

const world = await startWorld({ log: process.argv.includes("--server-log"), fakeSource: { visibleTeams: ["7001", "7002"] } });
const line = "-".repeat(78);
console.log(`\n${line}\nOptiMove demo is running:  ${world.baseUrl}\ndisposable database:       ${world.databaseName} (dropped when you press Ctrl-C)\n${line}`);
console.log("Sign in at the address above with one of these (or open it already signed in with the cookie value):\n");
for (const a of world.accounts) console.log(`  ${a.role.padEnd(18)} ${a.email.padEnd(36)} password: ${a.password}`);
console.log(`\n${line}\nFake GPEXE source (Settings > Source connections; the only approved host answers from memory, no network):\n  username: ${FAKE_USERNAME}\n  password: ${FAKE_PASSWORD}\n  visible GPEXE teams 7001 and 7002 (a platform admin approves a pair in Settings > Data sources first)\n${line}\nTo skip the sign-in form, set the cookie optimove_session to the account's token (printed with --json).\n${line}\n`);
if (process.argv.includes("--json")) console.log(JSON.stringify({ baseUrl: world.baseUrl, accounts: world.accounts.map(({ role, email, password, sessionToken }) => ({ role, email, password, sessionToken })) }, null, 2));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log("\nstopping ...");
  await world.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await new Promise(() => {});
