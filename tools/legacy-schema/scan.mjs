// The scanner that decides whether a generated file may be written. It reports
// rule names and line numbers only, never the text that matched.

const RULES = [
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["connection-string-with-password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"/@:]+:[^\s'"/@]+@/i],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["api-token-shape", /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bghp_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ["email-address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/],
  ["role-password", /\bpassword\s+'[^']+'|\bencrypted\s+password\b/i],
  ["literal-secret-assignment", /[A-Za-z0-9_"]*(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|webhook[_-]?key|signing[_-]?key|hmac[_-]?key|encryption[_-]?key|access[_-]?key|auth[_-]?key|salt|pepper|credential|passphrase|bearer)[A-Za-z0-9_"]*(?:\s+[a-z_][a-z0-9_ ]{0,40}?(?:\([^)]*\))?)?\s*(?:=|:=|default)\s*(?:E|U&)?'[^']{3,}'/i],
  ["secret-function-argument", /\b(?:jwt|secret|hmac|crypt|vault|pgp_sym_encrypt|encrypt)\w*\s*\((?!\s*'(?:search_path|check_function_bodies|client_min_messages|row_security|default_tablespace)')[^;\n]{0,120}'[^']{3,}'/i],
  ["uuid-literal", /'(?!00000000-0000-0000-0000-000000000000')[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i],
  ["url", /\b[a-z][a-z0-9+.-]*:\/\/\S/i],
  ["ipv4-address", /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/],
  ["line-too-long", /^[\s\S]{20000,}$/],
  ["long-random-literal", /'(?=[A-Za-z0-9+\/=_-]*[0-9])(?=[A-Za-z0-9+\/=_-]*[A-Za-z])[A-Za-z0-9+\/=_-]{32,}'/],
  ["hash-shape", /'\$(?:2[aby]|argon2[id]*|pbkdf2[-a-z0-9]*|scrypt)\$[^']{10,}'/i],
];

// Joins `'a' || 'b'` literals and turns short dollar-quoted literals that are not a
// function body (`AS $$ ... $$`) into single-quoted ones, so that a secret split by
// concatenation or written as $$secret$$ meets the same rules.
export function normalizeForScan(text) {
  let out = text.replace(/'\s*\|\|\s*'/g, "");
  out = out.replace(/(?<!\bAS\s)(\$([A-Za-z_][A-Za-z0-9_]*)?\$)([^$\n]{1,200}?)\1/gi, (_m, _t, _n, body) => `'${body.replace(/'/g, "''")}'`);
  return out;
}

export function scanText(text) {
  const findings = [];
  const seen = new Set();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    // A line longer than any real statement line is a finding of its own; the
    // other rules are not run on it (they are quadratic on very long runs).
    if (lines[i].length >= 20000) { findings.push({ rule: "line-too-long", line: i + 1 }); continue; }
    for (const [rule, re] of RULES) if (rule !== "line-too-long" && re.test(lines[i])) { findings.push({ rule, line: i + 1 }); seen.add(`${rule}:${i + 1}`); }
  }
  // The same rules on the normalised text (line numbers are preserved: the
  // normalisation never adds or removes a newline).
  const normalized = normalizeForScan(text).split("\n");
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized[i].length >= 20000) continue;
    for (const [rule, re] of RULES) {
      if (rule !== "line-too-long" && re.test(normalized[i]) && !seen.has(`${rule}:${i + 1}`)) findings.push({ rule, line: i + 1 });
    }
  }
  return findings;
}

export const SCAN_RULES = RULES.map(([rule]) => rule);
