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
  ["literal-secret-assignment", /[A-Za-z0-9_"]*(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key)[A-Za-z0-9_"]*(?:\s+[a-z_][a-z0-9_ ]{0,40}?)?\s*(?:=|:=|default)\s*(?:E|U&)?'[^']{3,}'/i],
  ["url", /\b[a-z][a-z0-9+.-]*:\/\/\S/i],
  ["ipv4-address", /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/],
  ["line-too-long", /^[\s\S]{20000,}$/],
  ["long-random-literal", /'(?=[A-Za-z0-9+\/=_-]*[0-9])(?=[A-Za-z0-9+\/=_-]*[A-Za-z])[A-Za-z0-9+\/=_-]{32,}'/],
  ["hash-shape", /'\$(?:2[aby]|argon2[id]*|pbkdf2[-a-z0-9]*|scrypt)\$[^']{10,}'/i],
];

export function scanText(text) {
  const findings = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    // A line longer than any real statement line is a finding of its own; the
    // other rules are not run on it (they are quadratic on very long runs).
    if (lines[i].length >= 20000) { findings.push({ rule: "line-too-long", line: i + 1 }); continue; }
    for (const [rule, re] of RULES) if (rule !== "line-too-long" && re.test(lines[i])) findings.push({ rule, line: i + 1 });
  }
  return findings;
}

export const SCAN_RULES = RULES.map(([rule]) => rule);
