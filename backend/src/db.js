import pg from "pg";

const { Pool } = pg;

pg.types.setTypeParser(1082, (value) => value);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Create backend/.env from .env.example.");
}

// A checkout from the pool never waits without a bound (owner order
// 2026-10-07). 5 s: far beyond a normal checkout (milliseconds), and small
// enough that every request flow still fits inside its existing HTTP budget
// with the checkout added at its start - the roster write (45 s client bound:
// 5 + 15 s lock + 15 s COMMIT + 5 s check), the identity load (90 s: 5 + 45 s
// network + 5 + 15 + 5) and the source-connection attempt (150 s: 20 s user
// lock + 5 + 90 s network + 15 + 5). pg-pool removes a waiter that timed out
// from its queue and releases a client that arrives for it later, and it ends
// a new connection that could not be opened in time, so nothing stays held.
// PG_POOL_CHECKOUT_TIMEOUT_MS (an integer, 100 to 60000) exists for tests.
export const POOL_CHECKOUT_TIMEOUT_MS = (() => {
  const raw = process.env.PG_POOL_CHECKOUT_TIMEOUT_MS;
  const value = raw === undefined || raw === "" ? 5_000 : Number(raw);
  if (!Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new Error("PG_POOL_CHECKOUT_TIMEOUT_MS must be an integer between 100 and 60000.");
  }
  return value;
})();

// The stable code of a checkout that ran out of time. pg-pool's own errors
// carry no code; they are marked here so the routes can answer try_again or a
// 503 instead of a stack. The message is pg-pool's own fixed sentence (no
// SQL, no value, no credential).
export const POOL_CHECKOUT_TIMEOUT = "pool_checkout_timeout";
const CHECKOUT_TIMEOUT_MESSAGES = new Set([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
]);
function markCheckoutError(error) {
  if (error && !error.code && CHECKOUT_TIMEOUT_MESSAGES.has(error.message)) {
    error.code = POOL_CHECKOUT_TIMEOUT;
  }
  return error;
}
export function isPoolCheckoutTimeout(error) {
  return Boolean(error) && error.code === POOL_CHECKOUT_TIMEOUT;
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("supabase.com")
    ? { rejectUnauthorized: false }
    : undefined,
  connectionTimeoutMillis: POOL_CHECKOUT_TIMEOUT_MS,
});

// Every checkout (pool.connect() in both forms, and pool.query(), which uses
// the callback form) gets the stable code on a timeout. Nothing else changes.
const baseConnect = pool.connect.bind(pool);
let checkoutFault = null;
pool.connect = function connect(callback) {
  if (typeof callback === "function") {
    return baseConnect((error, client, done) => callback(markCheckoutError(error), client, done));
  }
  if (checkoutFault) {
    // Tests only: the next promise-form checkout fails the way pg-pool fails
    // a timed-out one (its own sentence, no code), through the same marking.
    const fault = checkoutFault();
    if (fault) return Promise.reject(markCheckoutError(fault));
  }
  return baseConnect().catch((error) => {
    throw markCheckoutError(error);
  });
};

// Tests only: fn() is asked before every promise-form checkout and returns an
// Error to fail it with, or null to check out normally. pool.query() (the
// callback form, used by the session lookup) is never affected.
export function setPoolCheckoutFaultForTests(fn) {
  checkoutFault = typeof fn === "function" ? fn : null;
}

// An idle pooled client, or one destroyed while a late socket error is still
// on its way, reports that error on the pool. Without a listener the emit
// would be an uncaught exception and take the whole server down (found in the
// F3c2d security review). Only the code is logged, never the message.
pool.on("error", (error) => {
  console.error(`[db] idle client error: ${error?.code ?? ""}`);
});

export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result;
}
