// A check's rate limit (owner decision 2026-10-22): the bounds the importer
// gives the adapter's rateLimit option, and the administrator's description of
// a check the source stopped with 429. No database, no network: the resolver
// uses it, and a unit test can read it on its own.
import { CHECK_TIMING_REQUEST_KINDS } from "./gpexeCheckTiming.js";

// The longest Retry-After a check waits for (whole seconds only), and how often
// it reports that it is alive while it waits - both far inside the bound after
// which a check that stopped reporting is closed as abandoned
// (gpexeImportService.js CHECK_STALE_AFTER_MINUTES).
export const IMPORT_RATE_LIMIT_MAX_WAIT_MS = 60_000;
export const IMPORT_RATE_LIMIT_WAIT_TICK_MS = 10_000;

// The administrator's description of a check stopped by the source's rate
// limit (owner order 2026-10-22, D): which kind of request met the 429, how
// many requests this check had sent and after how many seconds, the same two
// facts at the check's first 429, what the Retry-After held (a closed kind and,
// for whole seconds only, the number), whether the one repeat was used, and
// why the check stopped. Integers and closed words only; the final guard drops
// the description (never the refusal) when anything else would come out.
export const RATE_LIMIT_OUTCOMES = Object.freeze(["second_429", "no_retry_after", "retry_after_date", "retry_after_invalid", "retry_after_over_max", "retry_already_used"]);
const RATE_LIMIT_INT = "(?:0|[1-9][0-9]{0,5})";
const RATE_LIMIT_DIAGNOSTIC_GRAMMAR = new RegExp(
  `^op=rate_limit; request_kind=(?:${CHECK_TIMING_REQUEST_KINDS.join("|")}); requests_sent=${RATE_LIMIT_INT}; elapsed_s=${RATE_LIMIT_INT}; `
  + `first_429_request=${RATE_LIMIT_INT}; first_429_elapsed_s=${RATE_LIMIT_INT}; retry_after=(?:absent|seconds|date|invalid); `
  + `retry_after_s=(?:none|over_day|0|[1-9][0-9]{0,4}); retry_used=(?:yes|no); outcome=(?:${RATE_LIMIT_OUTCOMES.join("|")})\\.$`,
);
export function rateLimitDiagnosticAccepted(line) {
  return typeof line === "string" && line.length <= 300 && RATE_LIMIT_DIAGNOSTIC_GRAMMAR.test(line);
}
export function rateLimitDiagnostic(facts) {
  if (!facts || typeof facts !== "object") return null;
  const int = (v) => (Number.isInteger(v) && v >= 0 && v <= 999_999 ? v : null);
  const kind = CHECK_TIMING_REQUEST_KINDS.includes(facts.requestKind) ? facts.requestKind : "other";
  const counts = [int(facts.requestsSent), int(facts.elapsedS), int(facts.first429Request), int(facts.first429ElapsedS)];
  if (counts.includes(null)) return null;
  const retryAfter = ["absent", "seconds", "date", "invalid"].includes(facts.retryAfter) ? facts.retryAfter : null;
  if (retryAfter === null || !RATE_LIMIT_OUTCOMES.includes(facts.outcome) || typeof facts.retryUsed !== "boolean") return null;
  const seconds = retryAfter === "seconds" && Number.isInteger(facts.retryAfterS) && facts.retryAfterS >= 0
    ? (facts.retryAfterS > 86_400 ? "over_day" : String(facts.retryAfterS)) : "none";
  const line = `op=rate_limit; request_kind=${kind}; requests_sent=${counts[0]}; elapsed_s=${counts[1]}; first_429_request=${counts[2]}; `
    + `first_429_elapsed_s=${counts[3]}; retry_after=${retryAfter}; retry_after_s=${seconds}; retry_used=${facts.retryUsed ? "yes" : "no"}; outcome=${facts.outcome}.`;
  return rateLimitDiagnosticAccepted(line) ? line : null;
}
