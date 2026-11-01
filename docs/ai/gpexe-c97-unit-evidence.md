# C97 unit evidence: the three pilot fields of `server3` / `rest_v1`

| | |
|---|---|
| Status | **Proposed.** It is evidence for the unit act only once it is merged, and it is merged only on the owner's word. |
| Covers | The **unit** of `athlete_session.total_time`, `athlete_session.total_distance` and `athlete_session.max_v` on `server3` / `rest_v1`. |
| Does not cover | The meaning of any field (section 5), the other seven seeded fields, any other server. |
| Cited by | The unit act of M2b (`POST /fields/:fieldId/revisions/:revisionId/unit-verification`, discovery document J4) through the anchors of section 3. |
| Procedure | `docs/runbooks/gpexe-c97-unit-evidence-owner-procedure.md`; standard C97 (discovery document, decision 97). |
| Recorded | 2026-11-01, from the *Rukovodilac*'s report and the owner's words in its session. |

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

<a id="unit-acts"></a>

## 4. What the unit acts would send (prepared, not done)

| Field | `sourceUnit` | `sourceBoundUnit` | `evidenceRef` |
|---|---|---|---|
| `athlete_session.total_time` | `s` | none (a plain field) | `docs/ai/gpexe-c97-unit-evidence.md#total-time-unit` |
| `athlete_session.total_distance` | `m` | none | `docs/ai/gpexe-c97-unit-evidence.md#total-distance-unit` |
| `athlete_session.max_v` | `m/s` | none | `docs/ai/gpexe-c97-unit-evidence.md#max-v-unit` |

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
- **Not the other seven fields.** The zone fields, the event counts and burst / brake have no evidence here.
- **Not another server.** It covers `server3` / `rest_v1` only.
- **Not the link gates** of J17 section 10.1, P1 (the count of non-canonical GPEXE athlete ids and the helper values
  on the *Link athletes* screen). They are separate checks.
