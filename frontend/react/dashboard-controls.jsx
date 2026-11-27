import { useEffect, useRef } from "react";

export function DashboardPeriodButton({ label, open, activeFilter, onToggle }) {
  return <button type="button" className="plain-button tl-compact-period" aria-expanded={open}
    aria-controls="dashboard-period-panel" onClick={onToggle} aria-label={`Period: ${label}${activeFilter ? ", activity selected" : ""}`}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>
    <span>{label}</span>{activeFilter && <span aria-hidden="true" className="tl-compact-filter-dot"/>}
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
  </button>;
}

export function DashboardPeriodFields({ presets, selected, dateFrom, dateTo, onClose }) {
  return <div className="tl-compact-period-fields">
    <div className="tl-compact-panel-heading"><strong>Period and activity</strong>
      <button type="button" className="plain-button" onClick={onClose} aria-label="Close period and activity">×</button></div>
    <div className="tl-compact-presets" role="group" aria-label="Period presets">{presets.map(preset =>
      <button key={preset.key} type="button" className="plain-button" data-action="training-load-analysis-period-preset"
        data-preset={preset.key} aria-pressed={selected === preset.key}>{preset.label}</button>)}</div>
    <div className="tl-compact-date-range">
      <label>From<input type="date" key={`from-${dateFrom}`} defaultValue={dateFrom} data-action="training-load-analysis-period-from"/></label>
      <label>To<input type="date" key={`to-${dateTo}`} defaultValue={dateTo} data-action="training-load-analysis-period-to"/></label>
    </div>
  </div>;
}

export function DashboardPageStrip({ pages, selectedPageId, page, busy, canManage, menuOpen = false, onMenuOpenChange }) {
  const menu = useRef(null);
  const tabs = useRef(null);
  useEffect(() => {
    const close = event => { if (menu.current && !menu.current.contains(event.target)) { menu.current.open = false; onMenuOpenChange?.(false); } };
    document.addEventListener("pointerdown",close);
    return () => document.removeEventListener("pointerdown",close);
  },[onMenuOpenChange]);
  useEffect(() => {
    const strip=tabs.current;
    const active=strip?.querySelector("[aria-current='page']");
    if(!active) return;
    const left=active.offsetLeft, right=left+active.offsetWidth;
    if(left<strip.scrollLeft) strip.scrollLeft=left;
    else if(right>strip.scrollLeft+strip.clientWidth) strip.scrollLeft=right-strip.clientWidth;
  },[selectedPageId]);
  const closeMenu = () => { if (menu.current) menu.current.open = false; onMenuOpenChange?.(false); };
  return <div className="tl-compact-page-row">
    <label className="tl-compact-page-picker">Page
      <select value={selectedPageId ?? ""} disabled={busy || !pages.length} onChange={event => {
        const pageId = event.currentTarget.value;
        // Route through the same delegated action as the desktop tabs.
        Array.from(tabs.current?.children ?? []).find(button => button.dataset.pageId === pageId)?.click();
      }}>
        {pages.map(item => <option key={item.id} value={item.id}>
          {item.name}{item.is_home && item.name !== "Home" ? " · Home" : ""}
        </option>)}
      </select>
    </label>
    <nav ref={tabs} aria-label="Dashboard pages" className="tl-compact-page-tabs">{pages.map(item =>
      <button type="button" key={item.id} data-action="training-load-pages-select" data-page-id={item.id}
        aria-current={item.id === selectedPageId ? "page" : undefined} disabled={busy}>{item.name}{item.is_home && item.name !== "Home" ? " · Home" : ""}</button>)}</nav>
    {canManage && <div className="tl-compact-page-tools">
      <button type="button" data-action="training-load-pages-create" disabled={busy} aria-label="New page" title="New page">+</button>
      {page && <details className="tl-compact-page-menu" ref={menu} open={menuOpen} onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); closeMenu(); menu.current?.querySelector("summary")?.focus(); }
      }}>
        <summary aria-label="Page actions" title="Page actions" aria-disabled={busy} onClick={event => { event.preventDefault(); if(busy) return; const next=!menu.current.open; menu.current.open=next; onMenuOpenChange?.(next); }}>⋯</summary>
        <div className="tl-compact-page-menu-items" onClick={closeMenu}>
          <button type="button" data-action="training-load-pages-rename" disabled={busy}>Rename page</button>
          <button type="button" data-action="training-load-pages-copy-page" disabled={busy}>Copy page</button>
          <button type="button" data-action="training-load-pages-defaults" disabled={busy}>Default period</button>
          {!page.is_home && <>
            <button type="button" data-action="training-load-pages-up" disabled={busy || page.position <= 1}>Move left</button>
            <button type="button" data-action="training-load-pages-down" disabled={busy || page.position >= pages.length-1}>Move right</button>
            <button type="button" data-action="training-load-pages-delete" className="is-danger" disabled={busy}>Delete page</button>
          </>}
        </div>
      </details>}
    </div>}
  </div>;
}
