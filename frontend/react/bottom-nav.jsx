// The phone's main navigation (owner, 2026-11-24): a bar at the bottom of the screen - Home first, then three sections
// of the person's own choice (Edit menu, in More; defaults per role) - and a More sheet for the rest. It decides nothing about who sees what: frontend/bottom-nav.js reads the sections from the
// existing menu (the same items, hidden for the same roles) and passes them here, and a tap goes back to the plain
// app through onSelect, which runs the menu's own control (its leave guards and history included).
import { useEffect, useId, useRef, useState } from "react";

function Icon({ markup }) {
  // The markup is the menu's own static <svg> from index.html / athlete.html, never data from the server or a user.
  return markup ? <span className="om-bottom-nav-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} /> : <span className="om-bottom-nav-icon" aria-hidden="true" />;
}

function MoreIcon() {
  return (
    <span className="om-bottom-nav-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
    </span>
  );
}

const FOCUSABLE = "button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
const PLACE_NAMES = ["Second", "Third", "Fourth"];

// Edit menu: the three places after Home. Choosing a section another place already holds swaps the two, so a section
// is never twice on the bar. Nothing is kept until Save.
function EditMenu({ slots, defaults, options, titleId, onSave, onCancel }) {
  const [draft, setDraft] = useState(slots);
  const firstRef = useRef(null);
  useEffect(() => { firstRef.current?.focus({ preventScroll: true }); }, []);
  const choose = (index, id) => {
    setDraft((current) => {
      const next = [...current];
      const other = next.indexOf(id);
      if (other >= 0) next[other] = next[index];
      next[index] = id;
      return next;
    });
  };
  const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
  return (
    <div className="om-bottom-sheet-edit">
      <h2 className="om-bottom-sheet-title" id={titleId}>Edit menu</h2>
      <p className="om-bottom-sheet-note">Home stays first. Choose the sections for the next three buttons; the rest stay under More. A section another button already shows swaps places with it.</p>
      {draft.map((id, index) => (
        <label key={PLACE_NAMES[index]} className="om-bottom-sheet-field">
          <span>{`${PLACE_NAMES[index]} button`}</span>
          <select ref={index === 0 ? firstRef : undefined} value={id} onChange={(event) => choose(index, event.target.value)}>
            {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
      ))}
      <div className="om-bottom-sheet-actions">
        <button className="om-bottom-sheet-primary" type="button" onClick={() => onSave(draft)}>Save</button>
        <button className="om-bottom-sheet-secondary" type="button" onClick={onCancel}>Cancel</button>
        {same(draft, defaults) ? null : <button className="om-bottom-sheet-secondary" type="button" onClick={() => setDraft(defaults)}>Use the default</button>}
      </div>
    </div>
  );
}

function MoreSheet({ groups, titleId, onClose, onSelect, edit }) {
  const sheetRef = useRef(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) sheetRef.current?.querySelector(".om-bottom-sheet-item")?.focus({ preventScroll: true });
  }, [editing]);
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      // Closes the sheet only: the app's own Escape (the drawer, a panel underneath) does not run as well.
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent?.stopImmediatePropagation?.();
      onClose({ restoreFocus: true });
      return;
    }
    if (event.key !== "Tab") return;
    // The sheet is modal: Tab and Shift+Tab stay inside it.
    const nodes = [...(sheetRef.current?.querySelectorAll(FOCUSABLE) || [])];
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return (
    <>
      <button className="om-bottom-sheet-backdrop" type="button" tabIndex={-1} aria-label="Close More" onClick={() => onClose({ restoreFocus: true })} />
      <div className="om-bottom-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={sheetRef} onKeyDown={onKeyDown}>
        {editing ? (
          <EditMenu
            slots={edit.slots}
            defaults={edit.defaults}
            options={edit.options}
            titleId={titleId}
            onSave={(slots) => { edit.onSave(slots); onClose({ restoreFocus: true }); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
        <>
        <div className="om-bottom-sheet-head">
          <h2 className="om-bottom-sheet-title" id={titleId}>More</h2>
          {edit ? <button className="om-bottom-sheet-secondary om-bottom-sheet-edit-open" type="button" onClick={() => setEditing(true)}>Edit menu</button> : null}
          <button className="om-bottom-sheet-close" type="button" aria-label="Close More" onClick={() => onClose({ restoreFocus: true })}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <ul className="om-bottom-sheet-list">
          {groups.map((group) => (
            <li key={group.id} className="om-bottom-sheet-group">
              <button className={`om-bottom-sheet-item${group.active ? " is-active" : ""}`} type="button" aria-current={group.active ? "page" : undefined} onClick={() => onSelect(group.id)}>
                <Icon markup={group.icon} />
                <span>{group.label}</span>
              </button>
              {group.children?.length ? (
                <ul className="om-bottom-sheet-sublist" aria-label={`${group.label} sections`}>
                  {group.children.map((child) => (
                    <li key={child.id}>
                      <button className={`om-bottom-sheet-subitem${child.active ? " is-active" : ""}`} type="button" aria-current={child.active ? "page" : undefined} onClick={() => onSelect(child.id)}>
                        {child.label}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
        </>
        )}
      </div>
    </>
  );
}

export function BottomNav({ items = [], more = [], onSelect = () => {}, slots = [], defaults = [], options = [], onSaveSlots }) {
  // Edit menu is offered when there is a real choice: a save callback and more sections than places.
  const edit = onSaveSlots && slots.length && options.length > slots.length ? { slots, defaults, options, onSave: onSaveSlots } : null;
  const [open, setOpen] = useState(false);
  const moreRef = useRef(null);
  const titleId = useId();
  const sheetId = useId();
  const moreActive = more.some((group) => group.active || group.children?.some((child) => child.active));
  const activeInMore = more.flatMap((group) => [group, ...(group.children || [])]).filter((item) => item.active).map((item) => item.label).pop();
  const close = ({ restoreFocus = false } = {}) => {
    setOpen(false);
    if (restoreFocus) moreRef.current?.focus({ preventScroll: true });
  };
  const select = (id) => {
    setOpen(false);
    onSelect(id);
  };
  // Nothing left for the sheet (a role with few sections): the sheet closes.
  useEffect(() => { if (open && !more.length) setOpen(false); }, [open, more.length]);
  // The sheet is a sibling of the bar, never inside it: the fixed bar (z 40) is a stacking context, and a sheet inside it
  // would stay under every layer above 40 (the header, the drawer, dropdowns) whatever its own z-index.
  return (
    <>
    <nav className="om-bottom-nav" aria-label="Main">
      <ul className="om-bottom-nav-list">
        {items.map((item) => (
          <li key={item.id}>
            <button
              className={`om-bottom-nav-item${item.active ? " is-active" : ""}`}
              type="button"
              data-nav-id={item.id}
              aria-current={item.active ? "page" : undefined}
              aria-expanded={item.expanded === undefined ? undefined : item.expanded}
              onClick={() => select(item.id)}
            >
              <Icon markup={item.icon} />
              <span className="om-bottom-nav-label">{item.label}</span>
            </button>
          </li>
        ))}
        {more.length ? (
          <li>
            <button
              className={`om-bottom-nav-item${moreActive ? " is-active" : ""}`}
              type="button"
              data-nav-id="more"
              ref={moreRef}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={open ? sheetId : undefined}
              onClick={() => setOpen((value) => !value)}
            >
              <MoreIcon />
              <span className="om-bottom-nav-label">More</span>
              {moreActive && activeInMore ? <span className="visually-hidden">{`, current: ${activeInMore}`}</span> : null}
            </button>
          </li>
        ) : null}
      </ul>
    </nav>
    {open ? (
      <div id={sheetId} className="om-bottom-sheet-layer">
        <MoreSheet groups={more} titleId={titleId} onClose={close} onSelect={select} edit={edit} />
      </div>
    ) : null}
    </>
  );
}
