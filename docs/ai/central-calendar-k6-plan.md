# Central calendar — K6 plan: moving between teams and athletes quickly

Status: **Direction proposed to the owner** (2026-11-19, written against `main` `920459c0`). This plan contains no
code. The designer's mockups and the owner's approval come first; then a UI contract and the OptiMove manager's GO.

## 0. The owner's words (2026-11-19, in the calendar stream's chat)

| | The owner's words | Read as |
|---|---|---|
| **S1** | „u kalendaru glavnom moglo bi se filtriranje i po sportisti (slika npr sa levo desno scrolom ili strelicom za prebacivanje ili vec ne znam kako je najefikasnije) zatim isto tako u weekly programu pa ulazak u nekom sekciju čiji naziv deli više igrača da bismo olakšali treneru da veoma lako pretražuje po sportisti. Mi sada tako nesto efikasno imamo u builderu" | Filter the calendar by athlete with photos, a sideways scroll and arrows. Do the same in the Weekly plan, so that a coach steps through the athletes inside a session several of them share. Use the Builder's athlete switcher as the model. |
| **S2** | „Po timu takodje unutar kluba" | The same switcher for the teams of a club. |
| **S3** | „To već imamo vrv" | The team filter already exists in the calendar: the *Groups* chips in Filters. K6 reuses it and builds no second team control; it only brings it next to the athlete strip, so a team can be chosen in one tap. |

## 1. What exists today (`920459c0`)

- **The Builder's switcher.** The Builder already has an athlete switcher for a batch: pills with photos and
  initials, ‹ › and "1 / N" (`frontend/builder-view.js`). Since #664 it shows only the members the coach may open.
- **The calendar's read.** `GET /api/calendar` already takes `clubIds`, `teamIds` and `athleteIds`
  (`backend/src/routes/calendar.js:76-93`).
- **The calendar's team filter already exists:** the *Groups* chips in the Filters panel
  (`frontend/central-calendar-view.js`, `central-calendar-toggle-team`). What is missing is an athlete filter.
- **Opening the Weekly plan.** `openWeeklyPlanForAthleteOnDate(athleteId, date)` (`frontend/app.js`) opens one
  athlete's plan on a day. To see another athlete's plan, the coach goes back to the list. Back now returns to the
  calendar (#657).

## 2. The proposal: one switcher, used in three places

The switcher has the Builder's look: photo pills, ‹ ›, "3 / 18", and a search field for large squads. It never lists
anyone the coach may not see in the workspace.

- **K6-1, the calendar** (frontend only).
  - In a club workspace the **existing Groups (team) choice** comes first, moved next to the strip so it takes one
    tap (S2, S3). It is not a second team control.
  - Under it is the **athlete** strip of the chosen team (S1), starting with "All".
  - Choosing an athlete reads the calendar with `athleteIds`. One tap moves to the next or previous athlete.
  - It combines with K5's *Show only* (for example only GPS, for one athlete).
- **K6-2, the Weekly plan** (frontend only).
  - The plan's header carries the switcher: "‹ Ana K. ›", with the athletes of her team.
  - Moving to another athlete keeps the same week, the same day and the same open session (S1: "ulazak u neku sekciju
    čiji naziv deli više igrača"). So the coach sees "Monday · Training · Main session" for each athlete in turn.
  - In a club workspace the team row is there too (S2).
- **K6-3, from an event through its athletes** (frontend only).
  - The event's panel gets **See each athlete**. It opens the Weekly plan on that day and session, with the switcher
    holding only the event's athletes.
  - Back, or *Back to calendar*, returns to the event (K4-0).

## 3. Rules

- **Who appears.** The lists come from what the workspace already shows the coach: the roster and the calendar's
  teams. Nothing new is read about athletes the coach may not see. A team coach sees no team row.
- **No migration and no new backend** is expected. The contract confirms it, and names any small read the switcher
  needs.
- **The look and the controls** are shared with the Builder's switcher, so it is one component, not three copies.
- **Phones.** A sideways scroll, 44 px targets, the chosen pill kept in view, and arrows always visible.

## 4. Order

K6 comes after K5. The designer makes mockups of K6-1 to K6-3, at 390 and 1280 px, and the owner approves them. Then
the UI contract and the manager's GO, then the code. The reviews are `code-reviewer`, `mobile-qa` and
`ux-design-reviewer`, plus a browser check and the Frontend PR gate.
