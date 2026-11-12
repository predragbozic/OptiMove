// Phase 9-B (contract J17, docs/ai/phase9-importer-mappings-contract.md):
// static architecture guards of the GPEXE importer that writes only through
// mapping activations. Unit kind - no database, no server, no network, and no
// module of backend/src imported: every rule reads the checked-out sources of
// backend/src as text (the style of source-metric-mapping-m2.test.mjs test 20
// and gpexe-rest-v1-adapter-reads.test.mjs B7.8).
//
// Every source is masked before it is searched (maskSource): comments are
// blanked in both forms; in the "code" form the text of strings, templates and
// regular expression literals is blanked too, while a template's ${...}
// expressions stay code. Both forms keep every position and line break, so an
// index found in one form is the same place in the other and in the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// The importer's own modules (J17 sections 3-8) and its router.
const IMPORTER = ["gpexeImportWriter.js", "gpexeImportMapper.js", "gpexeImportMapping.js", "gpexeImportPreview.js", "gpexeImportService.js"];
const ROUTE = "routes/gpexeImport.js";

// ---------------------------------------------------------------------------
// Reading and masking the sources
// ---------------------------------------------------------------------------
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "await", "yield"]);
const REGEX_AFTER_CHAR = "(,=:[!&|?{};+-*%<>~^";

function maskSource(src) {
  const code = src.split("");
  const text = src.split("");
  const blank = (arr, i) => { if (i < arr.length && arr[i] !== "\n" && arr[i] !== "\r") arr[i] = " "; };
  const stack = [{ kind: "code", depth: 0, expr: false }];
  const n = src.length;
  let lastChar = "";
  let lastWord = "";
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];
    if (top.kind === "tpl") {
      if (c === "\\") { blank(code, i); blank(code, i + 1); i += 2; continue; }
      if (c === "`") { blank(code, i); stack.pop(); lastChar = ")"; lastWord = ""; i += 1; continue; }
      if (c === "$" && src[i + 1] === "{") {
        // "$" blanked, "{" kept: the expression's braces stay a balanced pair.
        blank(code, i);
        stack.push({ kind: "code", depth: 0, expr: true });
        lastChar = "{";
        lastWord = "";
        i += 2;
        continue;
      }
      blank(code, i);
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") { blank(code, i); blank(text, i); i += 1; }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close < 0 ? n : close + 2;
      for (; i < stop; i += 1) { blank(code, i); blank(text, i); }
      continue;
    }
    if (c === "'" || c === "\"") {
      blank(code, i);
      i += 1;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") { blank(code, i); i += 1; }
        blank(code, i);
        i += 1;
      }
      blank(code, i);
      i += 1;
      lastChar = ")";
      lastWord = "";
      continue;
    }
    if (c === "`") { blank(code, i); stack.push({ kind: "tpl" }); i += 1; continue; }
    if (c === "/" && (lastChar === "" || REGEX_AFTER_CHAR.includes(lastChar) || REGEX_AFTER_WORD.has(lastWord))) {
      blank(code, i);
      i += 1;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        const d = src[i];
        if (d === "\\") { blank(code, i); blank(code, i + 1); i += 2; continue; }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        blank(code, i);
        i += 1;
      }
      blank(code, i);
      i += 1;
      lastChar = ")";
      lastWord = "";
      continue;
    }
    if (c === "{") top.depth += 1;
    if (c === "}") {
      if (top.expr && top.depth === 0) { stack.pop(); lastChar = ")"; lastWord = ""; i += 1; continue; }
      top.depth -= 1;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
      lastWord = src.slice(i, j);
      lastChar = "a";
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      lastChar = c;
      lastWord = "";
    }
    i += 1;
  }
  if (stack.length !== 1) throw new Error("maskSource: an unterminated template or ${...} expression");
  return { code: code.join(""), text: text.join("") };
}

let cache = null;
function sources() {
  if (cache) return cache;
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".js") || e.name.endsWith(".mjs")) files.push(join(dir, e.name));
    }
  };
  walk(SRC);
  cache = new Map();
  for (const abs of files.sort()) {
    const rel = relative(SRC, abs).replace(/\\/g, "/");
    const raw = readFileSync(abs, "utf8");
    cache.set(rel, { rel, raw, ...maskSource(raw) });
  }
  return cache;
}
const all = () => [...sources().values()];
function source(rel) {
  const f = sources().get(rel);
  assert.ok(f, `${rel} exists in backend/src`);
  return f;
}
const lineOf = (f, index) => f.raw.slice(0, index).split("\n").length;
const where = (f, index) => `${f.rel}:${lineOf(f, index)}`;
const count = (s, re) => (s.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)) || []).length;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The bracket that closes the one at openIndex, in a masked "code" form.
function matchClose(code, openIndex) {
  const open = code[openIndex];
  const close = { "(": ")", "{": "}", "[": "]" }[open];
  let depth = 0;
  for (let i = openIndex; i < code.length; i += 1) {
    if (code[i] === open) depth += 1;
    else if (code[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Every function with a braced body - declarations and expressions, methods,
// arrow functions with a block - found by a brace-balanced scan of the code
// form: { name, bodyStart, end } ("<arrow>" / "<anonymous>" when unnamed).
const NOT_A_METHOD = new Set(["if", "for", "while", "switch", "catch", "with", "function", "return", "typeof", "await", "new", "else", "do", "super"]);
const fnCache = new WeakMap();
function functionsOf(f) {
  if (fnCache.has(f)) return fnCache.get(f);
  const { code } = f;
  const out = [];
  const add = (name, parenOpen) => {
    const parenClose = matchClose(code, parenOpen);
    if (parenClose < 0) return;
    let k = parenClose + 1;
    while (k < code.length && /\s/.test(code[k])) k += 1;
    if (code[k] !== "{") return;
    const end = matchClose(code, k);
    if (end > 0) out.push({ name, bodyStart: k, end });
  };
  for (const m of code.matchAll(/\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g)) add(m[1] ?? "<anonymous>", m.index + m[0].length - 1);
  for (const m of code.matchAll(/(?:^|[;{}])[ \t]*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
    if (!NOT_A_METHOD.has(m[1])) add(m[1], m.index + m[0].length - 1);
  }
  for (const m of code.matchAll(/=>\s*\{/g)) {
    const k = m.index + m[0].length - 1;
    const end = matchClose(code, k);
    const named = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^;]*\)|[A-Za-z_$][\w$]*)\s*$/.exec(code.slice(Math.max(0, m.index - 400), m.index));
    if (end > 0) out.push({ name: named?.[1] ?? "<arrow>", bodyStart: k, end });
  }
  fnCache.set(f, out);
  return out;
}
// The innermost function whose body holds index (any, or a named one).
function enclosing(f, index, { named = false } = {}) {
  let best = null;
  for (const fn of functionsOf(f)) {
    if (fn.bodyStart > index || fn.end < index) continue;
    if (named && fn.name.startsWith("<")) continue;
    if (!best || fn.end - fn.bodyStart < best.end - best.bodyStart) best = fn;
  }
  return best;
}
const bodyOf = (f, fn, form = "code") => f[form].slice(fn.bodyStart, fn.end + 1);
// Every call of `callee` (a name, or "object.name"; a name also matches as a
// method, x.name(...)) in the code form, with its argument text. A function's
// own definition is not a call.
function callsOf(f, callee) {
  const out = [];
  for (const m of f.code.matchAll(new RegExp(`(?<![\\w$])${escapeRe(callee)}\\s*\\(`, "g"))) {
    if (/\bfunction\s*\*?\s*$/.test(f.code.slice(Math.max(0, m.index - 40), m.index))) continue;
    const open = m.index + m[0].length - 1;
    const close = matchClose(f.code, open);
    out.push({ index: m.index, args: close < 0 ? "" : f.code.slice(open + 1, close) });
  }
  return out;
}
// The top-level arguments of an argument text (split at depth-0 commas).
function topLevelArgs(args) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const c = args[i];
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else if (c === "," && depth === 0) { out.push(args.slice(start, i).trim()); start = i + 1; }
  }
  if (args.slice(start).trim()) out.push(args.slice(start).trim());
  return out;
}

test("0. the scan reads every backend source; the masking keeps every position, balances every bracket, blanks comments in both forms and string, template and regex text in the code form; functions are found with their names", () => {
  const files = all();
  assert.ok(files.length > 40, "the scan found the backend sources");
  for (const rel of [...IMPORTER, ROUTE]) source(rel);
  for (const f of files) {
    assert.equal(f.code.length, f.raw.length, `${f.rel}: the code form keeps every position`);
    assert.equal(f.text.length, f.raw.length, `${f.rel}: the text form keeps every position`);
    assert.equal(count(f.code, /\n/), count(f.raw, /\n/), `${f.rel}: every line break kept`);
    // A string, template or regex read wrongly would leave a bracket of its
    // text in the code form, or blank one of the code.
    for (const [open, close] of [["(", ")"], ["{", "}"], ["[", "]"]]) {
      assert.equal(count(f.code, new RegExp(escapeRe(open))), count(f.code, new RegExp(escapeRe(close))), `${f.rel}: ${open}${close} balanced in the code form`);
    }
  }
  const sample = maskSource("const a = 'x(' + `t ${b({ c: 1 })} u` + \"w[\"; // y(\nconst r = /[)]/.test(s) / 2; /* z{ */ q(1);");
  assert.doesNotMatch(sample.code, /x\(|w\[|y\(|z\{|\[\)\]/, "string, comment and regex text is blanked in the code form");
  assert.match(sample.code, /\{b\(\{ c: 1 \}\)\}/, "a template's expression stays code, its braces balanced");
  assert.match(sample.code, /\.test\(s\) \/ 2;/, "a division after a call is code");
  assert.match(sample.text, /'x\('/, "the text form keeps strings");
  assert.doesNotMatch(sample.text, /y\(|z\{/, "the text form drops comments");
  const fns = functionsOf({ code: maskSource("export async function a(x) { const b = async (y) => { return y; }; return { c(z) { if (z) { return 1; } return 2; } }; }").code });
  assert.deepEqual(fns.map((fn) => fn.name).sort(), ["a", "b", "c"]);
});

test("1. C46: no importer module (the writer, the mapper, the mapping context, the preview, the service) inserts, updates, deletes, truncates or merges a Metrics Core definition, definition version or scope capability, and none imports a module that does", () => {
  const TABLES = "metric_definitions|metric_definition_versions|metric_definition_scope_capabilities";
  const WRITE = new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from|truncate(?:\\s+table)?|merge\\s+into)\\s+(?:only\\s+)?training_load\\.(?:${TABLES})\\b`, "gi");
  assert.equal(count("insert into training_load.metric_definitions (id) / update training_load.metric_definition_versions set / delete from training_load.metric_definition_scope_capabilities", WRITE), 3, "the pattern sees each write");
  assert.equal(count("insert into training_load.source_metric_definitions / select from training_load.metric_definitions for share", WRITE), 0, "and nothing else");
  for (const rel of IMPORTER) {
    const f = source(rel);
    assert.deepEqual([...f.text.matchAll(WRITE)].map((m) => `${where(f, m.index)}: ${m[0]}`), [], `${rel} writes Metrics Core (C46)`);
  }
  // The modules that do write them (the catalog, the canonical-variable
  // administration) are never imported by the importer.
  const writers = all().filter((f) => count(f.text, WRITE) > 0).map((f) => f.rel);
  assert.ok(writers.length > 0, "the scan sees the Metrics Core writers");
  for (const rel of IMPORTER) {
    const f = source(rel);
    const imported = [...f.text.matchAll(/\bfrom\s+["']\.\/([\w./-]+)["']/g)].map((m) => m[1]);
    assert.ok(imported.length > 0 || rel === "gpexeImportMapping.js", `${rel}: its imports are read`);
    assert.deepEqual(imported.filter((name) => writers.includes(name)), [], `${rel} imports a Metrics Core writer`);
  }
});

test("2. T6 (J17 section 3, step 10): every function that inserts training_load.metric_values for an import also inserts their training_load.metric_value_source_provenance rows, after the values, in the same function - directly or through the statement builders it calls; the manual-entry module is the only other writer of values and its import-side helpers are called by no other module", () => {
  const VALUES = /\binsert\s+into\s+training_load\.metric_values\b/gi;
  const PROVENANCE = /\binsert\s+into\s+training_load\.metric_value_source_provenance\b/gi;
  const MANUAL = "trainingLoadMetricsMeasurements.js";
  // 6b-B: the estimate save writes estimated values; they come from no source, so T6 does not apply - each has its own
  // provenance row in metric_value_estimates (v63), checked below.
  const ESTIMATE = "metricEstimateService.js";
  const files = all();
  assert.deepEqual(files.filter((f) => count(f.text, VALUES) > 0).map((f) => f.rel).sort(), ["gpexeImportWriter.js", ESTIMATE, MANUAL],
    "the import writer, the estimate save and the manual-entry module are the only modules that insert metric_values");
  {
    const est = files.find((f) => f.rel === ESTIMATE);
    const ESTIMATES = /\binsert\s+into\s+training_load\.metric_value_estimates\b/gi;
    for (const m of est.text.matchAll(VALUES)) {
      const fn = enclosing(est, m.index);
      assert.ok(fn && count(est.text.slice(m.index, fn.end + 1), ESTIMATES) > 0, `${where(est, m.index)}: an estimated value without its metric_value_estimates row in the same function`);
    }
    assert.equal(count(est.text, PROVENANCE), 0, "an estimate writes no T6 row");
  }
  // A statement builder holds the SQL text and sends nothing itself; its
  // callers send it.
  const sendsQuery = (f, fn) => /\.query\s*\(/.test(bodyOf(f, fn));
  const provenanceBuilders = new Set();
  let provenanceSites = 0;
  for (const f of files) {
    for (const m of f.text.matchAll(PROVENANCE)) {
      const fn = enclosing(f, m.index);
      assert.ok(fn, `${where(f, m.index)}: a T6 insert outside any function`);
      provenanceSites += 1;
      if (!sendsQuery(f, fn)) {
        assert.ok(!fn.name.startsWith("<"), `${where(f, m.index)}: an unnamed T6 statement builder`);
        provenanceBuilders.add(fn.name);
      }
    }
  }
  assert.ok(provenanceSites > 0, "the T6 insert is found");
  const provenanceAfter = (f, fn, from) => count(f.text.slice(from, fn.end + 1), PROVENANCE) > 0
    || [...provenanceBuilders].some((name) => new RegExp(`(?<![\\w$])${escapeRe(name)}\\s*\\(`).test(f.code.slice(from, fn.end + 1)));
  const failures = [];
  const checked = [];
  for (const f of files) {
    if (f.rel === MANUAL || f.rel === ESTIMATE) continue;
    for (const m of f.text.matchAll(VALUES)) {
      const fn = enclosing(f, m.index);
      if (!fn) { failures.push(`${where(f, m.index)}: a metric_values insert outside any function`); continue; }
      if (sendsQuery(f, fn)) {
        checked.push(`${f.rel} ${fn.name}`);
        if (!provenanceAfter(f, fn, m.index)) failures.push(`${f.rel} ${fn.name} (${where(f, m.index)}): inserts metric_values without their provenance rows`);
        continue;
      }
      if (fn.name.startsWith("<")) { failures.push(`${where(f, m.index)}: an unnamed metric_values statement builder`); continue; }
      let calls = 0;
      for (const g of files) {
        for (const call of callsOf(g, fn.name)) {
          calls += 1;
          const caller = enclosing(g, call.index);
          if (!caller) { failures.push(`${where(g, call.index)}: ${fn.name}() called outside any function`); continue; }
          checked.push(`${g.rel} ${caller.name}`);
          if (!provenanceAfter(g, caller, call.index)) failures.push(`${g.rel} ${caller.name} (${where(g, call.index)}): inserts metric_values through ${fn.name}() without their provenance rows`);
        }
      }
      if (calls === 0) failures.push(`${f.rel} ${fn.name}: a metric_values statement builder that nothing calls`);
    }
  }
  assert.deepEqual(failures, [], "every value insert is followed by its T6 rows in the same function");
  assert.ok(checked.includes("gpexeImportWriter.js insertOccasionWithValues"), `the writer's value insert was found and checked (${checked.join(", ")})`);
  // The manual-entry module writes manual values: no source, no activation,
  // so T6 does not apply. Its two api_import helpers write source values
  // without T6 and are wired to nothing; no other module may call them.
  for (const name of ["correctSourceIdentityOccasion", "importResendSynthetic"]) {
    assert.deepEqual(files.filter((g) => g.rel !== MANUAL && callsOf(g, name).length > 0).map((g) => g.rel), [], `${name} is called outside ${MANUAL}`);
  }
});

test("3. the importer's specs come only from the extractor registry: the mapping context reads no value, the mapper's one extract is a registry entry's (extractorFor), every plan is built from [] , mappedMetricSpecs() or the 7e raw spec of a registry entry, and no module of backend/src keeps a GPEXE metric list of its own (GPEXE_METRIC_SPECS, detailsNumber outside the registry, powerZoneSpec, the test-only legacy specs)", () => {
  const files = all();
  const mapper = source("gpexeImportMapper.js");
  const mapping = source("gpexeImportMapping.js");
  // The mapping context locks and compares rows; it never reads a value.
  assert.doesNotMatch(mapping.code, /\b(?:extract|extractorFor|EXTRACTORS)\b/, "the mapping context names no extractor");
  assert.doesNotMatch(mapping.text, /\bfrom\s+["'][^"']*sourceMetricExtractors/, "the mapping context does not import the registry");
  // The writer, the preview and the service read no value either: the mapper does.
  for (const rel of ["gpexeImportWriter.js", "gpexeImportPreview.js", "gpexeImportService.js"]) {
    assert.doesNotMatch(source(rel).code, /\.extract\s*\(|\bextractorFor\b|\bEXTRACTORS\b|\bextract\s*:/, `${rel} reads a value itself`);
  }
  // The mapper: exactly one extract property, the registry entry's own, built in mappedMetricSpecs.
  const props = [...mapper.code.matchAll(/\bextract\s*:/g)];
  assert.equal(props.length, 1, "the mapper defines one extract");
  assert.match(mapper.code.slice(props[0].index, props[0].index + 120), /^extract\s*:\s*\(input\)\s*=>\s*extractor\.extract\(input,\s*sourceParameters\)/);
  assert.equal(enclosing(mapper, props[0].index, { named: true })?.name, "mappedMetricSpecs");
  const decls = [...mapper.code.matchAll(/\b(?:const|let|var)\s+extractor\s*=\s*/g)];
  assert.ok(decls.length >= 1, "the mapper holds a registry entry");
  for (const d of decls) assert.match(mapper.code.slice(d.index + d[0].length), /^extractorFor\s*\(/, `${where(mapper, d.index)}: an extractor that is not extractorFor's answer`);
  assert.equal(count(mapper.code, /(?<![\w$.])extractor\s*=(?!=)/), decls.length, "an extractor is never reassigned");
  for (const m of mapper.code.matchAll(/\.extract\s*\(/g)) {
    const before = mapper.code.slice(mapper.code.lastIndexOf("\n", m.index) + 1, m.index);
    assert.match(before, /(?:(?<![\w$.])extractor|(?<![\w$.])spec|extractorFor\s*\(\{[^{}]*\}\))$/, `${where(mapper, m.index)}: an extract that is neither a registry entry's nor a spec's`);
  }
  // Every plan: the gates ([]), the specs of mappedMetricSpecs(), or the 7e raw spec.
  const fromMapped = (body, expr) => {
    let m = /^([A-Za-z_$][\w$]*)\.specs$/.exec(expr);
    if (m) return new RegExp(`\\b(?:const|let)\\s+${escapeRe(m[1])}\\s*=\\s*mappedMetricSpecs\\s*\\(`).test(body);
    m = /^([A-Za-z_$][\w$]*)$/.exec(expr);
    if (!m) return false;
    const assigned = [...body.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(m[1])}\\s*=\\s*([^;]+);`, "g"))].map((a) => a[1].trim()).filter((rhs) => rhs !== "[]");
    return assigned.length > 0 && assigned.every((rhs) => /^[A-Za-z_$][\w$]*\.specs$/.test(rhs) && fromMapped(body, rhs));
  };
  const plans = [];
  for (const g of files) {
    for (const call of callsOf(g, "buildGpexeImportPlan")) {
      const caller = enclosing(g, call.index, { named: true });
      // v62: `teamTimezone` (the team's session time zone, a shorthand property) is the one other key a plan may take; it
      // chooses only the event's zone of a mixed session and never a value, so the specs are read without it.
      const spec = /\{\s*metricSpecs\s*:\s*([\s\S]*?)(?:\s*,\s*teamTimezone)?\s*\}\s*$/.exec(call.args)?.[1] ?? null;
      const ok = spec === "[]"
        || (g.rel === "gpexeImportMapper.js" && caller?.name === "gpexeLevelValues" && /^\[\{\s*raw\s*:\s*true\s*,[\s\S]*\bextract\s*\}\]$/.test(spec ?? ""))
        || (caller !== null && spec !== null && fromMapped(bodyOf(g, caller), spec));
      plans.push(`${g.rel} ${caller?.name}: ${spec}`);
      assert.ok(ok, `${where(g, call.index)}: a plan built from specs that are not the mapping's (${spec})`);
    }
  }
  assert.ok(plans.some((p) => p.startsWith("gpexeImportWriter.js") && !p.endsWith(": []")), `the writer builds its plan from mappedMetricSpecs (${plans.join("; ")})`);
  assert.ok(plans.some((p) => p.startsWith("gpexeImportPreview.js") && !p.endsWith(": []")), "the preview builds its plan from mappedMetricSpecs");
  // The 7e raw spec's extract is gpexeLevelValues' parameter, and every caller
  // passes a registry entry's extract.
  // v62: the one other parameter is the options object carrying the team's session time zone (no spec, no value).
  // J18 (18-2): `keyed` only adds each athlete's internal key to the answer; gpexeLevelValuesKeyed is the same read with
  // it set (one call of gpexeLevelValues passing its own parameters through), and its callers are held to the same rule.
  assert.match(mapper.code, /export function gpexeLevelValues\(bundle,\s*extract,\s*\{\s*teamTimezone\s*=\s*null\s*\}\s*=\s*\{\},\s*keyed\s*=\s*false\)/);
  assert.match(mapper.code, /export function gpexeLevelValuesKeyed\(bundle,\s*extract,\s*\{\s*teamTimezone\s*=\s*null\s*\}\s*=\s*\{\}\)\s*\{\s*return gpexeLevelValues\(bundle,\s*extract,\s*\{\s*teamTimezone\s*\},\s*true\);\s*\}/);
  const keyedCalls = files.flatMap((g) => callsOf(g, "gpexeLevelValuesKeyed").map((call) => ({ g, call })));
  assert.deepEqual([...new Set(keyedCalls.map(({ g }) => g.rel))], ["sourceMetricBoardService.js"], "only the board reads the keyed values");
  const levelCalls = [...keyedCalls, ...files.flatMap((g) => callsOf(g, "gpexeLevelValues").map((call) => ({ g, call })))
    .filter(({ g, call }) => !(g.rel === "gpexeImportMapper.js" && enclosing(g, call.index, { named: true })?.name === "gpexeLevelValuesKeyed"))];
  assert.ok(levelCalls.length >= 1, "gpexeLevelValues has a caller");
  for (const { g, call } of levelCalls) {
    const entry = /^\s*[\w$.]+\s*,\s*\(\s*input\s*\)\s*=>\s*([A-Za-z_$][\w$]*)\.extract\s*\(/.exec(call.args)?.[1];
    const caller = enclosing(g, call.index, { named: true });
    assert.ok(entry && caller && new RegExp(`\\b(?:const|let)\\s+${escapeRe(entry)}\\s*=\\s*extractorFor\\s*\\(`).test(bodyOf(g, caller)),
      `${where(g, call.index)}: gpexeLevelValues is given an extract that is not a registry entry's`);
  }
  // No metric list of its own anywhere in backend/src.
  const BANNED = /\b(?:GPEXE_METRIC_SPECS|GPEXE_DERIVED_NOT_IMPORTED|powerZoneSpec|LEGACY_SPECS|SPEC_REGISTRY|legacyRowValues)\b/g;
  assert.deepEqual(files.flatMap((f) => [...f.code.matchAll(BANNED)].map((m) => `${where(f, m.index)}: ${m[0]}`)), [], "a GPEXE metric list outside the registry");
  assert.deepEqual(files.filter((f) => f.rel !== "sourceMetricExtractors.js" && /\bdetailsNumber\b/.test(f.code)).map((f) => f.rel), [], "detailsNumber outside the registry");
  assert.deepEqual(files.filter((f) => f.rel !== "sourceMetricExtractors.js" && /\bEXTRACTORS\b/.test(f.code)).map((f) => f.rel), [], "the registry table read around extractorFor");
  assert.deepEqual(files.filter((f) => /\bextract\s*:/.test(f.code)).map((f) => f.rel), ["gpexeImportMapper.js"], "an extract property (a spec) defined outside the mapper");
  assert.deepEqual(files.filter((f) => callsOf(f, "setExtractorFallbackForTests").length > 0).map((f) => f.rel), [], "the registry's test fallback is set by a source module");
  // J18 (18-2): the board's two test seams are never set by a source module either, and the internal athlete key is
  // asked for only through gpexeLevelValuesKeyed (no other call of gpexeLevelValues passes a fourth argument).
  for (const seam of ["setDisplayRuleFallbackForTests", "setBoardRemovalFaultForTests"]) {
    assert.deepEqual(files.filter((f) => callsOf(f, seam).length > 0).map((f) => f.rel), [], `${seam} is set by a source module`);
  }
  for (const { g, call } of levelCalls.filter((c) => !keyedCalls.includes(c))) {
    assert.doesNotMatch(call.args, /\}\s*,\s*[^,]+$/, `${where(g, call.index)}: gpexeLevelValues is asked for the internal key outside gpexeLevelValuesKeyed`);
  }
  assert.deepEqual(files.filter((f) => /\bfrom\s+["'][^"']*(?:\/tests\/|gpexe-legacy-specs|test-extractors)/.test(f.text)).map((f) => f.rel), [], "a source module imports test support");
});

test("4. the 9-B test seams (setImportMappingHoldForTests, setSourceInstanceHoldForTests) are defined in gpexeImportMapping.js and named by no other module of backend/src, and the hooks they set are assigned only by them", () => {
  const mapping = source("gpexeImportMapping.js");
  for (const seam of ["setImportMappingHoldForTests", "setSourceInstanceHoldForTests"]) {
    const re = new RegExp(`\\b${seam}\\b`);
    assert.deepEqual(all().filter((f) => re.test(f.code)).map((f) => f.rel), ["gpexeImportMapping.js"], `${seam} is named outside the module that defines it`);
    assert.equal(count(mapping.code, re), 1, `${seam}: its definition only, never called by its own module`);
    assert.match(mapping.code, new RegExp(`export function ${seam}\\(fn\\)`));
  }
  for (const hook of ["mappingHold", "sourceInstanceHold"]) {
    assert.equal(count(mapping.code, new RegExp(`(?<![\\w$.])${hook}\\s*=(?!=)`)), 2, `${hook}: its declaration and its seam are its only assignments`);
    assert.equal(all().filter((f) => f.rel !== "gpexeImportMapping.js" && new RegExp(`\\b${hook}\\b`).test(f.code)).length, 0, `${hook} is named outside its module`);
  }
});

test("5. the importer's log sinks never print an error's text: no console call in the service, the writer, the mapper, the mapping context, the preview, the router or any other backend/src module that calls an importer entry point (the retention CLI included) passes .message, .stack, .detail, .hint, .where, .cause or .internalQuery, calls toString(), or passes an error object itself, String(error) or JSON.stringify(error)", () => {
  const ERRORISH = "(?:e|err|error|[a-z][\\w$]*Error)";
  const offenders = [];
  let calls = 0;
  // Every module that calls an importer entry point logs its errors too: the
  // sinks are found from the calls, never from a hand-kept list.
  const ENTRY_POINTS = ["runRetention", "runCheck", "startCheck", "approveCandidate", "approveCandidates", "importGpexeBundle", "importGpexePlanLocked"];
  const callers = all().filter((f) => ENTRY_POINTS.some((name) => callsOf(f, name).length > 0)).map((f) => f.rel);
  assert.ok(callers.includes("gpexeRetentionCli.js"), `the retention CLI is found as a caller: ${callers.join(", ")}`);
  for (const rel of [...new Set([...IMPORTER, ROUTE, ...callers])]) {
    const f = source(rel);
    for (const m of f.code.matchAll(/\bconsole\s*\.\s*(?:error|warn|log|info|debug|trace)\s*\(/g)) {
      calls += 1;
      const open = m.index + m[0].length - 1;
      const args = f.code.slice(open + 1, matchClose(f.code, open));
      const snippet = f.raw.slice(m.index, matchClose(f.code, open) + 1).replace(/\s+/g, " ").slice(0, 160);
      if (/(?:\?\.|\.)\s*(?:message|stack|detail|hint|where|cause|internalQuery)\b/.test(args) || /\.\s*toString\s*\(/.test(args)) offenders.push(`${where(f, m.index)} (.message / .stack / .detail / .hint / .where / .cause / toString): ${snippet}`);
      else if (new RegExp(`\\{\\s*${ERRORISH}\\s*\\}`).test(args)) offenders.push(`${where(f, m.index)} (an error interpolated): ${snippet}`);
      else if (new RegExp(`\\b(?:String|JSON\\.stringify)\\s*\\(\\s*${ERRORISH}\\b`).test(args)) offenders.push(`${where(f, m.index)} (an error converted to text): ${snippet}`);
      else if (topLevelArgs(args).some((a) => new RegExp(`^${ERRORISH}$`).test(a))) offenders.push(`${where(f, m.index)} (an error object passed): ${snippet}`);
    }
  }
  assert.ok(calls > 10, "the importer's console calls are found");
  assert.deepEqual(offenders, [], "a log line carries an error's message or stack (formatDbError(error) or a code only)");
});

test("6. the six surfaces take the request's one audience level: the router computes it once (importAudienceOf) and passes audience: req.gpexeImportAudience to every listCandidates, getCandidate and approveCandidates call; candidateSummary is the only place a summary (with its blocked codes and preview hash) is built, projectPreview the only preview a candidate read returns, and the batch answers the neutral blockedCode only", () => {
  const route = source(ROUTE);
  const service = source("gpexeImportService.js");
  // One level per request, from the route's own access snapshot.
  const assignments = [...route.code.matchAll(/(?<![\w$])req\.gpexeImportAudience\s*=(?!=)/g)];
  assert.equal(assignments.length, 1, "the level is assigned once");
  assert.match(route.code.slice(assignments[0].index), /^req\.gpexeImportAudience\s*=\s*importAudienceOf\(req\.authz,\s*access\);/);
  assert.equal(enclosing(route, assignments[0].index, { named: true })?.name, "teamAccess");
  const minimum = { "service.listCandidates": 1, "service.getCandidate": 2 };
  // The batch (surface 4) answers the same neutral result for every level, so
  // it takes no audience (a dead argument would read as a projection it does
  // not do); both approval routes pass the club the route resolved, so R16's
  // moved-team 404 can never be skipped by a call that forgets it.
  for (const callee of ["service.approveCandidate", "service.approveCandidates"]) {
    const calls = callsOf(route, callee);
    assert.equal(calls.length, 1, `${callee}: ${calls.length} call(s) found`);
    assert.doesNotMatch(calls[0].args, /(?<![\w$])audience\s*:/, `${where(route, calls[0].index)}: ${callee} takes no audience`);
    assert.match(calls[0].args, /(?<![\w$])expectedClubId\s*:\s*access\.clubId\b/, `${where(route, calls[0].index)}: ${callee} without the route's club`);
  }
  for (const [callee, least] of Object.entries(minimum)) {
    const calls = callsOf(route, callee);
    assert.ok(calls.length >= least, `${callee}: ${calls.length} call(s) found`);
    for (const call of calls) {
      assert.match(call.args, /(?<![\w$])audience\s*:\s*req\.gpexeImportAudience\b/, `${where(route, call.index)}: ${callee} without the request's audience`);
      if (callee === "service.getCandidate") {
        assert.match(call.args, /\bnamesClubVariables\s*:\s*\(preview\)\s*=>\s*namesClubVariablesFor\(req,\s*preview\)/, `${where(route, call.index)}: getCandidate without R17's predicate`);
      }
    }
  }
  // No other module reads candidates for an answer.
  for (const name of ["listCandidates", "getCandidate", "approveCandidates"]) {
    assert.deepEqual(all().filter((f) => f.rel !== ROUTE && f.rel !== "gpexeImportService.js" && callsOf(f, name).length > 0).map((f) => f.rel), [], `${name} is called outside the router`);
  }
  // The router never projects, reads or builds a blocked code itself.
  assert.doesNotMatch(route.code, /\bprojectPreview\b|\bprojectBlockedCodes\b|\bblockedSourceCode\b|\bcandidateReasons\b/);
  // candidateSummary: called only by listCandidates and getCandidate, with the level.
  const summaryCalls = callsOf(service, "candidateSummary");
  assert.deepEqual(summaryCalls.map((c) => enclosing(service, c.index, { named: true })?.name).sort(), ["getCandidate", "listCandidates"]);
  for (const call of summaryCalls) assert.equal(topLevelArgs(call.args).length, 2, `${where(service, call.index)}: candidateSummary without the level`);
  assert.deepEqual(callsOf(service, "projectBlockedCodes").map((c) => enclosing(service, c.index, { named: true })?.name), ["candidateSummary"]);
  assert.deepEqual(callsOf(service, "projectPreview").map((c) => enclosing(service, c.index, { named: true })?.name), ["getCandidate"]);
  // The precise code reaches a summary only through candidateReasons inside
  // candidateSummary; the service never names blockedSourceCode itself.
  assert.doesNotMatch(service.text, /\bblockedSourceCode\b/, "the service builds a blockedSourceCode outside candidateReasons");
  assert.deepEqual(callsOf(service, "candidateReasons").map((c) => enclosing(service, c.index, { named: true })?.name).sort(), ["batchIneligibility", "batchIneligibility", "candidateSummary"]);
  // D10: the only preview hash a summary returns is candidateSummary's.
  const hashFields = [...service.code.matchAll(/(?<![\w$])previewHash\s*:[^,\n]*\bpreview_hash\b/g)];
  assert.deepEqual(hashFields.map((m) => enclosing(service, m.index, { named: true })?.name), ["candidateSummary"]);
  // getCandidate returns the projected preview.
  const getCandidate = functionsOf(service).find((fn) => fn.name === "getCandidate");
  assert.ok(getCandidate, "getCandidate is found");
  const getBody = bodyOf(service, getCandidate);
  assert.match(getBody, /const preview = stored \? projectPreview\(stored, level,/);
  assert.match(getBody, /return \{ \.\.\.summary, preview,/);
  // The batch (surface 4): a refusal carries only known detail fields, and a
  // blocked candidate only candidateReasons' neutral blockedCode, the same for
  // every level; the approval's own answer carries no preview.
  assert.match(service.code, /const \{ reviewAgain: again, changesToImported, reasons, blockedCode \} = details;/);
  assert.match(service.text, /refusedResult\(candidateId, "blocked", \{ blockedCode: candidateReasons\([^;]*\)\.blockedCode \}\)/);
  const approve = functionsOf(service).find((fn) => fn.name === "approveCandidate");
  assert.ok(approve, "approveCandidate is found");
  const result = /const result = (\{)/.exec(bodyOf(service, approve));
  assert.ok(result, "the approval's answer is found");
  const start = approve.bodyStart + result.index + result[0].length - 1;
  assert.doesNotMatch(service.code.slice(start, matchClose(service.code, start) + 1), /\bpreview\b|\bblocked/, "the approval's answer carries no preview or blocked code");
});

test("7. DB review F2: the approval, the check-time preview and the writer's own entry each open their transaction with READ COMMITTED pinned (steps 4-5 read, lock, read again and compare, which needs a fresh snapshot per statement), and none opens a plain begin", () => {
  const cases = [["gpexeImportService.js", "approveCandidate"], ["gpexeImportPreview.js", "buildCandidatePreview"], ["gpexeImportWriter.js", "importGpexeBundle"]];
  for (const [rel, name] of cases) {
    const f = source(rel);
    const fn = functionsOf(f).find((x) => x.name === name);
    assert.ok(fn, `${rel}: ${name} is found`);
    const body = f.raw.slice(fn.bodyStart, matchClose(f.code, fn.bodyStart) + 1);
    const begins = [...body.matchAll(/\.query\(\s*"(begin[^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(begins, ["begin isolation level read committed"], `${rel}: ${name} opens one READ COMMITTED transaction`);
  }
});
