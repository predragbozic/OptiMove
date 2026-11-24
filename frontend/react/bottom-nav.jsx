// The phone's main navigation (owner, 2026-11-24): a bar at the bottom of the screen with the main sections and a
// More sheet for the rest. It decides nothing about who sees what: frontend/bottom-nav.js reads the sections from the
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

const FOCUSABLE = "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

function MoreSheet({ groups, titleId, onClose, onSelect }) {
  const sheetRef = useRef(null);
  useEffect(() => {
    sheetRef.current?.querySelector(".om-bottom-sheet-item")?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
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
        <div className="om-bottom-sheet-head">
          <h2 className="om-bottom-sheet-title" id={titleId}>More</h2>
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
      </div>
    </>
  );
}

export function BottomNav({ items = [], more = [], onSelect = () => {} }) {
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
  return (
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
      {open ? (
        <div id={sheetId}>
          <MoreSheet groups={more} titleId={titleId} onClose={close} onSelect={select} />
        </div>
      ) : null}
    </nav>
  );
}
