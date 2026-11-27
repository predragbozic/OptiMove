import { useEffect, useRef } from "react";

export function BuilderRpeReview({ summary, scope, confirming }) {
  const dialog = useRef(null);
  useEffect(() => {
    const node = dialog.current;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
    return () => { if (node.open && typeof node.close === "function") node.close(); };
  }, []);
  return (
    <dialog ref={dialog} className="panel builder-rpe-review" aria-labelledby="builder-rpe-review-title"
      onCancel={event => {
        event.preventDefault();
        if (!confirming) event.currentTarget.querySelector('[data-action="builder-rpe-review-cancel"]')?.click();
      }}>
      <h2 id="builder-rpe-review-title">Confirm Training Load settings</h2>
      <p>{scope === "all" ? "Review these settings for the selected plans before saving." : "Review these settings for this plan before saving."}</p>
      <dl>
        <div><dt>Plans</dt><dd>{summary.plans}</dd></div>
        <div><dt>Sessions</dt><dd>{summary.sessions}</dd></div>
        <div><dt>Tracking on</dt><dd>{summary.trackingEnabledSessions}</dd></div>
        <div><dt>RPE requested</dt><dd>{summary.rpeEnabledSessions}</dd></div>
        <div><dt>Tracking for new sessions</dt><dd>{summary.trackTrainingLoadDefault ? "On" : "Off"}</dd></div>
        <div><dt>Request RPE for new sessions</dt><dd>{summary.requestRpeDefault ? "On" : "Off"}</dd></div>
      </dl>
      <div className="builder-rpe-review-actions">
        <button type="button" className="plain-button" data-action="builder-rpe-review-cancel" disabled={confirming} autoFocus>Cancel</button>
        <button type="button" className="primary-button" data-action="builder-rpe-review-confirm" disabled={confirming}>
          {confirming ? "Saving…" : "Confirm and save"}
        </button>
      </div>
    </dialog>
  );
}
