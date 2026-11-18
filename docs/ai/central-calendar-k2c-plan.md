# Central calendar — K2c plan: the calendar and the Builder, one click apart

Status: **K2c-1 has the manager's GO (2026-11-18)**; K2c-2 is planned; K3 is named only. The owner: „Radi redosledom koji
je optimalan" (2026-11-18). Written against `main` `9351bcc0` plus PR #611's head `88b60dde` (K2b-1d3), on which this
branch is stacked because both change the calendar's panel.

## 0. What exists (K2a-1b, merged and deployed)

- The routes, all through the calendar's runner with a `requestKey` (`backend/src/routes/calendarEvents.js:44-48`;
  contract `docs/ai/central-calendar-k2a-plan.md` sections 2 and 4.2):
  - `POST /api/calendar/events/:eventId/sessions` (attach a planned group: a day and its Builder slot);
  - `…/sessions/detach`;
  - `…/sessions/align` (the linked sessions' RPE and Training Load switches follow the event's `expects`);
  - `POST …/activities` and `…/activities/detach`.
- The read already folds a linked planned group into its event (the K1 batch card disappears into the event), and
  reports orphaned links.
- **No screen calls them.** The panel's code names the buttons ("Attach a training", "Attach an activity",
  `central-calendar-view.js`, `renderEventActionsHtml`), but they were never built. The Builder has no calendar action.

## 1. K2c-1 — link in one click from the calendar (frontend only, no migration)

- **The event's panel** (a manager, a planned event):
  - **Suggested trainings:** the planned cards of the event's days whose athletes the event reaches and that are not
    linked yet. They are already in the calendar's answer; nothing new is read from the server. Each has a **Link**
    button that sends one attach.
  - **Linked trainings:** each with **Unlink**. An orphaned link (its Builder session is gone) shows one plain sentence
    and *Unlink*.
  - **Align:** when the event expects RPE and a linked training does not ask for it (or the reverse), one button,
    *Ask RPE in the linked trainings*. It is the align route; nothing changes silently.
  - **Activities:** the same pattern for the day's recorded activities that are not linked, with *Link* and *Unlink*.
- **A planned card's panel** (a manager): *Link to an event*, listing the planned events of that day that reach its
  athletes, each with **Link**. When there is exactly one, it is the primary button.
- **Every write:**
  - a `requestKey`;
  - one control at a time;
  - *Result not confirmed* · *Check result* with the same key after a lost answer;
  - the calendar re-read after a confirmed write;
  - every refusal code as one plain English sentence (no codes or ids for a coach).
- **The Interaction principles** of `.claude/rules/frontend.md`:
  - an explicit confirmation only where a write cannot be reversed by the same person (Unlink reverses Link, so
    neither asks "Are you sure?");
  - 44 px targets;
  - 360 / 375 / 390 px.
- **Not in K2c-1:** the Builder side (K2c-2), and the questions' interplay of K2b-2a-1 (its `rpe_already_answered` refusal
  gets its sentence when K2b-2a-1 is merged).
- **Phases:**
  1. The executor writes the UI contract as section 1.1: the exact panels, the suggestion rule against the read's
     fields, the codes with their sentences, the states, and the test plan.
  2. The manager gives a GO.
  3. The code.
- **Reviews:** `code-reviewer`, `ux-design-reviewer` (a new coach flow), `mobile-qa`, then the fresh independent
  review, then the OptiMove manager's gate.

## 2. K2c-2 — "Make an event" from the Builder (planned)

A button in the Builder's session editor creates the calendar event of that session (its type, day, time and targets
from the session) and links the session in one request (the create route with `sessions`, K2a plan 2.1 (b')). A plan
first, after K2c-1 is in use.

## 3. K3 — "New training" from an event (named only)

It opens the Builder for the event's athletes and week (K2a plan 2.1 (c)). It needs the Builder's week model and a
return context, so it gets its own plan with the Builder.

## 4. The manager's GO for K2c-1 (2026-11-18)

GO as section 1 says, two phases. The UI contract (1.1) gets a GO before any code.
