# C97 unit evidence: the pilot fields of `server3` / `rest_v1`

| | |
|---|---|
| Status | **Proposed.** It is evidence for the unit act only once it is merged, and it is merged only on the owner's word. |
| Covers | The **unit** of `athlete_session.total_time`, `athlete_session.total_distance` and `athlete_session.max_v` (sections 3.1–3.3), and of `details.players.tot_burst_events` and `details.players.tot_brake_events` (sections 3.4–3.5), on `server3` / `rest_v1`. |
| Does not cover | The meaning of any field (section 5), the other seeded fields, any other server. |
| Cited by | The unit act of M2b (`POST /fields/:fieldId/revisions/:revisionId/unit-verification`, discovery document J4) through the anchors of section 3. |
| Procedure | `docs/runbooks/gpexe-c97-unit-evidence-owner-procedure.md`; standard C97 (discovery document, decision 97). |
| Recorded | 2026-11-01 (sections 3.1–3.3), from the *Rukovodilac*'s report and the owner's words in its session; 2026-11-16 (sections 3.4–3.5), from the owner's own comparison as the *Rukovodilac* relays it. |

The anchors of section 3 are stable. A unit act stores its anchor for good (v34's `unit_evidence_ref`), so an anchor is
never renamed or removed. A correction is a new section with a new anchor.

<a id="owner-decision"></a>

## 1. The owner's decision: one session instead of two

C97 asks for at least two sessions with two or three athletes each. For these three fields the owner accepted one
session with thirteen athletes instead:

> „Dovoljno je. „Za C97 jedinice prihvatam jednu sesiju (190122) sa 13 sportista umesto dve.""
>
> The owner, in the *Rukovodilac*'s session, event `461a02f1`, 2026-11-01 19:50:34 UTC.

This is a deviation from C97, made by the owner. It covers the unit of these three fields only. It does not lower the
standard for any other field or for the meaning.

<a id="method"></a>

## 2. How the evidence was made

- **The session.** **S** is GPEXE session 190122 (a session id, not a person). Its snapshot is stored on production
  with an import candidate.
- **Consent.** The owner allowed the reads:
  - „Dozvoljavam read-only čitanje liste sačuvanih GPEXE sesija (broj sesije i datum, bez imena) i sirovih vrednosti
    jedne od njih radi C97 poređenja." (event `43ca9721`, 19:41:43 UTC);
  - an earlier read for another session (allowed by event `24274989`, 19:40:44 UTC) returned no row (reported as not
    stored). It is not part of this evidence.
- **The raw side.** The *Rukovodilac* read the stored snapshot (the candidate's `raw_bundle`) in a read-only
  transaction that was rolled back, without names. It read the list of stored candidates (20 sessions, all `server3`)
  and S's whole-session athlete rows: 13 athletes, `is_stats_valid` true for every one. No GPEXE request was sent: the
  values are the ones a check stored earlier.
- **The UI side.** The owner sent the *Rukovodilac* a screenshot of the same session in the GPEXE web app (the
  whole-session table, 13 rows). The screenshot is not stored in the repository.
- **Who compared.** The *Rukovodilac* compared the raw values with the screenshot and reported the result. The author
  and the reviewers of this document saw neither the raw rows nor the screenshot. The comparison cannot be repeated
  once the snapshot expires (the *Rukovodilac* reported the stored snapshots as valid until 2026-11-10 and
  2026-11-23).
- **Pairing.** The athletes were paired by distance. No names were used. The 13 distances differ from one another, so
  each UI row matches exactly one raw row.
- **What is recorded.** Labels, factors, bounds and yes / no only. No name, no athlete id and no athlete's value,
  raw or rounded. Each field has loose bounds that all 13 values lie inside. The bounds are wider than the values'
  spread on purpose, so no bound is one athlete's value. They are here only to show that a unit is plausible
  (section 3.2).

<a id="departures"></a>

### 2.1 Departures from the procedure

The procedure (`docs/runbooks/gpexe-c97-unit-evidence-owner-procedure.md`) and C97 were not followed in these points.
Each one is named here, and the owner accepts or refuses them at the merge:

| # | The procedure says | What happened | On whose word |
|---|---|---|---|
| 1 | Two sessions, two or three athletes each (C97) | One session, 13 athletes | The owner's (section 1) |
| 2 | The owner alone reads the production database | The *Rukovodilac* read it, read-only | The owner's consent, event `43ca9721` |
| 3 | Athletes A–C are found by name in the UI (section 3) | Paired by distance, no names used | The *Rukovodilac*'s method |
| 4 | No id and no screenshot is returned (section 4, C97) | The session id is recorded here. The owner's screenshot went to the *Rukovodilac*'s chat; a GPEXE session table normally shows athletes by name. | The session id on the *Rukovodilac*'s order; the owner's own words name it |
| 5 | No performance value, raw or rounded (section 4) | Loose bounds per field, not any athlete's value | The *Rukovodilac*'s order ("rasponi") |

## 3. The results

The three fields have the same yes / no answers:

| Question | Answer |
|---|---|
| The values differ between athletes | yes |
| Every value is non-zero | yes |
| The same factor holds for every athlete | yes |
| Athletes compared | 13 of 13 |

<a id="total-distance-unit"></a>

### 3.1 `athlete_session.total_distance`

| | |
|---|---|
| UI column and unit | `dist`, metres |
| Raw against UI | UI = raw for 13 of 13, to 0.1 m |
| **Source unit** | **`m`** (factor 1) |
| Bounds of the 13 raw values | between 1500 and 4000 m |

The pairing used this field, so this field shows that the 13 UI distances and the 13 raw distances are the same set
of numbers to 0.1 m. That they agree exactly, one to one, is what fixes the factor at 1. The other two fields are then
checked on the pairs it gives.

<a id="max-v-unit"></a>

### 3.2 `athlete_session.max_v`

| | |
|---|---|
| UI column and unit | `max sp`, km/h |
| Raw against UI | UI = raw × 3.6 for 13 of 13, to 0.1 km/h |
| **Source unit** | **`m/s`** (to km/h by the seeded conversion `m/s → km/h (3.6, 1, 0)`) |
| Bounds of the 13 raw values | between 5 and 10 m/s (that is 18 to 36 km/h) |

Read in km/h, these values would be a walking or jogging pace for each athlete's fastest moment of a session. Read
in m/s, they are running to sprinting speeds. That and the factor 3.6 on every athlete fix the unit.

<a id="max-v-provenance"></a>

**Where the stored `max_v` comes from (provenance).** Since PR #212 a check takes each athlete row from the session's
athlete list and fills its `max_v` from the same athlete's `max_values_speed` in the session details
(`rowsWithDetailsMaxSpeed` in `backend/src/gpexeRestV1Adapter.js`; the adapter's option `bundleMaxSpeedFromDetails` is
off by default; the check asks for it in `backend/src/gpexeImportService.js`, and
`backend/src/sourceImportCredentialResolver.js` passes it on). The first covered row of
every session (the canary) is read on its own and stored from that read, and it must equal the row built from the
details, `max_v` included. If it differs, every row of the session is read on its own. A row the details do not cover
is read on its own too. So:

- for every covered row, the number compared here is `server3`'s details `max_values_speed`, the value the importer
  stores;
- its equality with `athlete_session.max_v` is proven on one row per session by the canary. The owner-run sitting of
  2026-10-24 found 9 of 9 pairs equal, and the first production check after PR #212 found every one of its 12
  canaries equal (`docs/ai/CURRENT_STATE.md`, the check optimization).

S lies in the window 11.10.2026–24.10.2026. Three checks of that window on 2026-10-24 ran after PR #212. The first
found 10 new and 2 unchanged sessions (those 2 had been stored earlier by the old path, which read every row, and had
the same fingerprint). The next two found all 12 unchanged. If S is one of those 12 sessions, as its date suggests,
its stored content equals the details path's content, whichever check first stored it. This is inferred from the
recorded counts. It was not read.

<a id="total-time-unit"></a>

### 3.3 `athlete_session.total_time`

| | |
|---|---|
| UI column and unit | `dur`, minutes and seconds (mm:ss) |
| Raw against UI | UI minutes = raw ÷ 60 for 13 of 13, within 1 s |
| **Source unit** | **`s`** (to minutes by the seeded conversion `s → min (1, 60, 0)`) |
| Bounds of the 13 raw values | between 1500 and 3000 s (that is 25 to 50 minutes) |

The UI does not round seconds the same way every time: one value was cut to the whole second, another was rounded to
the nearest one. The difference stays under 1 s and does not change the unit.

<a id="burst-brake-method"></a>

### 3.4 and 3.5: how the burst and brake evidence was made (2026-11-16)

This evidence was made differently from sections 3.1–3.3:

- **Who compared.** The owner compared the numbers himself, on production (`54038df5`). The *Rukovodilac* relays his
  statement of 2026-11-16 from its session. The main session ran no probe, read no database and sent no GPEXE request.
  The author of this section saw neither side of the comparison.
- **The session.** One GPEXE session: the full-training session of 14.11.2026, First team, GPEXE team 980,
  `server3` / `rest_v1`, at the whole-session level. The owner's decision of section 1 (one session instead of two) is
  applied to these two fields, as the *Rukovodilac* relays it.
- **The raw side.** The mapping board's two example athletes for that session, as the board shows them (Training Load
  > Data configuration). The board showed whole numbers. GPEXE sends these fields as `{ unit: "number", value }`
  (proven on 2026-10-05 and 2026-10-09: section A of the discovery document).
- **The UI side.** The GPEXE web screen of the same session and the same two athletes.
- **What is recorded.** Yes / no answers and the factor only. No name, no athlete id, no date of birth and no
  athlete's value, raw or rounded. No bounds either: the owner gave none.

| # | C97 and the procedure say | What happened | On whose word |
|---|---|---|---|
| 6 | Two sessions, two or three athletes each | One session, two athletes | The owner's (section 1), as the *Rukovodilac* relays it |
| 7 | The owner returns sanitized answers of a procedure run | The owner's own comparison on the board and the GPEXE screen, stated in his chat | The owner's |

<a id="burst-events-unit"></a>

### 3.4 `details.players.tot_burst_events`

| | |
|---|---|
| Board label | Burst events |
| UI | the burst events of the same athletes on the GPEXE screen of the same session |
| Raw against UI | UI = raw for 2 of 2, whole numbers |
| **Source unit** | **`count`** (factor 1) |

The owner states that these are counts of events, as the acceleration and deceleration event counts are. The
answer's literal `unit: "number"` is a shape, not a unit (J17, R7); this section is what fixes the unit as `count`.

<a id="brake-events-unit"></a>

### 3.5 `details.players.tot_brake_events`

| | |
|---|---|
| Board label | Brake events |
| UI | the brake events of the same athletes on the GPEXE screen of the same session |
| Raw against UI | UI = raw for 2 of 2, whole numbers |
| **Source unit** | **`count`** (factor 1) |

The same as section 3.4: a count of events, by the owner's statement, and the literal `unit: "number"` is a shape.

<a id="unit-acts"></a>

## 4. What the unit acts would send (prepared, not done)

| Field | `sourceUnit` | `sourceBoundUnit` | `evidenceRef` |
|---|---|---|---|
| `athlete_session.total_time` | `s` | none (a plain field) | `docs/ai/gpexe-c97-unit-evidence.md#total-time-unit` |
| `athlete_session.total_distance` | `m` | none | `docs/ai/gpexe-c97-unit-evidence.md#total-distance-unit` |
| `athlete_session.max_v` | `m/s` | none | `docs/ai/gpexe-c97-unit-evidence.md#max-v-unit` |
| `details.players.tot_burst_events` | `count` | none | `docs/ai/gpexe-c97-unit-evidence.md#burst-events-unit` |
| `details.players.tot_brake_events` | `count` | none | `docs/ai/gpexe-c97-unit-evidence.md#brake-events-unit` |

Each unit equals the seed's hypothesis (`expected_source_unit` of v34). An act is the owner's: an active platform
admin in the platform workspace, in Source fields, once per field (J17 section 10.2, step 2). It needs this document
merged first (C95). It does not make a field `verified`: that also needs the meaning act (section 5).

<a id="limits"></a>

## 5. What this evidence is not

- **Not the meaning.** The meaning act needs the field's definition from official GPEXE documentation or GPEXE
  support's written answer (C97). Whether the GPEXE 6 REST handbook counts for a server that reports 9.11.x is the
  owner's decision O7 (J17 section 12.2). The owner accepted it for these three fields; the meaning evidence and the
  six acts are in `docs/ai/gpexe-c97-meaning-evidence.md`.
- **Not sessions S1 and S2.** For two more sessions (three athletes each) the owner confirmed only that the fields
  agree in meaning (time, distance, maximum speed). The owner did not compare numbers with the UI. That is not unit
  evidence, and it is not meaning evidence either.
- **Not the meaning of burst and brake.** Sections 3.4–3.5 support the unit act only. What GPEXE counts as a "burst"
  or a "brake" event (its threshold, its duration) is still unproven: no documentation or written support answer
  defines it, so no meaning act may cite this document for these two fields, and neither field becomes `verified`.
- **Not a probe.** Sections 3.4–3.5 are the owner's own comparison of two athletes in one session, relayed by the
  *Rukovodilac*. They are not a procedure run, a database read or a GPEXE request by the main session.
- **Not the other fields.** The zone fields and the acceleration / deceleration event counts have no evidence here.
- **Not another server.** It covers `server3` / `rest_v1` only.
- **Not the link gates** of J17 section 10.1, P1 (the count of non-canonical GPEXE athlete ids and the helper values
  on the *Link athletes* screen). They are separate checks.
