// Preloaded into the e2e SERVER process only (node --import): every request to the one approved GPEXE host
// (https://server3.gpexe.com/) is answered by the in-process fake source of the backend tests (marker credentials,
// no network); every other request goes where it would have gone. Nothing here changes the application's code,
// its host allowlist or its catalog.
import { createFakeSource } from "../../backend/tests/support/gpexe-fake-source.mjs";
import { importsBundles, seriesBundles } from "./imports-fixture.mjs";

const fake = createFakeSource();
for (const id of (process.env.E2E_FAKE_VISIBLE_TEAMS || "").split(",").filter(Boolean)) fake.show(id);
// The Imports scenario: the sessions of GPEXE team 7001 (E2E_FAKE_SESSIONS=imports).
if (process.env.E2E_FAKE_SESSIONS === "imports") fake.serve("7001", importsBundles(7001));
// The batch series scenario (U6a-3): three Ready sessions of team 7001.
if (process.env.E2E_FAKE_SESSIONS === "series") fake.serve("7001", seriesBundles(7001));
// A shorter batch time budget for this server process only (E2E_BATCH_BUDGET_MS), so one click's import goes in several rounds.
if (process.env.E2E_BATCH_BUDGET_MS !== undefined) {
  // The same order as server.js: the backend's .env first, then the application's modules.
  await import("dotenv/config");
  const { setBatchTimeBudgetForTests } = await import("../../backend/src/gpexeImportService.js");
  setBatchTimeBudgetForTests(Number(process.env.E2E_BATCH_BUDGET_MS));
}
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => (String(url).startsWith("https://server3.gpexe.com/") ? fake.fetchImpl(url, init) : realFetch(url, init));
