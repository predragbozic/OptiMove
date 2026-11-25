// Settings > Clubs > a club's licence (roles R4-4, docs/ai/roles-r4-4-screens-contract.md 5.1), for a platform
// administrator. A pure view: frontend/club-licence-data.js owns the read, the draft and the one write, and passes
// them here; every change goes back through a callback. The server decides everything again.
import { useId } from "react";

const dateText = (value) => {
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? "" : t.toLocaleDateString("en-GB");
};

// The licence hierarchy (v96): a part whose parent is not included (in the draft) is closed with it. Its own switch is
// off and cannot be changed until the parent is put back; its own choice is kept and shown.
function ModuleRow({ module, closed, parentLabel = "", parentClosed = false, disabled, onToggle }) {
  const always = module.module === "organization";
  const included = always || (!closed && !parentClosed);
  const noteId = useId();
  return (
    <li className={`club-licence-row${included ? "" : " is-closed"}`}>
      <label className="club-licence-switch">
        <input
          type="checkbox"
          checked={included}
          disabled={always || disabled || parentClosed}
          onChange={() => onToggle(module.module)}
          data-licence-module={module.module}
          aria-describedby={parentClosed ? noteId : undefined}
        />
        <span className="club-licence-name">{module.label || module.module}</span>
        <span className={`club-licence-state ${included ? "is-in" : "is-out"}`}>
          <span aria-hidden="true">{included ? "✓" : "–"}</span> {always ? "Always included" : included ? "Included" : "Not included"}
        </span>
      </label>
      {parentClosed ? (
        <small className="club-licence-note" id={noteId} data-licence-closed-by-parent={module.module}>
          {`Closed because ${parentLabel || "its parent"} is closed.`}
          {closed ? " It is also taken out on its own, so it stays out when you put it back." : ""}
        </small>
      ) : null}
      {module.ceilingEffective === false && !always && !parentClosed ? (
        <small className="club-licence-note">This part does not follow the licence yet.</small>
      ) : null}
    </li>
  );
}

export function ClubLicence({
  clubName = "", open = false, loading = false, error = "", view = null, draftClosed = [], changes = { close: [], open: [] },
  reason = "", command = null, notice = "", noticeTone = "ok", elsewhere = false,
  onOpen, onToggle, onReason, onSave, onCancel, onCheck, onRetry,
}) {
  const titleId = useId();
  const reasonId = useId();
  const modules = view?.modules || [];
  const closedSet = new Set(draftClosed);
  const parentClosed = (m) => Boolean(m.parent) && closedSet.has(m.parent);
  const included = modules.filter((m) => m.module === "organization" || (!closedSet.has(m.module) && !parentClosed(m))).length;
  const changed = changes.close.length + changes.open.length;
  const busy = Boolean(command?.busy);
  const unconfirmed = Boolean(command?.unconfirmed);
  const history = Array.isArray(view?.history) ? view.history : [];
  const label = (word) => modules.find((m) => m.module === word)?.label || word;
  return (
    <section className="panel club-licence" aria-labelledby={titleId} data-club-licence>
      <div className="club-licence-head">
        <div>
          <p className="eyebrow">Licence</p>
          <h3 id={titleId}>{clubName ? `${clubName}'s licence` : "Club licence"}</h3>
          {modules.length ? <p className="muted club-licence-summary">{`${included} of ${modules.length} parts included`}</p> : null}
        </div>
        <button className="plain-button club-licence-toggle" type="button" aria-expanded={open} onClick={() => onOpen?.(!open)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open ? (
        <div className="club-licence-body">
          {elsewhere ? (
            <p className="club-licence-elsewhere" role="status" data-licence-elsewhere>
              {`This is the open change of ${clubName || "another club"}'s licence. Finish it before changing this club's licence.`}
            </p>
          ) : null}
          {notice ? (
            <p className={`club-licence-notice ${noticeTone === "error" ? "builder-error" : "muted"}`} role={noticeTone === "error" ? "alert" : "status"}>{notice}</p>
          ) : null}
          {unconfirmed ? (
            <div className="data-sources-error" role="alert">
              <p><strong>Result not confirmed.</strong> The answer was lost, so it is not known whether the licence was saved.</p>
              <div className="data-sources-form-actions">
                <button className="plain-button data-sources-primary" type="button" onClick={() => onCheck?.()} disabled={busy}>Check result</button>
              </div>
            </div>
          ) : null}
          {loading && !view ? <p className="muted" role="status">Loading the licence…</p> : null}
          {error && !view ? (
            <div className="data-sources-error" role="alert">
              <p>{error}</p>
              <div className="data-sources-form-actions"><button className="plain-button" type="button" onClick={() => onRetry?.()}>Try again</button></div>
            </div>
          ) : null}
          {modules.length ? (
            <>
              <p className="muted">A part that is not included is closed for everyone in this club, its administrators too. You are never limited.</p>
              <ul className="club-licence-list">
                {modules.map((m) => (
                  <ModuleRow key={m.module} module={m} closed={closedSet.has(m.module)} parentClosed={parentClosed(m)}
                    parentLabel={m.parent ? label(m.parent) : ""} disabled={Boolean(command)} onToggle={onToggle} />
                ))}
              </ul>
              {changed ? (
                <div className="club-licence-save" data-licence-save>
                  <p className="club-licence-changes">
                    {changes.close.length ? `Take out: ${changes.close.map(label).join(", ")}. ` : ""}
                    {changes.open.length ? `Put back: ${changes.open.map(label).join(", ")}.` : ""}
                  </p>
                  <label className="search-field" htmlFor={reasonId}>
                    <span>Reason (kept in the licence's history)</span>
                    <textarea id={reasonId} rows={2} maxLength={500} value={reason} disabled={Boolean(command)} onChange={(event) => onReason?.(event.target.value)} />
                  </label>
                  <div className="data-sources-form-actions">
                    <button className="plain-button" type="button" onClick={() => onCancel?.()} disabled={Boolean(command)}>Cancel</button>
                    <button className="plain-button data-sources-primary" type="button" onClick={() => onSave?.()} disabled={Boolean(command)}>
                      {busy ? "Saving…" : `Save licence (${changed} ${changed === 1 ? "change" : "changes"})`}
                    </button>
                  </div>
                </div>
              ) : null}
              {history.length ? (
                <details className="club-licence-history">
                  <summary>{`History (${history.length})`}</summary>
                  <ol>
                    {history.map((h, index) => (
                      <li key={`${h.at}-${h.module}-${index}`}>{`${dateText(h.at)} · ${label(h.module)} ${h.action === "close" ? "taken out" : "put back"}${h.reason ? ` · ${h.reason}` : ""}`}</li>
                    ))}
                  </ol>
                </details>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
