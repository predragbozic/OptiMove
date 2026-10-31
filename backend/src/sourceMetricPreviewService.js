// The aggregate preview of a mapping version (phase 7e, contract J11,
// docs/ai/phase7e-aggregate-preview-contract.md): before a version is
// activated, a mapping admin checks it against one saved GPEXE candidate -
// how many athletes the version would give a value, the smallest and the
// largest value, in the source unit and through the version's conversion.
// A read: no write, no request key, no audit row.
//
// The audience is 7d's (mayManageActivations): an active platform admin in
// the platform workspace (system mappings, any club's candidate) or in club
// X's workspace, and club X's active admin in its own workspace (system
// mappings and club X's, over club X's candidates). The candidate's club is
// its team's current club (R6). Everyone and everything else is the
// identical 404, decided before snapshot_expired (R1).
//
// The answer carries counts, values and units only (OD2): never a raw
// answer, a row per athlete, an athlete, track or session id, and no min or
// max of fewer than PREVIEW_MINIMUM_ATHLETES athletes (OD3). The values are
// the ones M4 would write: the import's own session and athlete gates
// (gpexeLevelValues, R3), the version's field through the extractor registry
// (7f, J12), D8's conversion at the storage scale.
import { adminWriteKit } from "./sourceMetricMappingService.js";
import { mayManageActivations, readableOwnerKeys } from "./sourceMetricAccess.js";
import { extractabilityCode, extractorFor } from "./sourceMetricExtractors.js";
import { GPEXE_SOURCE_SYSTEM, gpexeLevelValues } from "./gpexeImportMapper.js";
import { PREVIEW_MINIMUM_ATHLETES, previewLevel } from "./sourceMetricPreview.js";

const { boundedRead, refusal, NOT_FOUND, MESSAGES, UUID, PARAMS_AS_TEXT } = adminWriteKit;

export { mayManageActivations };

// R7: the largest stored bundle the preview reads, measured as its
// uncompressed text (octet_length(raw_bundle::text)); a larger one is refused
// in the database, before it leaves it.
export const PREVIEW_MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
// The family the candidates of the binding path are read from (v31).
const SOURCE_CONNECTION_PATH = "source_connection";

const PREVIEW_MESSAGES = {
  snapshot_expired: "The saved GPEXE session of this candidate is no longer available; find the session again.",
  candidate_too_large: "The saved GPEXE session of this candidate is too large to preview.",
  candidate_source_mismatch: "This candidate was read from another source than the mapping version's field.",
  candidate_not_importable: "The import would not take this GPEXE session.",
};

// J11 section 2.2-2.3: the path ids and the one query parameter, read from
// the raw query string (never Express's parsed req.query, which drops a key
// named like an Object.prototype member and nests brackets). Anything else -
// a missing, empty, repeated or bracketed candidateId, any other parameter,
// a malformed id - is the identical 404.
function previewInput(mappingId, versionId, queryString) {
  if (typeof mappingId !== "string" || !UUID.test(mappingId) || typeof versionId !== "string" || !UUID.test(versionId)) throw NOT_FOUND();
  if (typeof queryString !== "string") throw NOT_FOUND();
  const entries = [...new URLSearchParams(queryString)];
  if (entries.length !== 1 || entries[0][0] !== "candidateId" || !UUID.test(entries[0][1])) throw NOT_FOUND();
  return { mId: mappingId.toLowerCase(), vId: versionId.toLowerCase(), cId: entries[0][1].toLowerCase() };
}

export async function previewVersion({ ctx, mappingId, versionId, queryString }) {
  if (!mayManageActivations(ctx)) throw NOT_FOUND();
  const { mId, vId, cId } = previewInput(mappingId, versionId, queryString);
  // One REPEATABLE READ READ ONLY transaction: the version, the candidate's
  // scope, its snapshot state and its bundle are one snapshot. The candidate
  // row is read without a lock.
  const { v, bundle } = await boundedRead(async (client) => {
    // The mapping readable in this workspace, the version of that mapping.
    const version = (await client.query(
      `select v.id, v.source_unit, v.target_unit,
              trim_scale(v.scale)::text as scale, trim_scale(v.scale_divisor)::text as scale_divisor, trim_scale(v."offset")::text as "offset",
              v.parameter_kind, ${PARAMS_AS_TEXT("v.source_parameters")} as source_parameters, v.applies_to_session, v.applies_to_drill,
              d.source_system, d.api_family, d.source_metric_key, r.value_shape
         from training_load.source_metric_mapping_versions v
         join training_load.source_metric_mappings m on m.id = v.mapping_id
         join training_load.source_metric_definitions d on d.id = v.source_metric_definition_id
         join training_load.source_metric_definition_versions r on r.id = v.source_metric_version_id
        where v.id = $1 and v.mapping_id = $2 and m.owner_key = any($3::text[])`,
      [vId, mId, readableOwnerKeys(ctx)],
    )).rows[0];
    if (!version) throw NOT_FOUND();
    // Phase 7f's registry (J12 section 3), decided from the version row alone
    // (pure: no lock, no read): its refusal is answered in the order of J11
    // section 2, but the bundle is read only for a version that may read it.
    const registryCode = extractabilityCode({
      sourceSystem: version.source_system, apiFamily: version.api_family, sourceMetricKey: version.source_metric_key,
      valueShape: version.value_shape, parameterKind: version.parameter_kind, sourceParameters: version.source_parameters,
    });
    const mayRead = version.source_system === GPEXE_SOURCE_SYSTEM && registryCode === null;
    // The candidate inside the scope, in one statement (R1, R6): its team and
    // the team's club active; the platform workspace any club's candidate,
    // club X's workspace club X's only. A missing candidate, a missing,
    // archived or club-less team, an archived club and another club's
    // candidate are all zero rows. Two fences keep the cost where it belongs:
    // the MATERIALIZED CTE applies the scope before anything of the row is
    // measured (so an out-of-scope candidate is never serialized), and
    // OFFSET 0 evaluates the size once. The size is measured only for a
    // stored, unexpired snapshot and decided once (too_large); the bundle
    // leaves the database only when the snapshot is stored, not expired,
    // within the bound, of the version's family and the version may read it.
    const candidate = (await client.query(
      `with scoped as materialized (
         select c.id, c.owner_team_id, c.last_seen_check_id, c.raw_purged_at is not null as purged,
                c.raw_expires_at <= now() as expired, c.raw_bundle
           from training_load.gpexe_import_candidates c
           join public.teams t on t.id = c.owner_team_id and coalesce(t.is_active, true)
           join public.clubs cl on cl.id = t.club_id and coalesce(cl.is_active, true)
          where c.id = $1::uuid
            and (($2::text = 'system' and $3::uuid is null) or ($2::text = 'club' and t.club_id = $3::uuid)))
       select s.id, s.purged, s.expired, b.too_large, k.source_path, h.api_family,
              case when b.too_large is false and k.source_path = $7::text and h.api_family = $6::text and $8::boolean
                   then s.raw_bundle end as raw_bundle
         from scoped s
         cross join lateral (select case when s.purged or s.expired then null else octet_length(s.raw_bundle::text) end as bundle_bytes offset 0) sz
         cross join lateral (select sz.bundle_bytes > $4::int as too_large offset 0) b
         left join training_load.gpexe_import_checks k on k.id = s.last_seen_check_id and k.owner_team_id = s.owner_team_id
         left join training_load.source_host_catalog h on h.source_system = $5::text and h.host_key = k.source_host_key`,
      [cId, ctx.owner.scope, ctx.owner.scope === "club" ? ctx.owner.clubId : null, PREVIEW_MAX_BUNDLE_BYTES, GPEXE_SOURCE_SYSTEM, version.api_family, SOURCE_CONNECTION_PATH, mayRead],
    )).rows[0];
    if (!candidate) throw NOT_FOUND();
    // A caller who got here may see the candidate: its snapshot's state hides
    // nothing (R2: purged, or past raw_expires_at as the application treats it).
    if (candidate.purged) throw refusal(409, "snapshot_expired", PREVIEW_MESSAGES.snapshot_expired, { current: { reason: "purged" } });
    if (candidate.expired) throw refusal(409, "snapshot_expired", PREVIEW_MESSAGES.snapshot_expired, { current: { reason: "expired" } });
    if (candidate.too_large === true) throw refusal(409, "candidate_too_large", PREVIEW_MESSAGES.candidate_too_large);
    // R5: the candidate's family is its last check's path and host.
    if (version.source_system !== GPEXE_SOURCE_SYSTEM || candidate.source_path !== SOURCE_CONNECTION_PATH || candidate.api_family !== version.api_family) {
      throw refusal(409, "candidate_source_mismatch", PREVIEW_MESSAGES.candidate_source_mismatch);
    }
    if (registryCode) throw refusal(409, registryCode, MESSAGES[registryCode]);
    return { v: version, bundle: candidate.raw_bundle };
  });
  // After the transaction: the values.
  // Fail closed: every check above lets the bundle through or refuses.
  if (bundle === null || typeof bundle !== "object") throw new Error("preview bundle missing");
  const entry = extractorFor({ sourceSystem: v.source_system, apiFamily: v.api_family, sourceMetricKey: v.source_metric_key });
  const out = gpexeLevelValues(bundle, (input) => entry.extract(input, v.source_parameters));
  if (out.code) throw refusal(409, "candidate_not_importable", PREVIEW_MESSAGES.candidate_not_importable, { current: { reason: out.code } });
  const factors = { scale: v.scale, divisor: v.scale_divisor, offset: v.offset };
  return {
    preview: {
      candidateId: cId,
      versionId: v.id,
      sourceUnit: v.source_unit,
      targetUnit: v.target_unit,
      minimumAthletes: PREVIEW_MINIMUM_ATHLETES,
      levels: {
        session: v.applies_to_session ? previewLevel(out.athletes.map((athlete) => athlete.session), factors) : null,
        drill: v.applies_to_drill ? previewLevel(out.athletes.map((athlete) => athlete.drill), factors) : null,
      },
    },
  };
}
