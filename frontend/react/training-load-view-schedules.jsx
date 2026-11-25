import { useEffect, useState } from "react";

const dateLabel = date => /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? date.split("-").reverse().join(".") : "";
const scheduleStatus = { active: "Active", paused: "Paused", cancelled: "Cancelled" };

export function TrainingLoadViewSchedules({ loadSchedules }) {
  const [state, setState] = useState({ status: "loading", schedules: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    loadSchedules(controller.signal).then(
      response => { if (!controller.signal.aborted) setState({ status: "ready", schedules: response.schedules ?? [] }); },
      () => { if (!controller.signal.aborted) setState({ status: "error", schedules: [] }); }
    );
    return () => controller.abort();
  }, [loadSchedules, attempt]);

  function retry() {
    setState({ status: "loading", schedules: [] });
    setAttempt(previous => previous + 1);
  }

  return <div className="training-load-schedule-summary">
    <h2>External schedules</h2>
    {state.status === "loading" && <p role="status">Loading schedules…</p>}
    {state.status === "error" && <>
      <p role="alert">Schedules could not be loaded.</p>
      <button type="button" className="plain-button" onClick={retry}>Try again</button>
    </>}
    {state.status === "ready" && (state.schedules.length ? <ul className="training-load-readonly-schedules">
      {state.schedules.map(schedule => <li key={schedule.id} className="tl-agenda-card tl-agenda-card-static">
        <span className="tl-agenda-main"><strong>{schedule.eventName}</strong>
          <span>{dateLabel(schedule.startDate)}{schedule.endDate && schedule.endDate !== schedule.startDate ? ` – ${dateLabel(schedule.endDate)}` : ""}</span>
        </span>
        {scheduleStatus[schedule.status] && <span className="tl-agenda-badge">{scheduleStatus[schedule.status]}</span>}
      </li>)}
    </ul> : <p>No external schedules to show.</p>)}
  </div>;
}
