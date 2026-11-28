import { sourceConnectionProtocolForTests } from "../../src/sourceConnectionService.js";
import { sourceExchange } from "../../src/sourceHosts.js";

const { exchangeCredential, testReads } = sourceConnectionProtocolForTests;
const PROBED_ACTIONS = new Set(["connect", "reconnect", "test"]);

// Test-only orchestration, default closed. It deliberately accepts an
// injected fetch fixture rather than falling back to the process fetch.
export function compatibleProviderClaimFixture(makeClaim, { enabled = false, ...options } = {}) {
  return enabled
    ? makeClaim({ adapter: buildFakeTransport(options) })
    : async () => ({ status: "disabled" });
}

export function chosenTeamBindClaimFixture(makeClaim, { enabled = false, row, catalog, storedToken, fetchFixture, budgetMs = 1_000 } = {}) {
  if (!enabled) return async () => ({ status: "disabled" });
  if (typeof fetchFixture !== "function") throw new Error("A fake provider is required");
  const run = makeClaim({ adapter: async (_action, signal, input) => {
    let sent = false;
    const fetchImpl = (url, init) => {
      if (signal.aborted) throw signal.reason;
      sent = true;
      return fetchFixture(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
    };
    const read = await testReads({
      row, catalog, token: storedToken, bindings: [], deadline: Date.now() + budgetMs,
      fetchImpl, chosenSourceTeamId: input.sourceTeam,
    });
    if (!sent) return { ok: false, sent };
    const auth = read.code === "source_auth_rejected";
    return {
      ok: read.ok, sent: true, applyEffect: true,
      result: {
        http: read.ok ? 201 : ["source_unavailable", "source_answer_unexpected"].includes(read.code) ? 502 : 409,
        outcome: read.ok ? "ok" : auth ? "refused" : "failed",
        error: read.code, bind: read.ok, markNeedsReconnect: auth,
      },
    };
  } });
  return input => input.operation === "bind" && typeof input.team === "string" && /^[1-9][0-9]{0,11}$/.test(input.sourceTeam ?? "")
    ? run(input) : Promise.resolve({ status: "missing" });
}

function buildFakeTransport({ row, catalog, bindings, fetchFixture, inputPair, storedToken, budgetMs = 1_000 }) {
  if (typeof fetchFixture !== "function") throw new Error("A fake provider is required");
  return async (action, signal) => {
    if (!PROBED_ACTIONS.has(action)) throw new Error("No provider fixture for this action");
    let contacted = false;
    let token = storedToken;
    let exchangeStatusClass = "none";
    const deadline = Date.now() + budgetMs;
    const fetchImpl = (url, init) => {
      if (signal.aborted) throw signal.reason;
      contacted = true;
      const combined = init.signal ? AbortSignal.any([init.signal, signal]) : signal;
      return fetchFixture(url, { ...init, signal: combined });
    };
    if (action !== "test") {
      const spec = sourceExchange(row.source_system, row.host_key, catalog);
      const exchanged = await exchangeCredential({ exchangeSpec: spec, ...inputPair, fetchImpl });
      exchangeStatusClass = exchanged.statusClass;
      if (!exchanged.ok) return {
        ok: false, sent: contacted, applyEffect: contacted,
        result: { http: exchanged.code === "source_auth_rejected" ? 409 : 502,
          outcome: exchanged.code === "source_auth_rejected" ? "refused" : "failed",
          error: exchanged.code, state: null, credentialDirection: "unchanged", exchangeStatusClass },
      };
      token = exchanged.token;
    }
    const read = await testReads({ row, catalog, token, bindings, deadline, fetchImpl });
    if (!contacted) return { ok: false, sent: false };
    const rejected = read.code === "source_auth_rejected";
    const state = read.ok ? "verified" : rejected ? "needs_reconnect" : action === "test" ? "source_unavailable" : "linked_untested";
    return {
      ok: read.ok, sent: true, applyEffect: true,
      result: {
        http: 200, outcome: read.ok ? "ok" : rejected ? "refused" : "failed",
        error: read.code, state, credentialDirection: action === "test" ? "unchanged" : "replace_encrypted",
        boundTeamsChecked: read.boundTeamsChecked, sourceTeamCount: read.sourceTeamCount,
        sourceTeamsTruncated: read.sourceTeamsTruncated ?? null, exchangeStatusClass,
      },
    };
  };
}
