// Roles R4-4, PR B: Settings > Roles in a club workspace (docs/ai/roles-r4-4-screens-contract.md 5.2, 5.3). The club's
// built-in roles, each with its state in this club, and the club's own roles. Opening a built-in role shows its words
// grouped by module; the first saved change makes the club's own version (O3), which applies to everyone with the role
// in the club. A pure view over roles-layers-data.js (the club's roles and every write) and the R3 roles list and
// catalog; every change goes back through a callback. The club's own roles open the R3 form (unchanged).
import { useId } from "react";
import { RoleWords } from "./role-words.jsx";
import { wordsText } from "../roles-layers-rules.js";

const STATE_TEXT = Object.freeze({
  follows_default: { glyph: "=", text: "Same as OptiMove's default" },
  own_version: { glyph: "✎", text: "Changed for this club" },
  question_pending: { glyph: "!", text: "OptiMove changed the default – your answer is needed" },
});

const people = (n) => `${n} ${n === 1 ? "person" : "people"}`;

function Banner({ command, notice, noticeTone, onCheck }) {
  return (
    <>
      {command?.unconfirmed ? (
        <div className="data-sources-error" role="alert">
          <p><strong>Result not confirmed.</strong> The answer was lost, so it is not known whether this was saved.</p>
          <div className="data-sources-form-actions">
            <button className="plain-button data-sources-primary" type="button" onClick={() => onCheck?.()} disabled={command.busy}>Check result</button>
          </div>
        </div>
      ) : null}
      {notice ? <p className={`club-roles-notice ${noticeTone === "error" ? "builder-error" : "muted"}`} role={noticeTone === "error" ? "alert" : "status"}>{notice}</p> : null}
    </>
  );
}

function LicenceLine({ modules, closedModules }) {
  if (!modules.length) return null;
  const closed = modules.filter((m) => closedModules.includes(m.word));
  return (
    <p className="muted club-roles-licence" data-club-roles-licence>
      {closed.length
        ? `Your club's licence does not include: ${closed.map((m) => m.label).join(", ")}. Those parts are closed for everyone in the club.`
        : "Your club's licence includes every part of OptiMove."}
    </p>
  );
}

function RoleRow({ role, holders, canCopy, busy, onOpen, onCopy }) {
  const state = STATE_TEXT[role.state] || STATE_TEXT.follows_default;
  const changeable = role.actions?.change;
  return (
    <article className="club-roles-row" data-club-role={role.roleId}>
      <div className="club-roles-row-main">
        <strong>{role.name}</strong>
        <span className={`club-roles-state is-${role.state}`}><span aria-hidden="true">{state.glyph} </span>{state.text}</span>
        <small>{holders == null ? "" : people(holders)}{role.basicKey === "club_admin" && !changeable ? `${holders == null ? "" : " · "}Only OptiMove changes this role` : ""}</small>
      </div>
      <div className="club-roles-row-actions">
        <button className="plain-button" type="button" onClick={() => onOpen(role.roleId)}>{changeable ? "Open" : "View"}</button>
        {canCopy ? <button className="plain-button" type="button" disabled={busy} onClick={() => onCopy(role.roleId)}>Copy as a new role</button> : null}
      </div>
    </article>
  );
}

function OwnRoleRow({ role, actions, busy, onOwnOpen, onOwnCopy, onOwnArchive }) {
  return (
    <article className="club-roles-row" data-club-own-role={role.roleId}>
      <div className="club-roles-row-main">
        <strong>{role.name}</strong>
        <small>{role.holderCount == null ? "" : people(role.holderCount)}</small>
      </div>
      <div className="club-roles-row-actions">
        <button className="plain-button" type="button" onClick={() => onOwnOpen(role.roleId)}>{actions?.change ? "Edit" : "View"}</button>
        {actions?.copy ? <button className="plain-button" type="button" disabled={busy} onClick={() => onOwnCopy(role.roleId)}>Copy</button> : null}
        {actions?.archive ? <button className="plain-button danger-button" type="button" disabled={busy} onClick={() => onOwnArchive(role.roleId)}>Archive</button> : null}
      </div>
    </article>
  );
}

function Question({ role, busy, onAnswer }) {
  const changes = role.question?.defaultChanges || { added: [], removed: [] };
  return (
    <section className="club-roles-question" data-club-roles-question>
      <h4>OptiMove changed this role</h4>
      <p>
        {changes.added.length ? `Added: ${wordsText(changes.added)}. ` : ""}
        {changes.removed.length ? `Removed: ${wordsText(changes.removed)}.` : ""}
        {!changes.added.length && !changes.removed.length ? "The default was saved again without a change of permissions." : ""}
      </p>
      <p className="muted">Use the new default to drop this club's own changes, or keep this club's version as it is.</p>
      <div className="data-sources-form-actions">
        <button className="plain-button data-sources-primary" type="button" disabled={busy} onClick={() => onAnswer(role.roleId, "accept_default")}>Use the new default</button>
        <button className="plain-button" type="button" disabled={busy} onClick={() => onAnswer(role.roleId, "keep_mine")}>Keep ours</button>
      </div>
    </section>
  );
}

function StillHolding({ stillHolding, reason, busy, onRemovalReason, onRemove }) {
  const reasonId = useId();
  return (
    <section className="club-roles-still" data-club-roles-still role="status">
      <h4>{`${stillHolding.list.length}${stillHolding.truncated ? "+" : ""} ${stillHolding.list.length === 1 ? "person" : "people"} with a custom version of ${stillHolding.roleName} still have: ${wordsText(stillHolding.words)}`}</h4>
      <ul>{stillHolding.list.map((c) => <li key={c.customId}>{`${c.name || "Someone"} – ${wordsText(c.words)}`}</li>)}</ul>
      {stillHolding.truncated ? <p className="muted">And more – see Users.</p> : null}
      <label className="search-field" htmlFor={reasonId}>
        <span>Reason (kept in each person's history)</span>
        <textarea id={reasonId} rows={2} maxLength={500} value={reason} disabled={busy} onChange={(e) => onRemovalReason(e.target.value)} />
      </label>
      <div className="data-sources-form-actions">
        <button className="plain-button data-sources-primary" type="button" disabled={busy} onClick={() => onRemove()}>Take it from them too</button>
      </div>
    </section>
  );
}

function Editor(props) {
  const { role, clubName, holders, catalog, closedModules, draft, changes, reason, command, platform, stillHolding, removalReason, onClose, onToggle, onReason, onSave, onAnswer, onRemovalReason, onRemove } = props;
  const reasonId = useId();
  const changeable = Boolean(role.actions?.change);
  const pending = role.state === "question_pending";
  const readOnly = !changeable || pending || Boolean(command);
  const changed = changes.add.length + changes.remove.length;
  const busy = Boolean(command);
  return (
    <div className="club-roles-editor" data-club-roles-editor={role.roleId}>
      <button className="plain-button club-roles-back" type="button" disabled={busy && command.busy} onClick={() => onClose()}><span aria-hidden="true">‹ </span>All roles</button>
      <h4 className="club-roles-editor-title">{`${role.name} in ${clubName || "this club"}`}</h4>
      <p className="muted">
        {changeable ? `Changes apply to everyone with this role in ${clubName || "this club"}` : "You can read this role but not change it"}
        {holders == null ? "." : ` (${people(holders)}).`}
      </p>
      {pending && role.actions?.answer ? <Question role={role} busy={busy} onAnswer={onAnswer} /> : null}
      {stillHolding && stillHolding.roleId === role.roleId ? (
        <StillHolding stillHolding={stillHolding} reason={removalReason} busy={busy} onRemovalReason={onRemovalReason} onRemove={onRemove} />
      ) : null}
      <RoleWords
        catalog={catalog}
        items={draft || role.effectiveItems}
        closedModules={closedModules}
        basicKey={role.basicKey || ""}
        scopeTypes={role.scopeTypes || []}
        platform={platform}
        readOnly={readOnly}
        onToggle={onToggle}
      />
      {changed && changeable && !pending ? (
        <div className="club-roles-save" data-club-roles-save>
          <p className="club-roles-changes">
            {changes.add.length ? `Add: ${wordsText(changes.add)}. ` : ""}
            {changes.remove.length ? `Take away: ${wordsText(changes.remove)}.` : ""}
          </p>
          <label className="search-field" htmlFor={reasonId}>
            <span>Reason (kept in the role's history)</span>
            <textarea id={reasonId} rows={2} maxLength={500} value={reason} disabled={busy} onChange={(e) => onReason(e.target.value)} />
          </label>
          <div className="data-sources-form-actions">
            <button className="plain-button" type="button" disabled={busy} onClick={() => onClose()}>Cancel</button>
            <button className="plain-button data-sources-primary" type="button" disabled={busy} onClick={() => onSave()}>
              {command?.busy ? "Saving…" : `Save for ${clubName || "this club"} (${changed} ${changed === 1 ? "change" : "changes"})`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ClubRoles(props) {
  const {
    clubName = "", view = null, loading = false, error = "", catalog = null, r2Roles = [], platform = false, openRoleId = "",
    command = null, notice = "", noticeTone = "ok", canCreate = false, onRetry, onOpen, onCopy, onCheck, onOwnOpen, onOwnNew,
    onOwnCopy, onOwnArchive,
  } = props;
  const titleId = useId();
  const closedModules = view?.closedModules || [];
  const byId = new Map(r2Roles.map((r) => [r.id, r]));
  const busy = Boolean(command);
  const open = openRoleId ? (view?.systemRoles || []).find((r) => r.roleId === openRoleId) : null;
  return (
    <section className="panel club-roles" aria-labelledby={titleId} data-club-roles>
      <div className="club-roles-head">
        <p className="eyebrow">{clubName || "Club"}</p>
        <h3 id={titleId}>Roles</h3>
        <p className="muted">A role is a set of permissions. Give a role to a person in Users.</p>
      </div>
      <Banner command={command} notice={notice} noticeTone={noticeTone} onCheck={onCheck} />
      {loading && !view ? <p className="muted" role="status">Loading the roles…</p> : null}
      {error && !view ? (
        <div className="data-sources-error" role="alert">
          <p>{error}</p>
          <div className="data-sources-form-actions"><button className="plain-button" type="button" onClick={() => onRetry?.()}>Try again</button></div>
        </div>
      ) : null}
      {view && catalog ? (
        open ? (
          <Editor {...props} role={open} holders={byId.get(open.roleId)?.holderCount ?? null} closedModules={closedModules} />
        ) : (
          <>
            <LicenceLine modules={catalog.modules || []} closedModules={closedModules} />
            <h4 className="club-roles-section">Built-in roles</h4>
            <div className="club-roles-list">
              {view.systemRoles.map((role) => (
                <RoleRow key={role.roleId} role={role} holders={byId.get(role.roleId)?.holderCount ?? null} canCopy={Boolean(byId.get(role.roleId)?.actions?.copy)} busy={busy} onOpen={onOpen} onCopy={onCopy} />
              ))}
            </div>
            <div className="club-roles-section-row">
              <h4 className="club-roles-section">{`${clubName || "This club"}'s own roles`}</h4>
              {canCreate ? <button className="plain-button data-sources-primary" type="button" disabled={busy} onClick={() => onOwnNew()}>New role</button> : null}
            </div>
            <div className="club-roles-list">
              {view.clubRoles.length
                ? view.clubRoles.map((role) => (
                  <OwnRoleRow key={role.roleId} role={{ ...role, holderCount: byId.get(role.roleId)?.holderCount ?? null }} actions={byId.get(role.roleId)?.actions} busy={busy} onOwnOpen={onOwnOpen} onOwnCopy={onOwnCopy} onOwnArchive={onOwnArchive} />
                ))
                : <p className="muted">No roles of the club's own yet.</p>}
            </div>
          </>
        )
      ) : null}
    </section>
  );
}
