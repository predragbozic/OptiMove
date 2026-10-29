// Phase 7a of docs/ai/metrics-core-plan.md: the access helpers of the
// source-metric administration live in one module, backend/src/sourceMetricAccess.js
// (discovery document, section K: "the access helpers of the M2 service move to
// their own module before T5 reuses them"). A text check over backend/src that
// imports no service, so it needs no database:
// - the context resolver, the right check, the owner keys and the shared error
//   are defined in that module only. sourceConnectionService.js keeps its own
//   rightsStillHold(client, ctx, clubId), the right of the source-connection
//   routes (F3c2e), a different contract named here;
// - the M2 service binds resolveMappingAdmin to its bounded read in one line and
//   takes the rest from the module;
// - the module opens no connection and makes every access decision itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const ACCESS = "sourceMetricAccess.js";
const SERVICE = "sourceMetricMappingService.js";

function sources(dir = SRC, prefix = "") {
  const out = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [k, v] of sources(path.join(dir, entry.name), rel)) out.set(k, v);
    else if (entry.name.endsWith(".js")) out.set(rel, fs.readFileSync(path.join(dir, entry.name), "utf8"));
  }
  return out;
}
const files = sources();
const definers = (name) => [...files]
  .filter(([, text]) => new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*=|\\bclass\\s+${name}\\b`).test(text))
  .map(([file]) => file)
  .sort();

test("1. the access helpers and the shared error are defined in sourceMetricAccess.js only", () => {
  for (const name of ["resolveMappingAdminWith", "coachRightsStillHold", "ownerKeyOf", "readableOwnerKeys", "SourceMetricMappingError", "TRY_AGAIN_TEXT", "setRightsHoldForTests"]) {
    assert.deepEqual(definers(name), [ACCESS], name);
  }
});

test("2. rightsStillHold: the shared one, plus the source connections' own (a different contract)", () => {
  assert.deepEqual(definers("rightsStillHold"), ["sourceConnectionService.js", ACCESS]);
  assert.match(files.get(ACCESS), /export async function rightsStillHold\(client, ctx\) \{/);
  assert.match(files.get("sourceConnectionService.js"), /async function rightsStillHold\(client, ctx, clubId\) \{/);
});

test("3. the M2 service binds the context resolver to its bounded read and takes the rest from the module", () => {
  const service = files.get(SERVICE);
  assert.deepEqual(definers("resolveMappingAdmin"), [SERVICE]);
  assert.match(
    service,
    /export function resolveMappingAdmin\(req, known = undefined\) \{\n {2}return resolveMappingAdminWith\(boundedRead, req, known\);\n\}/,
  );
  const imported = service.match(/import \{([^}]*)\} from "\.\/sourceMetricAccess\.js";/);
  assert.ok(imported, "the service imports the module");
  const names = imported[1].split(",").map((n) => n.trim()).filter(Boolean).sort();
  assert.deepEqual(names, [
    "SourceMetricMappingError", "TRY_AGAIN_TEXT", "UUID", "ownerKeyOf", "readableOwnerKeys", "refusal", "resolveMappingAdminWith",
    "rightsStillHold", "setRightsHoldForTests",
  ]);
  assert.match(service, /export \{ SourceMetricMappingError \};/);
  assert.match(service, /export function setMappingRightsHoldForTests\(fn\) \{ setRightsHoldForTests\(fn\); \}/);
  assert.match(service, /try_again: TRY_AGAIN_TEXT,/);
  const kit = service.match(/export const adminWriteKit = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(kit && /\brightsStillHold\b/.test(kit[1]) && /\bownerKeyOf\b/.test(kit[1]), "the kit hands out the shared helpers");
});

test("4. no access decision is made in the M2 service; the module makes them and opens no connection", () => {
  const service = files.get(SERVICE);
  for (const name of ["isPlatformAdministrator", "holdsClubAdminRole", "resolveActiveWorkspace"]) {
    assert.doesNotMatch(service, new RegExp(`\\b${name}\\b`), name);
  }
  const access = files.get(ACCESS);
  assert.doesNotMatch(access, /from "\.\/db\.js"|from "pg"/);
  for (const name of ["isPlatformAdministrator", "holdsClubAdminRole", "resolveActiveWorkspace"]) {
    assert.match(access, new RegExp(`\\b${name}\\(`), name);
  }
});

test("5. the metric admin services take the right check and the owner key from the M2 kit, never from a copy", () => {
  for (const file of ["canonicalVariableAdminService.js", "canonicalClassificationService.js", "sourceFieldVerificationService.js", "sourceRevisionLifecycleService.js"]) {
    const text = files.get(file);
    const kit = text.match(/const \{([\s\S]*?)\} = adminWriteKit;/);
    assert.ok(kit && /\brightsStillHold\b/.test(kit[1]), `${file} takes rightsStillHold from the kit`);
  }
  assert.match(files.get("canonicalClassificationService.js").match(/const \{([\s\S]*?)\} = adminWriteKit;/)[1], /\bownerKeyOf\b/);
});
