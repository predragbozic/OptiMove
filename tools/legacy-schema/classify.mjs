// Classifies one SQL statement of a schema-only dump or of a migration into a
// small descriptor. Pure: text in, object out. Anything it does not recognise is
// { kind: "unknown" } so the caller can drop it loudly instead of guessing.

const Q = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
const QN = `${Q}(?:\\.${Q})?`;

export function unquote(part) {
  const p = part.trim();
  return p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p.toLowerCase();
}

export function parseName(text, defaultSchema = "public") {
  const m = new RegExp(`^(${Q})(?:\\.(${Q}))?`).exec(text.trim());
  if (!m) return null;
  return m[2] ? { schema: unquote(m[1]), name: unquote(m[2]) } : { schema: defaultSchema, name: unquote(m[1]) };
}

const collapse = (stmt) => stmt.replace(/\s+/g, " ").trim();
const rx = (source, flags = "i") => new RegExp(source, flags);

export function describe(statement) {
  const text = collapse(statement);
  const head = text.slice(0, 600);
  let m;
  if (/^set\s/i.test(head) || /^select\s+pg_catalog\.set_config\(/i.test(head) || /^reset\s/i.test(head)) return { kind: "session" };
  if ((m = rx(`^create schema (?:if not exists )?(${Q})`).exec(head))) return { kind: "schema", schema: unquote(m[1]), name: unquote(m[1]) };
  if (/^create extension/i.test(head)) return { kind: "extension" };
  if ((m = rx(`^create (?:or replace )?(function|procedure|aggregate) (${QN})`).exec(head))) return { kind: "function", ...parseName(m[2]) };
  if ((m = rx(`^create (?:type|domain) (${QN})`).exec(head))) return { kind: "type", ...parseName(m[1]) };
  if ((m = rx(`^create (?:unlogged |temporary |temp )?table (?:if not exists )?(${QN})`).exec(head))) return { kind: "table", ...parseName(m[1]) };
  if ((m = rx(`^create sequence (?:if not exists )?(${QN})`).exec(head))) return { kind: "sequence", ...parseName(m[1]) };
  if ((m = rx(`^create (?:or replace )?(?:materialized )?(?:temporary )?(?:recursive )?view (${QN})`).exec(head))) return { kind: "view", ...parseName(m[1]) };
  if ((m = rx(`^create (?:unique )?index (?:concurrently )?(?:if not exists )?(${Q}) on (?:only )?(${QN})`).exec(head))) {
    return { kind: "index", name: unquote(m[1]), schema: parseName(m[2]).schema, table: parseName(m[2]).name };
  }
  if ((m = rx(`^create (?:or replace )?(?:constraint )?trigger (${Q}) .*? on (${QN})`).exec(head))) {
    return { kind: "trigger", name: unquote(m[1]), schema: parseName(m[2]).schema, table: parseName(m[2]).name };
  }
  if ((m = rx(`^create policy (${Q}) on (${QN})`).exec(head))) {
    return { kind: "policy", name: unquote(m[1]), schema: parseName(m[2]).schema, table: parseName(m[2]).name };
  }
  if (/^create (?:publication|event trigger|rule|server|foreign|text search|collation|operator|cast|language|role|user|database)/i.test(head)) return { kind: "other-create" };
  if ((m = rx(`^alter table (?:only )?(?:if exists )?(${QN}) (.*)$`).exec(text))) {
    const t = parseName(m[1]);
    const rest = m[2];
    const out = { kind: "alter-table", schema: t.schema, name: t.name, table: t.name, rest };
    if (/^owner to /i.test(rest)) return { ...out, action: "owner" };
    if (/^(?:enable|disable|force|no force)\s+(?:row level security|trigger|rule)/i.test(rest)) return { ...out, action: "rls" };
    if (/^replica identity/i.test(rest)) return { ...out, action: "replica" };
    if (/^attach partition|^detach partition/i.test(rest)) return { ...out, action: "partition" };
    const adds = [...rest.matchAll(rx(`(?:^|,\\s*)add (?:column )?(?:if not exists )?(${Q}) `, "ig"))].map((x) => unquote(x[1]));
    const addConstraint = rx(`^add constraint (${Q})`).exec(rest);
    if (addConstraint) return { ...out, action: "add-constraint", constraint: unquote(addConstraint[1]) };
    if (/^add column /i.test(rest) || /^add (?!constraint|primary|unique|foreign|check|exclude)/i.test(rest)) {
      const cols = [...rest.matchAll(rx(`(?:^|,\\s*)add column (?:if not exists )?(${Q})`, "ig"))].map((x) => unquote(x[1]));
      return { ...out, action: "add-column", columns: cols.length ? cols : adds };
    }
    if (/^add (?:primary|unique|foreign|check|exclude)/i.test(rest)) return { ...out, action: "add-constraint", constraint: null };
    if (/^alter column /i.test(rest)) return { ...out, action: "alter-column" };
    if (/^(?:drop|rename|set|reset|validate|inherit|no inherit)/i.test(rest)) return { ...out, action: "modify" };
    return { ...out, action: "other" };
  }
  if ((m = rx(`^alter sequence (${QN}) (.*)$`).exec(text))) {
    const n = parseName(m[1]);
    return { kind: "alter-sequence", ...n, action: /^owner to/i.test(m[2]) ? "owner" : /^owned by/i.test(m[2]) ? "owned-by" : "other", rest: m[2] };
  }
  if (/^alter (?:function|procedure|aggregate|type|domain|schema|view|materialized view|database|role|user|language|publication|extension) .*? owner to /i.test(head)) return { kind: "owner" };
  if (/^alter (?:publication|default privileges|role|user|database|system)/i.test(head)) return { kind: "other-alter" };
  if (/^(?:grant|revoke)\s/i.test(head)) return { kind: "acl" };
  if (/^comment on /i.test(head)) return { kind: "comment" };
  if (/^(?:insert|update|delete|truncate|copy)\s/i.test(head)) return { kind: "data" };
  if (/^(?:do|drop|begin|commit|notify|vacuum|analyze|select)\s/i.test(head)) return { kind: "other-dml" };
  return { kind: "unknown" };
}
