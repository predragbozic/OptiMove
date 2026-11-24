// Roles R4-4, PR B: Settings > Users > Access in this club (docs/ai/roles-r4-4-screens-contract.md 5.4, 5.5). Choose a
// person; see their roles in the club, each with its permissions grouped by module and what differs for this person
// ("<Role> (custom)", O4); change one person's permissions, or go back to the role. On top, the people whose custom
// version still has permissions their role no longer gives (Q15), with Take it from them too. A pure view over
// roles-layers-data.js; every change goes back through a callback.
import { useId, useState } from "react";
import { RoleWords } from "./role-words.jsx";
import { wordsText } from "../roles-layers-rules.js";

const ddmmyyyy = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`; };

function Drift({ drift, busy, ask, onDriftAsk, onDriftReason, onDriftCancel, onDriftRemove }) {
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  if (!drift?.length) return null;
  const byRoleWord = [];
  for (const c of drift) for (const w of c.words) {
    let entry = byRoleWord.find((e) => e.roleId === c.roleId && e.word === w);
    if (!entry) byRoleWord.push(entry = { roleId: c.roleId, roleName: c.roleName, word: w, names: [] });
    entry.names.push(c.name || "Someone");
  }
  const peopleCount = new Set(drift.map((c) => c.userId)).size;
  return (
    <details className="person-access-drift" data-person-drift open={open || Boolean(ask)} onToggle={(ev) => setOpen(ev.currentTarget.open)}>
      <summary>{`${peopleCount} ${peopleCount === 1 ? "person still has" : "people still have"} permissions their role no longer gives`}</summary>
      <ul>
        {byRoleWord.map((e) => (
          <li key={`${e.roleId}-${e.word}`} className="person-access-drift-row">
            <span>{`${e.roleName}: ${wordsText([e.word])} – ${e.names.join(", ")}`}</span>
            {ask && ask.roleId === e.roleId && ask.word === e.word ? (
              <div className="person-access-drift-ask" data-drift-ask>
                <p>{`Take ${wordsText([e.word])} from: ${ask.names.join(", ")}?`}</p>
                <label className="search-field" htmlFor={reasonId}>
                  <span>Reason (kept in each person's history)</span>
                  <textarea id={reasonId} rows={2} maxLength={500} value={ask.reason} disabled={busy} onChange={(ev) => onDriftReason(ev.target.value)} />
                </label>
                <div className="data-sources-form-actions">
                  <button className="plain-button data-sources-primary" type="button" disabled={busy || !ask.reason.trim()} onClick={() => onDriftRemove()}>{`Take it from ${ask.names.length} ${ask.names.length === 1 ? "person" : "people"}`}</button>
                  <button className="plain-button" type="button" disabled={busy} onClick={() => onDriftCancel()}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="plain-button" type="button" disabled={busy || Boolean(ask)} onClick={() => onDriftAsk(e.roleId, e.word)}>Take it from them</button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Holding(props) {
  const { h, name, teamName, catalog, closedModules, platform, blocked, editing, draft, changes, reason, ending, endReason, command, onEdit, onCancel, onToggle, onReason, onSave, onAskEnd, onEndReason, onEnd } = props;
  const reasonId = useId();
  const endId = useId();
  const busy = Boolean(command);
  const custom = h.custom?.live ? h.custom : null;
  const changed = changes.add.length + changes.remove.length;
  const stillHeld = Object.fromEntries((h.stillHeldThrough || []).map((s) => [s.word, s.roles]));
  const clubAdmin = h.scopeType === "club" && h.source === "basic";
  return (
    <section className="person-access-holding" data-person-holding={`${h.roleId}|${h.scopeType}|${h.scopeId}`}>
      <div className="person-access-holding-head">
        <div>
          <strong>{custom ? `${h.roleName} (custom)` : h.roleName}</strong>
          <small>{h.scopeType === "team" ? `Team · ${teamName || "a team"}` : "Whole club"}</small>
        </div>
        {!editing && !ending && !blocked ? (
          <div className="person-access-holding-actions">
            <button className="plain-button" type="button" disabled={busy} onClick={() => onEdit()}>{`Change for ${name}`}</button>
            {custom ? <button className="plain-button" type="button" disabled={busy} onClick={() => onAskEnd()}>{`Back to ${h.roleName}`}</button> : null}
          </div>
        ) : null}
      </div>
      {blocked ? <p className="muted person-access-blocked">{blocked}</p> : null}
      {custom && (custom.added?.length || custom.removed?.length) ? (
        <ul className="person-access-diff">
          {custom.added?.length ? <li>{`Added for ${name}: ${wordsText(custom.added)}`}</li> : null}
          {custom.removed?.length ? <li>{`Taken away for ${name}: ${wordsText(custom.removed)}`}</li> : null}
        </ul>
      ) : null}
      {editing && !custom ? <p className="muted">{`Only ${name} gets this. Later changes of ${h.roleName} will not reach ${name}.`}</p> : null}
      {ending ? (
        <div className="person-access-end" data-person-end>
          <p>{`${name} gets ${h.roleName} as it is in this club again; the changes made for ${name} end.`}</p>
          <label className="search-field" htmlFor={endId}>
            <span>Reason (kept in this person's history)</span>
            <textarea id={endId} rows={2} maxLength={500} value={endReason} disabled={busy} onChange={(e) => onEndReason(e.target.value)} />
          </label>
          <div className="data-sources-form-actions">
            <button className="plain-button" type="button" disabled={busy} onClick={() => onCancel()}>Cancel</button>
            <button className="plain-button data-sources-primary" type="button" disabled={busy || !endReason.trim()} onClick={() => onEnd()}>{`Back to ${h.roleName}`}</button>
          </div>
        </div>
      ) : null}
      <RoleWords
        catalog={catalog}
        items={editing && draft ? draft : (custom ? custom.items : h.roleItems)}
        closedModules={closedModules}
        basicKey={clubAdmin ? "club_admin" : ""}
        scopeTypes={[h.scopeType]}
        platform={platform}
        readOnly={!editing || busy}
        onToggle={onToggle}
        stillHeld={stillHeld}
      />
      {editing ? (
        <div className="club-roles-save" data-person-save>
          {changed ? (
            <p className="club-roles-changes">
              {changes.add.length ? `Add for ${name}: ${wordsText(changes.add)}. ` : ""}
              {changes.remove.length ? `Take away for ${name}: ${wordsText(changes.remove)}.` : ""}
            </p>
          ) : <p className="muted">Tick or untick a permission to change it for this person.</p>}
          {changed ? (
            <label className="search-field" htmlFor={reasonId}>
              <span>Reason (kept in this person's history)</span>
              <textarea id={reasonId} rows={2} maxLength={500} value={reason} disabled={busy} onChange={(e) => onReason(e.target.value)} />
            </label>
          ) : null}
          <div className="data-sources-form-actions">
            <button className="plain-button" type="button" disabled={busy} onClick={() => onCancel()}>Cancel</button>
            {changed ? (
              <button className="plain-button data-sources-primary" type="button" disabled={busy || !reason.trim()} onClick={() => onSave()}>
                {command?.busy ? "Saving…" : `Save for ${name} (${changed} ${changed === 1 ? "change" : "changes"})`}
              </button>
            ) : null}
          </div>
          {changed && !reason.trim() ? <p className="muted club-roles-save-hint">Write a reason to save.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

export function PersonAccess(props) {
  const {
    clubName = "", people = [], userId = "", selfId = "", catalog = null, view = null, loading = false, error = "", noRole = false, editKey = "",
    endKey = "", command = null, notice = "", noticeTone = "ok", drift = null, driftError = "", platform = false, teams = [],
    driftAsk = null, onPick, onCheck, onDriftAsk, onDriftReason, onDriftCancel, onDriftRemove, onRetry,
  } = props;
  const titleId = useId();
  const pickId = useId();
  const busy = Boolean(command);
  const name = view?.name || "this person";
  const clubAdminHolder = (view?.holdings || []).some((h) => h.scopeType === "club" && h.source === "basic");
  const blockedFor = () => {
    if (userId && userId === selfId) return "You can't change your own access.";
    if (clubAdminHolder && !platform) return "Only OptiMove can change a club administrator.";
    return "";
  };
  const teamName = (id) => teams.find((t) => String(t.id) === String(id))?.name || "";
  return (
    <section className="panel person-access" aria-labelledby={titleId} data-person-access>
      <div className="person-access-head">
        <p className="eyebrow">Access</p>
        <h3 id={titleId}>{`Access in ${clubName || "this club"}`}</h3>
        <p className="muted">Choose a person to see their roles here and change what one person may do.</p>
      </div>
      {command?.unconfirmed ? (
        <div className="data-sources-error" role="alert">
          <p><strong>Result not confirmed.</strong> The answer was lost, so it is not known whether this was saved.</p>
          <div className="data-sources-form-actions"><button className="plain-button data-sources-primary" type="button" disabled={command.busy} onClick={() => onCheck?.()}>Check result</button></div>
        </div>
      ) : null}
      {notice ? <p className={`club-roles-notice ${noticeTone === "error" ? "builder-error" : "muted"}`} role={noticeTone === "error" ? "alert" : "status"}>{notice}</p> : null}
      {driftError || error ? (
        <div className="data-sources-error" role="alert">
          <p>{error || driftError}</p>
          <div className="data-sources-form-actions"><button className="plain-button" type="button" disabled={busy} onClick={() => onRetry?.()}>Try again</button></div>
        </div>
      ) : null}
      <Drift drift={drift} busy={busy} ask={driftAsk} onDriftAsk={onDriftAsk} onDriftReason={onDriftReason} onDriftCancel={onDriftCancel} onDriftRemove={onDriftRemove} />
      <label className="search-field person-access-pick" htmlFor={pickId}>
        <span>Person</span>
        <select id={pickId} value={userId} disabled={busy} onChange={(e) => onPick(e.target.value)}>
          <option value="">Choose a person</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {loading ? <p className="muted" role="status">Loading…</p> : null}
      {noRole ? <p className="muted" role="status">This person has no role in this club you can change.</p> : null}
      {view && catalog ? (
        <div className="person-access-holdings">
          {!view.holdings.length ? <p className="muted">{`${name} has no role in this club yet.`}</p> : null}
          {view.holdings.map((h) => {
            const key = `${h.roleId}|${h.scopeType}|${h.scopeId}`;
            return (
              <Holding
                key={key}
                {...props}
                h={h}
                name={name}
                teamName={teamName(h.scopeId)}
                closedModules={view.closedModules || []}
                blocked={blockedFor()}
                editing={editKey === key}
                ending={endKey === key}
                onEdit={() => props.onEdit(key)}
                onAskEnd={() => props.onAskEnd(key)}
              />
            );
          })}
          {view.customHistory?.length ? (
            <details className="person-access-history">
              <summary>{`Earlier custom versions (${view.customHistory.length})`}</summary>
              <ul>{view.customHistory.map((c) => <li key={c.id}>{`${c.name}${c.endedAt ? ` · ended ${ddmmyyyy(c.endedAt)}` : ""}`}</li>)}</ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
