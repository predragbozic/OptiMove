// Preloaded into the e2e SERVER process only (node --import): every request to the one approved GPEXE host
// (https://server3.gpexe.com/) is answered by the in-process fake source of the backend tests (marker credentials,
// no network); every other request goes where it would have gone. Nothing here changes the application's code,
// its host allowlist or its catalog.
import { createFakeSource } from "../../backend/tests/support/gpexe-fake-source.mjs";

const fake = createFakeSource();
for (const id of (process.env.E2E_FAKE_VISIBLE_TEAMS || "").split(",").filter(Boolean)) fake.show(id);
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => (String(url).startsWith("https://server3.gpexe.com/") ? fake.fetchImpl(url, init) : realFetch(url, init));
