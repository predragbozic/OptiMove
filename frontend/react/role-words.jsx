// Roles R4-4, PR B: the word list of a role, grouped by module (docs/ai/roles-r4-4-screens-contract.md 5.2, 5.4).
// Used by the club's version of a built-in role and by one person's custom role. A pure view: the ticks come in as
// `items`, each change goes back through `onToggle`; roles-layers-rules.js decides which words are locked and why.
import { useState } from "react";
import { roleWordGroups, wordLabel, wordLock } from "../roles-layers-rules.js";

function Group({ group, items, ctx, closed, readOnly, onToggle, stillHeld }) {
  const [open, setOpen] = useState(!closed);
  const on = group.words.filter((w) => items.includes(w)).length;
  const id = `role-words-${group.key}`;
  return (
    <section className={`role-words-group${closed ? " is-closed" : ""}`} data-role-words-group={group.key}>
      <button className="role-words-head" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="role-words-title">{group.label}</span>
        <span className="role-words-count">
          {closed ? <><span aria-hidden="true">⊘ </span>Not in your club's licence</> : `${on} of ${group.words.length} on`}
        </span>
      </button>
      {open ? (
        <ul className="role-words-list" id={id}>
          {group.words.map((word) => {
            const ticked = items.includes(word);
            const lock = wordLock(word, { ...ctx, ticked });
            const through = stillHeld?.[word];
            return (
              <li key={word} className={`role-words-row${lock ? " is-locked" : ""}`}>
                <label className="role-words-label">
                  <input type="checkbox" checked={ticked} disabled={readOnly || Boolean(lock)} onChange={() => onToggle?.(word)} data-role-word={word} />
                  <span className="role-words-name">{wordLabel(word)}</span>
                </label>
                {lock ? <small className="role-words-lock">{lock}</small> : null}
                {through ? <small className="role-words-through">{`Still has it through ${through.join(", ")}`}</small> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export function RoleWords({ catalog, items = [], closedModules = [], basicKey = "", scopeTypes = [], platform = false, readOnly = false, onToggle, stillHeld = null }) {
  const groups = roleWordGroups(catalog, { basicKey, scopeTypes });
  const ctx = { catalog, closedModules, basicKey, platform };
  return (
    <div className="role-words" data-role-words>
      {groups.map((group) => (
        <Group
          key={group.key}
          group={group}
          items={items}
          ctx={ctx}
          closed={closedModules.includes(group.key)}
          readOnly={readOnly}
          onToggle={onToggle}
          stillHeld={stillHeld}
        />
      ))}
    </div>
  );
}
