# C97 meaning evidence: the three pilot fields of `server3` / `rest_v1`

| | |
|---|---|
| Status | **Proposed.** It is evidence for the meaning act only once it is merged, and it is merged only on the owner's word. |
| Covers | The **meaning** of `athlete_session.total_time`, `athlete_session.total_distance` and `athlete_session.max_v` on `server3` / `rest_v1`. |
| Companion | The unit evidence of the same three fields: `docs/ai/gpexe-c97-unit-evidence.md` (merged, PR #316). |
| Source | GPEXE's REST handbook, `gpexe-v.6-api-rest-handbook.pdf`, pages 11, 37–38 and 52; the owner holds the file. |
| Cited by | The meaning act of M2b (`POST /fields/:fieldId/revisions/:revisionId/meaning-verification`, discovery document J4) through the anchors of section 3. |
| Recorded | 2026-11-01, from the pages the *Rukovodilac* read in the handbook the owner sent, and the owner's decision O7. |

The anchors of section 3 are stable. A meaning act stores its anchor for good (v34's `meaning_evidence_ref`), so an
anchor is never renamed or removed. A correction is a new section with a new anchor.

<a id="owner-decision-o7"></a>

## 1. The owner's decision O7 (question: J17 section 12.2; decision: section 12.3)

C97 asks for the meaning from official GPEXE documentation or GPEXE support's written answer. The handbook is written
for GPEXE 6, and `server3` reports 9.11.x. The owner decided that it counts for these three fields:

> „O7: prihvatam GPEXE 6 REST priručnik (str. 11, 37–38, 52) kao dokaz značenja za total_time, total_distance i max_v
> na serveru 9.11.x."
>
> The owner, in the *Rukovodilac*'s session, event `9b1f4a69`, 2026-11-01 20:10:49 UTC.

It covers these three fields and these pages only. It does not make the handbook evidence for any other field.

<a id="source"></a>

## 2. The source and how it was read

- **The handbook is not in the repository.** It is the vendor's document and is not public; the owner holds it and sent
  it to the *Rukovodilac*'s session (event `718e4a98`, 2026-11-01 20:09:43 UTC). This document quotes only the short
  passages the anchors need, with their page numbers, on the *Rukovodilac*'s instruction.
- **Who read it.** The *Rukovodilac* extracted the pages' text and reported the passages. The author of this document
  read the same extracted text in the *Rukovodilac*'s transcript; the author and the reviewers did not open the PDF.
- **No GPEXE request** was sent, and no production data is used here. The numbers quoted in section 3 are the
  vendor's sample in the handbook, not OptiMove data.

<a id="results"></a>

## 3. The meaning of each field

### 3.0 What the handbook shows (shared by the three fields)

**Page 37–38, "Athlete Session", "Key: athlete_session".** The handbook's example answer of one athlete session holds,
among other fields:

```
"datetime_intervals": "2018-11-05 11:58:07.655457|2018-11-05 12:09:34.056173",
"total_distance": 1046.08764648438,
"average_v": 1.52401887370795,
"total_time": 686.400716245221,
"max_v": 6.48525601685077
```

Two checks on that example alone (recomputed for this document):
- the interval `12:09:34.056173 − 11:58:07.655457` is **686.400716 s**, which is `total_time` to the microsecond;
- `average_v × total_time` = 1.52401887370795 × 686.400716245221 = **1046.0876464844**, which is `total_distance`
  (and `total_distance / total_time` is `average_v`).

**Page 52, "Appendix A - KPI", "Main performance indicators"**, lists among others: "• average_time, Duration",
"• total_distance, Distance", "• max_values_speed, Maximal speed".

**Page 11, "User Units", "Key: user_units".** The units the GPEXE app shows are each user's own setting
("speed: m/s, km/h, m/min", "time: s, min"). The handbook does not label the units of the page 37–38 example; only
seconds follows from it (the interval). The raw units **s, m and m/s come from the independent unit evidence**
(`docs/ai/gpexe-c97-unit-evidence.md`, PR #316), and the example is consistent with them. That the GPEXE screen showed
km/h and mm:ss while the raw values are in m/s and s fits page 11 (an inference of this document, not a handbook
sentence).

<a id="total-time-meaning"></a>

### 3.1 `athlete_session.total_time`

**Meaning:** the athlete's recorded time in the session record, in seconds (the unit from PR #316).

**Evidence:** the page 37–38 example, whose one interval (`datetime_intervals`) is as long as `total_time` to the
microsecond. *Inferred from that example; the handbook has no sentence that defines `total_time`; accepted under O7
(section 4).* Whether several intervals of one record are summed or spanned is not shown by the example. Page 52 names
a "Duration" indicator under another key (`average_time`, not this field; page 52 does not name `total_time`).

<a id="total-distance-meaning"></a>

### 3.2 `athlete_session.total_distance`

**Meaning:** the distance the athlete covered in the session record, in metres (the unit from PR #316).

**Evidence:** page 52 names `total_distance` "Distance"; on page 37–38 it equals `average_v × total_time`, so it is the
distance travelled over that interval at that average speed.

<a id="max-v-meaning"></a>

### 3.3 `athlete_session.max_v`

**Meaning:** the athlete's maximal speed in the session record, in metres per second (the unit from PR #316).

**Evidence:** page 52 names `max_values_speed` "Maximal speed"; on page 37–38 `max_v` (6.485) is greater than
`average_v` (1.524), as a maximum must be. *Inferred for `max_v` itself; the handbook has no sentence that defines
`max_v`; accepted under O7 (section 4).* The value OptiMove stores for `athlete_session.max_v` **is** the session details'
`max_values_speed` for that athlete, proven equal to the row's own `max_v` on one row of each session by the check's
canary (`docs/ai/gpexe-c97-unit-evidence.md#max-v-provenance`).

<a id="strength"></a>

## 4. How strong this evidence is

- **The handbook has no sentence that defines `total_time` or `max_v` on its own.** Their meaning rests on the page
  37–38 example (the interval arithmetic, `max_v` above `average_v`) and on the indicator names of page 52. For
  `total_distance` page 52 names the field itself.
- **One example, one interval.** The example holds a single interval, so it does not show how `total_time` treats
  several intervals of one record (summed or spanned).
- **The units are not the handbook's.** s, m and m/s come from the unit evidence (PR #316); the handbook's example is
  only consistent with them.
- **The handbook is for GPEXE 6; the server reports 9.11.x.** The owner accepted it for these three fields (O7,
  section 1). A written confirmation by GPEXE support would be stronger, and is not needed for these fields.
- **The units agree with the independent unit evidence** (PR #316: m, m/s, s from 13 athletes against the GPEXE
  screen), and with the handbook's own example.

<a id="acts"></a>

## 5. The six acts in Source fields (prepared for the owner, not done)

Before any act: both documents (`docs/ai/gpexe-c97-unit-evidence.md` and this one) are merged on `main`. The acts are
the owner's, as an **active platform admin in the platform workspace** (C94). Each act is saved once and never
changed; a mistake needs a new revision.

Where: **Training Load → Data configuration → Source fields**, the GPEXE group. Find each field by its label (seeded
as below; the key is under *Technical details* of the act's form). Each act is done on **Revision 1**, the
field's active revision. If the screen shows another revision as active, or the act's button is missing (already
confirmed), stop and report.

| # | Field (seeded label · key) | Button | What to type | Evidence (copy exactly) |
|---|---|---|---|---|
| 1 | TIME · `athlete_session.total_time` | Confirm the unit | Unit the source delivers: `s` | `docs/ai/gpexe-c97-unit-evidence.md#total-time-unit` |
| 2 | TIME · `athlete_session.total_time` | Confirm the meaning | (nothing else) | `docs/ai/gpexe-c97-meaning-evidence.md#total-time-meaning` |
| 3 | TotDist · `athlete_session.total_distance` | Confirm the unit | Unit the source delivers: `m` | `docs/ai/gpexe-c97-unit-evidence.md#total-distance-unit` |
| 4 | TotDist · `athlete_session.total_distance` | Confirm the meaning | (nothing else) | `docs/ai/gpexe-c97-meaning-evidence.md#total-distance-meaning` |
| 5 | SPEEDmax · `athlete_session.max_v` | Confirm the unit | Unit the source delivers: `m/s` | `docs/ai/gpexe-c97-unit-evidence.md#max-v-unit` |
| 6 | SPEEDmax · `athlete_session.max_v` | Confirm the meaning | (nothing else) | `docs/ai/gpexe-c97-meaning-evidence.md#max-v-meaning` |

Each time: press the button, type the unit (unit acts only), copy the evidence from the table (do not retype it),
press the form's **Confirm the unit** / **Confirm the meaning**, and compare the question it asks (the field, the
revision, the unit, the evidence) with the table row character by character; if anything differs, cancel. Only then
confirm. A wrong field, unit or anchor cannot be changed afterwards: the server checks the reference's form, not that it
belongs to the field, and a correction is a new revision. These are plain fields: the unit form has no bound unit and
the meaning form no operator. Never type a name, an id or a measured value.

The meaning acts rest on O7 (section 1): the form asks to confirm only when the document holds the field's definition
from GPEXE documentation; here that definition is the inference of section 3, which the owner accepted under O7.

**After all six:** each of the three fields shows *Unit `s` / `m` / `m/s` (confirmed)*, *Meaning confirmed*, and
*Evidence: Verified*; its *Confirmations* list shows the two confirmations on revision 1 with the evidence of the table.
If an answer is lost ("Result not confirmed"), use **Check result**, never a second act.

<a id="limits"></a>

## 6. What this evidence is not

- **Not the other seven fields** (zones, event counts, burst / brake): none is covered, and the handbook pages here
  say nothing about their operators or bounds.
- **Not another server or family:** `server3` / `rest_v1` only.
- **Not an act:** nothing here is confirmed until the owner does the acts of section 5.
