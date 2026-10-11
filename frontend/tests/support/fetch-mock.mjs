// Shared fake `fetch` for frontend action tests (T1 test-infrastructure
// foundation). It replaces the per-file copies of `installFetchMock` that
// 32 suites carried in two shapes:
//
//   installFetchMock((call) => ({ status, body }))   a responder decides per call
//   installFetchMock([{ status, body }, ...])        a queue, one answer per call
//
// Both shapes are accepted. Every call is recorded as
// { url, method, body, rawBody, headers } in the array the function returns
// (the same array the old copies kept in a module-level `fetchCalls`); `body`
// is the parsed JSON of a JSON request body, otherwise the raw body. A
// response is the minimal Response-like object the app's data modules read:
// { ok, status, statusText, json(), text(), headers }, where `ok` follows the
// Fetch standard (200-299). A queue entry or responder result with
// `throwNetworkError: true` makes the call reject with the browser's own
// "Failed to fetch" TypeError, so network-failure paths can be tested.
//
// Usage:
//   import { installFetchMock } from "./support/fetch-mock.mjs";
//   const calls = installFetchMock((call) => (call.url === "/api/x" ? { status: 200, body: {} } : { status: 404, body: {} }));
//   ...
//   assert.equal(calls[0].url, "/api/x");
//
// `restoreFetch()` puts back whatever `globalThis.fetch` was before the first
// install in this process (normally Node's real fetch).

let originalFetch = undefined;
let installedOnce = false;

function parseBody(raw) {
  if (raw === undefined || raw === null) return { body: undefined, rawBody: raw };
  if (typeof raw !== "string") return { body: raw, rawBody: raw };
  try {
    return { body: JSON.parse(raw), rawBody: raw };
  } catch {
    return { body: raw, rawBody: raw };
  }
}

function makeResponse(result) {
  const status = result?.status ?? 200;
  const body = result?.body ?? {};
  const text = typeof result?.text === "string" ? result.text : JSON.stringify(body);
  const headerEntries = Object.entries(result?.headers || {});
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: result?.statusText ?? "",
    headers: { get: (name) => headerEntries.find(([k]) => k.toLowerCase() === String(name).toLowerCase())?.[1] ?? null },
    json: async () => body,
    text: async () => text,
  };
}

export function installFetchMock(responderOrQueue) {
  if (!installedOnce) {
    originalFetch = globalThis.fetch;
    installedOnce = true;
  }
  const calls = [];
  const queue = Array.isArray(responderOrQueue) ? [...responderOrQueue] : null;
  const responder = typeof responderOrQueue === "function" ? responderOrQueue : null;
  if (!queue && !responder) throw new TypeError("installFetchMock expects a responder function or an array of responses");
  globalThis.fetch = async (url, options = {}) => {
    const { body, rawBody } = parseBody(options.body);
    const call = { url, method: options.method || "GET", body, rawBody, headers: options.headers || {} };
    calls.push(call);
    const result = queue ? queue.shift() : await responder(call);
    if (result?.throwNetworkError) throw new TypeError("Failed to fetch");
    return makeResponse(result);
  };
  return calls;
}

export function restoreFetch() {
  if (!installedOnce) return;
  globalThis.fetch = originalFetch;
}
