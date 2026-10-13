// GPEXE check timing (P0, owner order 2026-10-13): one aggregated line per
// check, so the owner can tell the source's network time from the database
// work around it (heartbeat, re-validation, preview, staging, finalization,
// retention) before any optimization is chosen.
//
// What it is, and what it never does:
//   * counters and monotonic timers in memory for ONE check, dropped with it;
//   * exactly one log line at the end of the check (succeeded, failed, closed
//     by another check, or a start whose COMMIT was not confirmed), of a
//     closed grammar: fixed words and whole numbers only - never an id, a
//     date, a name, a host, a URL, a credential, a value of an answer or the
//     text of an error; a final guard (checkTimingLineAccepted) replaces any
//     other line with one fixed fallback line;
//   * no request, no database statement, no change of order, frequency or
//     outcome: every method swallows its own failure, and the sink's too, so
//     a fault in the measurement can never fail or change a check.
//
// Request kinds come from a label the adapter passes beside each request
// (never from the URL). The network time of a request runs from sending it
// to its response headers; reading the body is not in it. The legacy path's
// client has no such seam: its requests are "untracked". New TCP or TLS
// connections are not measured (the fetch layer offers no per-check count
// without private transport APIs).
import { performance } from "node:perf_hooks";

export const CHECK_TIMING_VERSION = 1;
export const CHECK_TIMING_PREFIX = "[gpexe] check timing ";
export const CHECK_TIMING_REQUEST_KINDS = Object.freeze([
  "list_sessions", "parent_session", "athlete_list", "athlete_detail", "more", "track",
  "whole_details", "drill", "brief_tags", "thresholds", "other",
]);
export const CHECK_TIMING_OUTCOMES = Object.freeze(["succeeded", "failed", "closed_elsewhere", "start_unconfirmed", "unknown"]);
// The stable codes a check row can carry: the resolver's, the rest_v1
// adapter's, the legacy client's and the service's own (a test keeps this list
// in step with those sources). Any other code is written as `other`.
export const CHECK_TIMING_CODES = Object.freeze([
  // the service
  "internal_error", "check_outcome_unknown",
  // the resolver (sourceImportCredentialResolver.js)
  "binding_ambiguous", "team_not_available", "team_setting_missing", "team_setting_mismatch", "connection_foreign_club",
  "connection_not_usable", "connection_credential_changed", "host_not_allowed", "adapter_not_available", "key_missing",
  "credential_unreadable", "binding_ended", "team_club_changed", "binding_started", "drill_set_incomplete",
  "drill_parameter_effect_not_distinguishable", "check_finalize_busy", "check_finalize_failed",
  "check_finalize_outcome_unknown", "source_team_mismatch", "context_not_issued",
  // the rest_v1 adapter and the adapter registry
  "athlete_row_not_confirmed", "athlete_row_not_listed", "credential_missing", "drills_count_out_of_range",
  "duplicate_param", "invalid_bound_team", "invalid_drill_index", "invalid_id", "invalid_options", "path_not_allowed",
  "session_list_refreshed", "session_not_confirmed", "session_not_listed", "session_refreshed", "source_access_refused",
  "source_answer_unexpected", "source_auth_rejected", "source_capability_unavailable", "source_identity_mismatch",
  "source_list_ambiguous", "source_list_changed", "source_list_incomplete", "source_list_too_large", "source_not_found",
  "source_session_start_unreadable", "source_team_not_visible", "source_unavailable", "team_param_not_allowed",
  "track_not_confirmed",
  // the legacy client (gpexeClient.js)
  "invalid_date", "invalid_path", "list_changed", "list_incomplete", "list_shape_unclear", "not_found", "not_json",
  "redirect_refused", "request_refused", "server_error", "team_filter_ignored", "team_mismatch", "token_missing",
  "unauthorized", "unreachable",
]);
const CODES = new Set(CHECK_TIMING_CODES);
const KINDS = new Set(CHECK_TIMING_REQUEST_KINDS);
const OUTCOMES = new Set(CHECK_TIMING_OUTCOMES);
const MAX_INT = 999_999_999;

const INT = "(?:0|[1-9][0-9]{0,8})";
const alt = (words) => words.join("|");
const KIND_LIST = `(?:${CHECK_TIMING_REQUEST_KINDS.map((k) => `${k}:${INT}`).join(",")}|untracked)`;
const LINE_GRAMMAR = new RegExp(
  `^\\[gpexe\\] check timing v=${CHECK_TIMING_VERSION}; outcome=(?:${alt(CHECK_TIMING_OUTCOMES)}); code=(?:none|other|${alt(CHECK_TIMING_CODES)}); `
  + `total_ms=${INT}; sessions_found=${INT}; sessions_done=${INT}; athletes=${INT}; tracks=${INT}; drills=${INT}; `
  + `requests=${KIND_LIST}; net_ms=${KIND_LIST}; heartbeats=${INT}; heartbeat_ms=${INT}; revalidations=${INT}; revalidation_ms=${INT}; `
  + `retention_ms=${INT}; previews=${INT}; preview_ms=${INT}; staging_ms=${INT}; finalize_ms=${INT}$`,
);
// The one line written when the full line would not pass the guard.
export const CHECK_TIMING_FALLBACK_LINE = `${CHECK_TIMING_PREFIX}v=${CHECK_TIMING_VERSION}; outcome=unknown; code=other`;

// The final guard, on its own so a test can show it refuses anything else.
export function checkTimingLineAccepted(line) {
  return typeof line === "string" && line.length <= 1_000 && (LINE_GRAMMAR.test(line) || line === CHECK_TIMING_FALLBACK_LINE);
}

// Test seams: where the line goes, a fault thrown inside every method, and a
// switch that turns the measurement off (a no-op meter, no line).
const DEFAULT_SINK = (line) => console.info(line);
let sink = DEFAULT_SINK;
let fault = null;
let enabled = true;
export function setCheckTimingForTests({ sink: nextSink = null, fault: nextFault = null, enabled: nextEnabled = true } = {}) {
  sink = typeof nextSink === "function" ? nextSink : DEFAULT_SINK;
  fault = typeof nextFault === "function" ? nextFault : null;
  enabled = nextEnabled !== false;
}

const clamp = (v) => (Number.isFinite(v) ? Math.min(MAX_INT, Math.max(0, Math.round(v))) : 0);
const zeroKinds = () => Object.fromEntries(CHECK_TIMING_REQUEST_KINDS.map((k) => [k, 0]));
const kindList = (counts) => CHECK_TIMING_REQUEST_KINDS.map((k) => `${k}:${clamp(counts[k])}`).join(",");

function noop() { return undefined; }
export const NOOP_CHECK_METER = Object.freeze({
  start: noop, request: noop, heartbeat: noop, revalidation: noop, retention: noop, preview: noop, staging: noop,
  finalize: noop, sessionsFound: noop, sessionDone: noop, untracked: noop, outcome: noop, emit: noop,
});

// One meter per check. Every method returns undefined or a number and never
// throws; a timer started with start() is closed by the matching method.
export function createCheckMeter() {
  if (!enabled) return NOOP_CHECK_METER;
  const now = () => performance.now();
  const s = {
    startedAt: now(),
    requests: zeroKinds(), net: zeroKinds(), tracked: true,
    heartbeats: 0, heartbeatMs: 0, revalidations: 0, revalidationMs: 0,
    retentionMs: 0, previews: 0, previewMs: 0, stagingMs: 0, finalizeMs: 0,
    sessionsFound: 0, sessionsDone: 0, athletes: 0, tracks: 0, drills: 0,
    outcome: "unknown", code: "none", emitted: false,
  };
  const guard = (fn) => (...args) => {
    try {
      if (fault) fault();
      return fn(...args);
    } catch {
      return undefined;
    }
  };
  const since = (t0) => (typeof t0 === "number" && Number.isFinite(t0) ? Math.max(0, now() - t0) : 0);
  return Object.freeze({
    start: guard(() => now()),
    // `call` is the label object the adapter passes beside a request; only its
    // `kind` is read, and an unknown one counts as `other`.
    request: guard((call, t0) => {
      const raw = call && typeof call === "object" ? call.kind : null;
      const kind = typeof raw === "string" && KINDS.has(raw) ? raw : "other";
      s.requests[kind] += 1;
      s.net[kind] += since(t0);
    }),
    heartbeat: guard((t0) => { s.heartbeats += 1; s.heartbeatMs += since(t0); }),
    revalidation: guard((t0) => { s.revalidations += 1; s.revalidationMs += since(t0); }),
    retention: guard((t0) => { s.retentionMs += since(t0); }),
    preview: guard((t0) => { s.previews += 1; s.previewMs += since(t0); }),
    staging: guard((t0) => { s.stagingMs += since(t0); }),
    finalize: guard((t0) => { s.finalizeMs += since(t0); }),
    sessionsFound: guard((n) => { s.sessionsFound = Number.isInteger(n) && n >= 0 ? n : 0; }),
    // Counts only: distinct athletes of the session's rows, its tracks, the
    // confirmed parent's drill count. Nothing of the bundle is kept.
    sessionDone: guard((bundle) => {
      s.sessionsDone += 1;
      const rows = Array.isArray(bundle?.athleteSessions) ? bundle.athleteSessions : [];
      s.athletes += new Set(rows.map((r) => String(r?.athlete))).size;
      s.tracks += bundle?.tracks && typeof bundle.tracks === "object" ? Object.keys(bundle.tracks).length : 0;
      const drills = bundle?.teamSession?.drills_count;
      s.drills += Number.isInteger(drills) && drills >= 0 ? drills : 0;
    }),
    // The legacy client's requests have no label and no timer.
    untracked: guard(() => { s.tracked = false; }),
    outcome: guard((outcome, code = null) => {
      s.outcome = OUTCOMES.has(outcome) ? outcome : "unknown";
      s.code = s.outcome === "succeeded" || s.outcome === "closed_elsewhere" || code === null || code === undefined
        ? "none" : (typeof code === "string" && CODES.has(code) ? code : "other");
    }),
    // At most once per check, whoever calls it first.
    emit: guard(() => {
      if (s.emitted) return;
      s.emitted = true;
      let line = CHECK_TIMING_FALLBACK_LINE;
      try {
        const built = `${CHECK_TIMING_PREFIX}v=${CHECK_TIMING_VERSION}; outcome=${s.outcome}; code=${s.code}; `
          + `total_ms=${clamp(since(s.startedAt))}; sessions_found=${clamp(s.sessionsFound)}; sessions_done=${clamp(s.sessionsDone)}; `
          + `athletes=${clamp(s.athletes)}; tracks=${clamp(s.tracks)}; drills=${clamp(s.drills)}; `
          + `requests=${s.tracked ? kindList(s.requests) : "untracked"}; net_ms=${s.tracked ? kindList(s.net) : "untracked"}; `
          + `heartbeats=${clamp(s.heartbeats)}; heartbeat_ms=${clamp(s.heartbeatMs)}; `
          + `revalidations=${clamp(s.revalidations)}; revalidation_ms=${clamp(s.revalidationMs)}; `
          + `retention_ms=${clamp(s.retentionMs)}; previews=${clamp(s.previews)}; preview_ms=${clamp(s.previewMs)}; `
          + `staging_ms=${clamp(s.stagingMs)}; finalize_ms=${clamp(s.finalizeMs)}`;
        if (checkTimingLineAccepted(built)) line = built;
      } catch {
        line = CHECK_TIMING_FALLBACK_LINE;
      }
      try {
        sink(line);
      } catch {
        // A failing logger changes nothing of the check.
      }
    }),
  });
}
