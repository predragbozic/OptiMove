// Synthetic, anonymized GPEXE bundle fixtures shared by the GPEXE test
// suites. They keep the exact shape of real GPEXE v6 responses (team 980,
// session 186942): naive UTC timestamps, SI numeric fields, whole-session rows
// with drill=null and drill rows with drill=n, /more/ zones and events, team
// thresholds, details with burst/brake counts.
export const TZ = "Europe/Sarajevo";
const ZONE_BOUNDS = { power: [[null, 20], [20, 25], [25, 60], [60, 75], [75, null]], speed: [[null, 5.5], [5.5, 7], [7, null]] };

function naive(date) {
  return date.toISOString().replace("Z", "");
}

export function defaultThresholds(gpexeTeamId) {
  return {
    id: 1473, team: gpexeTeamId, validity_start: "2025-01-01T00:00:00", validity_end: null,
    power_thresholds: [20, 25, 60, 75], speed_thresholds: [5.5, 7],
    acceleration_events_threshold: 2.5, acceleration_events_duration: 0.3,
    deceleration_events_threshold: -2.5, deceleration_events_duration: 0.3,
  };
}

function moreFor(row, { powerZoneDistances, speedZoneDistances, acc, dec, powerBounds = ZONE_BOUNDS.power, accThreshold = 2.5 }) {
  const zones = (bounds, distances) => bounds.map((extremes, i) => ({ extremes, distance: distances[i], is_ready: true, show_distance: true }));
  return {
    track_id: row.track,
    athletesession_id: row.id,
    complementary_data: { power: zones(powerBounds, powerZoneDistances), speed: zones(ZONE_BOUNDS.speed, speedZoneDistances) },
    events: {
      acceleration_events_threshold_value: accThreshold, acceleration_events_duration: 0.3, acceleration_events_count: String(acc),
      deceleration_events_threshold_value: -2.5, deceleration_events_duration: 0.3, deceleration_events_count: String(dec),
    },
  };
}

// parts: [{ drill: null|n, time, distance, maxV, power: [5 zone distances], sprint, acc, dec, burst, brake }]
// details are "fetched" for the whole session and for the drill indexes in detailsDrills.
export function makeBundle({
  sessionId = 5001, gpexeTeamId = 77, start = "2026-09-14T18:08:12", updatedOn = "2026-09-14T20:18:09.337", category = "FULL TRAINING",
  drillsCount = 2, athletes, trackTimestampOffsetMs = 0, powerBounds, accThreshold, thresholds, detailsDrills = [0],
}) {
  const athleteSessions = [];
  const more = {};
  const tracks = {};
  const details = { full: { players: {} }, drills: Object.fromEntries(detailsDrills.map((n) => [String(n), { players: {} }])) };
  let nextRowId = sessionId * 100;
  for (const athlete of athletes) {
    for (const trackId of athlete.tracks) {
      const trackStart = new Date(new Date(`${start}Z`).getTime() - 600_000);
      tracks[String(trackId)] = { id: trackId, athlete: athlete.id, timezone: TZ, timestamp: naive(trackStart), utc_timestamp: (trackStart.getTime() + trackTimestampOffsetMs) / 1000 };
    }
    for (const part of athlete.parts) {
      nextRowId += 1;
      const row = {
        id: nextRowId, athlete: athlete.id, track: part.track ?? athlete.tracks[0], teamsession: sessionId, drill: part.drill,
        is_stats_valid: true, total_time: part.time, total_distance: part.distance, max_v: part.maxV,
      };
      athleteSessions.push(row);
      const sprint = part.sprint ?? 0;
      more[String(row.id)] = moreFor(row, { powerZoneDistances: part.power, speedZoneDistances: [part.distance - 8 - sprint, 8, sprint], acc: part.acc, dec: part.dec, powerBounds, accThreshold });
      const target = part.drill === null ? details.full : details.drills[String(part.drill)];
      if (target) target.players[String(athlete.id)] = { tot_burst_events: { unit: "number", value: part.burst ?? 0 }, tot_brake_events: { unit: "number", value: part.brake ?? 0 } };
    }
  }
  return {
    teamSession: {
      id: sessionId, team: gpexeTeamId, category_name: category, is_stats_valid: true, drills_count: drillsCount,
      start_timestamp: start, end_timestamp: "2026-09-14T19:19:35", updated_on: updatedOn,
    },
    athleteSessions, more, tracks, details,
    teamThresholds: thresholds ?? defaultThresholds(gpexeTeamId),
  };
}

export function standardAthletes() {
  return [
    {
      id: 101, tracks: [9001],
      parts: [
        { drill: null, time: 2400, distance: 3000, maxV: 7.5, power: [2400, 200, 300, 60, 40], sprint: 12, acc: 20, dec: 18, burst: 9, brake: 7 },
        { drill: 0, time: 1200, distance: 1600, maxV: 7.5, power: [1300, 100, 150, 30, 20], sprint: 12, acc: 12, dec: 8, burst: 5, brake: 4 },
        { drill: 1, time: 1200, distance: 1400, maxV: 6.0, power: [1100, 100, 150, 30, 20], sprint: 0, acc: 8, dec: 10, burst: 4, brake: 3 },
      ],
    },
    {
      id: 102, tracks: [9002],
      parts: [
        { drill: null, time: 1200, distance: 1500, maxV: 6.2, power: [1300, 100, 80, 15, 5], sprint: 0, acc: 6, dec: 7, burst: 2, brake: 2 },
        { drill: 0, time: 1200, distance: 1500, maxV: 6.2, power: [1300, 100, 80, 15, 5], sprint: 0, acc: 6, dec: 7, burst: 2, brake: 2 },
      ],
    },
    {
      // Device restart: two tracks for one athlete in the same session.
      id: 103, tracks: [9003, 9004],
      parts: [
        { drill: null, track: 9003, time: 600, distance: 700, maxV: 5, power: [600, 50, 40, 10, 0], acc: 2, dec: 2 },
        { drill: null, track: 9004, time: 900, distance: 1000, maxV: 5, power: [900, 50, 40, 10, 0], acc: 3, dec: 3 },
      ],
    },
  ];
}
