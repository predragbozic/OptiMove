// Real Calendar routes with valid bodies. Tests replace only the resource IDs and request keys.
export function calendarManageCases({ eventId, eventTypeId, clubId, teamId, detailId, locationId, auxiliaryId, requestKey }) {
  const named = (suffix, method = "POST", body = {}) => ({
    method, path: `/api/calendar/events/${eventId}${suffix}`, body: { requestKey: requestKey(), expectedRevision: 1, ...body }, status: 404,
  });
  const settings = (suffix, method, status, body) => ({
    method, path: `/api/calendar/settings${suffix}`, body: { requestKey: requestKey(), ...body }, status,
  });
  const revision = { expectedRevision: 1 };
  return {
    event: [
      { method: "POST", path: "/api/calendar/events", status: 403, body: {
        requestKey: requestKey(), eventTypeId, title: "M-1 scope check", day: "2026-11-28", timezone: "UTC",
        targets: [{ kind: "club", id: clubId }],
      } },
      named("", "PATCH", { title: "Changed title" }), named("/cancel"), named("/delete"),
      named("/sessions", "POST", { logicalSessionIds: [auxiliaryId] }),
      named("/sessions/detach", "POST", { linkIds: [auxiliaryId] }),
      named("/sessions/align"),
      named("/activities", "POST", { activityId: auxiliaryId }),
      named("/activities/detach", "POST", { activityId: auxiliaryId }),
      named("/fields", "POST", { values: [{ fieldId: detailId, value: true }] }),
      named("/questions", "POST", { kind: "rpe", window: { kind: "after_event" } }),
      named(`/questions/${auxiliaryId}/remove`),
      named(`/questions/${auxiliaryId}/move`, "POST", { window: { kind: "next_morning" } }),
    ],
    settings: [
      settings("/types", "POST", 403, { label: "M-1 type", kind: "training" }),
      settings("/types/order", "POST", 403, { typeIds: [eventTypeId] }),
      settings(`/types/${eventTypeId}`, "PATCH", 404, { ...revision, label: "Renamed type" }),
      ...["archive", "restore"].map((verb) => settings(`/types/${eventTypeId}/${verb}`, "POST", 404, revision)),
      settings("/fields", "POST", 403, { label: "M-1 detail", valueKind: "yes_no" }),
      settings(`/fields/${detailId}`, "PATCH", 404, { ...revision, label: "Renamed detail" }),
      ...["archive", "restore"].map((verb) => settings(`/fields/${detailId}/${verb}`, "POST", 404, revision)),
      settings("/locations", "POST", 403, { name: "M-1 place" }),
      settings(`/locations/${locationId}`, "PATCH", 404, { ...revision, name: "Renamed place" }),
      ...["archive", "restore"].map((verb) => settings(`/locations/${locationId}/${verb}`, "POST", 404, revision)),
      settings(`/teams/${teamId}`, "PUT", 404, { expectedRevision: 0, colorKey: "teal" }),
      settings("/questions", "PUT", 404, { enabled: true, reason: "M-1 scope check" }),
    ],
  };
}
