// Splits the text of a `pg_restore --schema-only -f` / `pg_dump --schema-only`
// script into statements. Offline and pure: no database, no network.
//
// Understood: `-- ...` and nested `/* ... */` comments (dropped), single-quoted
// strings (with '' and, for E'..', backslash escapes), "quoted identifiers",
// $tag$ ... $tag$ dollar quoting, psql meta-command lines (`\restrict KEY`,
// `\connect x`, dropped and reported), and `COPY ... FROM stdin;` data blocks
// (reported as data, never returned as statements).

export function splitStatements(text) {
  const statements = [];
  const metaLines = [];
  const dataBlocks = [];
  const n = text.length;
  let i = 0;
  let cur = "";
  let line = 1;
  let startLine = 1;
  const flush = () => {
    const t = cur.trim();
    if (t) statements.push({ text: t, line: startLine });
    cur = "";
  };
  const begin = () => { if (!cur.trim()) startLine = line; };
  while (i < n) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    if (c === "\n") { cur += c; line += 1; i += 1; continue; }
    // psql meta-command: a line starting with a backslash while no statement is open
    if (c === "\\" && !cur.trim() && (i === 0 || text[i - 1] === "\n")) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      metaLines.push({ text: text.slice(i, stop), line });
      i = stop;
      continue;
    }
    if (two === "--") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text.slice(i, i + 2) === "/*") { depth += 1; i += 2; } else if (text.slice(i, i + 2) === "*/") { depth -= 1; i += 2; } else { if (text[i] === "\n") line += 1; i += 1; }
      }
      continue;
    }
    if (c === "'") {
      begin();
      const escape = /[eE]$/.test(cur) && !/[A-Za-z0-9_]$/.test(cur.slice(0, -1));
      let j = i + 1;
      while (j < n) {
        if (escape && text[j] === "\\") { j += 2; continue; }
        if (text[j] === "'") { if (text[j + 1] === "'") { j += 2; continue; } break; }
        j += 1;
      }
      const chunk = text.slice(i, j + 1);
      line += (chunk.match(/\n/g) || []).length;
      cur += chunk;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      begin();
      let j = i + 1;
      while (j < n) {
        if (text[j] === '"') { if (text[j + 1] === '"') { j += 2; continue; } break; }
        j += 1;
      }
      cur += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 80));
      if (m) {
        begin();
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        const chunk = text.slice(i, stop);
        line += (chunk.match(/\n/g) || []).length;
        cur += chunk;
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      cur += ";";
      const t = cur.trim();
      if (/^copy\s/i.test(t) && /\sfrom\s+stdin\s*;$/i.test(t)) {
        // A data block: everything up to a line holding only `\.`
        const startData = i + 1;
        const m = /\n\\\.[ \t]*(\n|$)/.exec(text.slice(startData));
        const stop = m ? startData + m.index + m[0].length : n;
        dataBlocks.push({ text: t, line: startLine });
        line += (text.slice(i + 1, stop).match(/\n/g) || []).length;
        i = stop;
        cur = "";
        continue;
      }
      flush();
      i += 1;
      continue;
    }
    begin();
    cur += c;
    i += 1;
  }
  flush();
  return { statements, metaLines, dataBlocks };
}
