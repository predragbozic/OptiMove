# Owner-run procedure: the unit evidence of the ten `rest_v1` fields (C97)

**Who runs it:** the owner alone. The executor prepares this procedure and **never** sends a GPEXE request, never opens
the production database and never sees a name, an id or a value from it.

**What it proves:** the unit act of M2b (J4) for the ten seeded fields of `server3` / `rest_v1` (the nine of v34 and
the open top zone of v42) needs, by **C97**, at least two sessions and two or three athletes per session where the
field exists, several different non-zero values, and the same field, session and athlete compared between the raw
server3 answer and the GPEXE UI, with the exact factor documented and the evidence sanitized (no identity, no id).
The meaning acts need official documentation or GPEXE support's written answer (section 5). This procedure collects
the unit side and prepares the meaning questions; it confirms nothing by itself. A confirmation is a separate order
through M2b's routes, after the revision lifecycle (C91), with the evidence merged as a document with an anchor.

**Why no GPEXE request is needed for the raw side:** OptiMove already stores the server3 answer of every session a
search found, as the candidate's `raw_bundle`. The values in it are the server's own numbers, unchanged; the projection
only drops fields OptiMove does not read (`backend/src/gpexeRestV1Adapter.js`, `BUNDLE_FIELDS`). The owner reads them
with read-only SQL and compares them with what the GPEXE UI shows for the same session and athlete.

**Deadline:** a stored snapshot is kept 30 days after the last search that saw it (`RAW_RETENTION_UNAPPROVED_DAYS`,
`backend/src/gpexeImportService.js:33`; refreshed at every sighting, `:2054`). The sessions of 05.10–06.10.2026 were last
seen by the search of 2026-10-11, so their snapshots are expected to expire around **2026-11-10**. Block 1 shows the
exact date. A new search of the same dates (the owner's own decision; it is a GPEXE request) refreshes them.

---

## 1. Where and how

- The Supabase SQL Editor of the production project, one block at a time. Every block is a `SELECT`; none writes.
- The editor shows names and ids **to the owner only**. Nothing of it is copied into a chat, a ticket, a screenshot
  or a document. The result is returned in the form of section 4, numbers and booleans only.

## 2. The blocks

### Block 1 — the sessions whose snapshot can still be read

```sql
select c.id as candidate_id,
       c.session_started_at,
       c.status,
       c.raw_expires_at,
       jsonb_array_length(coalesce(c.raw_bundle -> 'athleteSessions', '[]'::jsonb)) as athlete_rows,
       ch.source_path,
       ch.source_host_key
  from training_load.gpexe_import_candidates c
  left join training_load.gpexe_import_checks ch on ch.id = c.last_seen_check_id
 where c.raw_bundle is not null
   and c.raw_expires_at > now()
 order by c.session_started_at desc
 limit 20;
```

Choose **two** sessions with `source_path = 'source_connection'` and `source_host_key = 'server3'`, preferably two
different days, each with several athletes. Call them **S1** and **S2** in everything returned.

### Block 2 — the whole-session values of up to three linked athletes of one session

Replace `:candidate_id` with the id of S1 (then run it again for S2).

```sql
with c as (
  select raw_bundle as b, owner_team_id
    from training_load.gpexe_import_candidates
   where id = :candidate_id and raw_bundle is not null
), whole as (
  select r as rw, r ->> 'athlete' as gpexe_athlete_id
    from c, jsonb_array_elements(c.b -> 'athleteSessions') r
   where r ->> 'drill' is null
), linked as (
  select w.*, coalesce(nullif(a.display_name, ''), a.full_name) as optimove_name
    from whole w
    join c on true
    join training_load.gpexe_athlete_links l
      on l.owner_team_id = c.owner_team_id and l.gpexe_athlete_id = w.gpexe_athlete_id and l.unlinked_at is null
    join public.athletes a on a.id = l.athlete_id
   where (w.rw ->> 'total_distance')::numeric > 0
   order by w.gpexe_athlete_id
   limit 3
)
select chr(64 + row_number() over (order by gpexe_athlete_id)::int) as athlete,   -- A, B, C
       optimove_name,                                                             -- for the owner's eyes only
       rw ->> 'total_time'     as total_time,
       rw ->> 'total_distance' as total_distance,
       rw ->> 'max_v'          as max_v,
       (select b -> 'more' -> (rw ->> 'id') -> 'events' from c) as events,
       (select b -> 'more' -> (rw ->> 'id') -> 'complementary_data' -> 'power' from c) as power_zones,
       (select b -> 'more' -> (rw ->> 'id') -> 'complementary_data' -> 'speed' from c) as speed_zones,
       (select b -> 'details' -> 'full' -> 'players' -> gpexe_athlete_id -> 'tot_burst_events' from c) as burst,
       (select b -> 'details' -> 'full' -> 'players' -> gpexe_athlete_id -> 'tot_brake_events' from c) as brake
  from linked;
```

### Block 3 — the team's thresholds stored with the session

```sql
select raw_bundle -> 'teamThresholds' -> 'power_thresholds'             as power_thresholds,
       raw_bundle -> 'teamThresholds' -> 'speed_thresholds'             as speed_thresholds,
       raw_bundle -> 'teamThresholds' -> 'acceleration_events_threshold' as acceleration_threshold,
       raw_bundle -> 'teamThresholds' -> 'acceleration_events_duration'  as acceleration_duration,
       raw_bundle -> 'teamThresholds' -> 'deceleration_events_threshold' as deceleration_threshold,
       raw_bundle -> 'teamThresholds' -> 'deceleration_events_duration'  as deceleration_duration
  from training_load.gpexe_import_candidates
 where id = :candidate_id and raw_bundle is not null;
```

## 3. The comparison in the GPEXE UI

For S1 and S2, open the same session in the GPEXE UI and find athletes A, B and C by name (the name block 2 showed).
For each field, write down the value the UI shows and the unit it names:

| Field (`source_metric_key`) | Block 2 / 3 column | What to read in the UI | The hypothesis to test (not yet evidence) |
|---|---|---|---|
| `athlete_session.total_time` | `total_time` | the session's duration | raw in seconds; UI minutes = raw ÷ 60 |
| `athlete_session.total_distance` | `total_distance` | total distance | raw in metres; factor 1 |
| `athlete_session.max_v` | `max_v` | maximum speed | raw in m/s; UI km/h = raw × 3.6 |
| `more.complementary_data.power.distance` | `power_zones`, each zone with an upper extreme | the distance in each closed power zone | distance in metres; the zone's `extremes` in W/kg equal the team's `power_thresholds` (block 3) and the UI's zone settings |
| `more.complementary_data.power.distance.open_top` | `power_zones`, the zone whose upper extreme is null | the distance in the top power zone | as above |
| `more.complementary_data.speed.distance` | `speed_zones` | the distance in the speed zone(s) | distance in metres; `extremes` in m/s equal `speed_thresholds` |
| `more.events.acceleration_events_count` | `events.acceleration_events_*` | the number of accelerations | a count; the threshold in m/s² and the duration in s equal the team's (block 3) and the UI's settings |
| `more.events.deceleration_events_count` | `events.deceleration_events_*` | the number of decelerations | as above, negative threshold |
| `details.players.tot_burst_events` | `burst` (`{unit, value}`) | bursts, if the UI shows them | a count; `unit: "number"` is a shape, not a unit |
| `details.players.tot_brake_events` | `brake` | brakes, if the UI shows them | as above |

A field the UI does not show for that session is written as "not shown", never guessed.

## 4. What the owner returns (numbers and booleans only)

One table per session, **S1** and **S2**, athletes **A, B, C**; no name, id, date or screenshot:

| Field | Athlete | Raw value | UI value | UI unit | UI ÷ raw | Same factor for every athlete of both sessions? |
|---|---|---|---|---|---|---|
| `athlete_session.total_time` | A | … | … | min | … | yes / no |
| … | | | | | | |

Plus, for the zone and event fields: `extremes match the team's thresholds` (yes / no) and `the UI's zone or event
settings equal block 3` (yes / no). The executor turns the returned table into the evidence document (with its anchor)
that M2b's unit act cites; the owner reviews it before it is merged.

## 5. The meaning side (not from this procedure)

The meaning act of each field needs the field's definition, and for a zone or an event field its operator and the
inclusivity of the bound, **from official documentation** (the GPEXE REST handbook, `gpexe-v.6-api-rest-handbook.pdf`)
**or GPEXE support's written answer**. Questions to put to GPEXE support, unchanged by OptiMove:

1. In `more.complementary_data.power` and `.speed`, is a zone's distance counted for samples with `lower ≤ value <
   upper`, `lower < value ≤ upper`, or otherwise? For the zone whose upper extreme is null, is it `value ≥ lower` or
   `value > lower`?
2. Is `acceleration_events_count` the number of events with acceleration `≥` or `>` `acceleration_events_threshold_value`
   for at least `acceleration_events_duration` seconds? And `deceleration_events_count` with `≤` or `<` the (negative)
   threshold?
3. What do `tot_burst_events` and `tot_brake_events` count, and with which thresholds?
4. Are `total_time` in seconds, `total_distance` and the zone distances in metres, and `max_v` in m/s on every server
   (`server3` included)?

## 6. What this procedure never does

It sends no GPEXE request (the UI view is the owner's own), writes nothing, confirms no field, changes no mapping and
does not touch the import switch.
