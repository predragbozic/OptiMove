// K2b-2a-3: the athlete's side of *Ask athletes* (docs/ai/central-calendar-k2b2a3-ui-contract.md, the GO in section
// 12). Through the real loader (athlete-questions-data.js), the real handlers (athlete-questions-actions.js) and the real
// templates (athlete-questions-view.js, athlete-home.js), in a JSDOM page, with a fake server that keeps the routes'
// contracts (backend/src/calendarQuestionService.js): GET /api/calendar/questions/mine lists only her questions whose
// window is open now and that she has not answered ([] while the fake's switch is off or for a coach), and
// POST …/later answers 404 for a question that is not hers, 409 question_not_open for one that is not open, and the
// saved answer for a replay of the same key.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

const data = await import("../athlete-questions-data.js");
const actions = await import("../athlete-questions-actions.js");
const { renderAthleteHomeHtml } = await import("../athlete-home.js");
const { emptyTrainingLoadState, state } = await import("../state.js");

const {
  ATHLETE_QUESTION_ROW_KEYS, athleteQuestionsAnswered, athleteQuestionsTick, loadAthleteQuestions, resetAthleteQuestions, setAthleteQuestionsClock,
} = data;
const {
  ATHLETE_QUESTION_CLOSED, ATHLETE_QUESTION_NOT_OPEN, ATHLETE_QUESTION_NOT_OPENED, ATHLETE_QUESTION_UNREACHABLE, athleteQuestionsBack, athleteQuestionsPromptOpen, beginAthleteHomeLoad,
  closeAthleteQuestionsPrompt, handleAthleteQuestionsAction, handleAthleteQuestionsKeydown, maybeShowAthleteQuestionsPrompt, openCalendarQuestion,
  setAthleteQuestionsPromptHandlers,
} = actions;

after(() => restoreFetch());

// 17:30 on Wednesday 18 Nov 2026, the device's time.
const NOW = new Date(2026, 10, 18, 17, 30).getTime();
const at = (h, m = 0, dayOffset = 0) => new Date(2026, 10, 18 + dayOffset, h, m).toISOString();
const ATHLETE = { id: "u-athlete", activeWorkspace: { type: "athlete", scopeId: null } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let now = NOW;

// One question as the server keeps it (more than the route returns: `answered` and the fake's own bookkeeping).
function question({ id, kind = "rpe", title = "Training", day = "2026-11-18", start = "16:00", opens = at(17), closes = at(23, 59), later = false, answered = false, formId = null, extra = {} }) {
  return { id, kind, title, day, start, opens, closes, later, answered, formId: formId || `asg-${id}`, extra };
}

// The fake server. `world.switchOn` false or `world.athlete` false: [] (the route's rule).
let world;
function server({ failMine = null, later = null } = {}) {
  return installFetchMock(async (call) => {
    const url = String(call.url);
    if (url === "/api/calendar/questions/mine") {
      if (failMine) return failMine(call);
      if (!world.switchOn || !world.athlete) return { status: 200, body: { questions: [] } };
      const open = world.questions.filter((q) => !q.answered && Date.parse(q.opens) <= now && now <= Date.parse(q.closes));
      return {
        status: 200,
        body: {
          questions: open.map((q) => ({
            questionId: q.id, kind: q.kind, eventId: `event-of-${q.id}`, eventTitle: q.title, eventDay: q.day, eventStart: q.start,
            window: { opensAt: q.opens, closesAt: q.closes },
            form: q.kind === "rpe" ? { kind: "rpe", externalAssignmentId: q.formId } : { kind: "wellness", assignmentId: q.formId },
            later: q.later, ...q.extra,
          })),
        },
      };
    }
    const m = url.match(/^\/api\/calendar\/questions\/([^/]+)\/later$/);
    if (m && call.method === "POST") {
      if (later) return later(call, m[1]);
      const prior = world.keys.get(call.body?.requestKey);
      if (prior) return { status: 200, body: { postponement: { questionId: prior, at: at(17, 31) }, replayed: true } };
      const q = world.questions.find((x) => x.id === decodeURIComponent(m[1]));
      if (!q || !world.switchOn) return { status: 404, body: { error: "notFound" } };
      if (q.answered || now > Date.parse(q.closes) || now < Date.parse(q.opens)) return { status: 409, body: { error: "question_not_open", message: "This question is not open now." } };
      q.later = true;
      world.keys.set(call.body.requestKey, q.id);
      return { status: 200, body: { postponement: { questionId: q.id, at: at(17, 31) } } };
    }
    if (url.startsWith("/api/app-errors")) return { status: 200, body: {} };
    return { status: 404, body: { error: "notFound" } };
  });
}
const mineCalls = (calls) => calls.filter((c) => c.url === "/api/calendar/questions/mine");
const laterCalls = (calls) => calls.filter((c) => /\/later$/.test(String(c.url)));

// The page: Home painted into #content, as app.js's renderAthleteHomeFromCache does.
let dom;
let renders = 0;
const HOME_DATA = { athlete: { name: "Ana" }, today: { date: "2026-11-18" }, week: { days: [] }, wellness: { count: 0 } };
let homeData = HOME_DATA;
function render() {
  renders += 1;
  dom.window.document.getElementById("content").innerHTML = renderAthleteHomeHtml({ data: homeData, error: "" });
}
const $ = (sel) => dom.window.document.querySelector(sel);
const $$ = (sel) => [...dom.window.document.querySelectorAll(sel)];
const doc = () => dom.window.document;
const prompt = () => $("#athleteQuestionsPromptHost [role='dialog']");
const card = () => $("section.athlete-questions-card");
const key = (k, opts = {}) => new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts });

// Home's entry: the read, Home painted, then the prompt check (app.js loadAthleteHome).
async function enterHome({ deepLink = false, athleteMode = true } = {}) {
  const load = beginAthleteHomeLoad();
  await loadAthleteQuestions({ render });
  render();
  return maybeShowAthleteQuestionsPrompt({ doc: doc(), athleteMode, deepLink, load });
}

let opened;
const handlers = (extra = {}) => ({
  openRpe: async (id) => { opened.push(["rpe", id]); },
  openWellness: async (id) => { opened.push(["wellness", id]); },
  rpeFormOpenFor: () => true,
  render,
  reload: () => loadAthleteQuestions({ render }),
  loadHome: () => enterHome({ deepLink: true }),
  ...extra,
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  closeAthleteQuestionsPrompt();
  resetAthleteQuestions();
  now = NOW;
  setAthleteQuestionsClock(() => now);
  state.currentUser = ATHLETE;
  state.activeTab = "athlete-home";
  state.trainingLoad = emptyTrainingLoadState();
  state.tests.form = null;
  state.notifications.open = false;
  state.athleteExitConfirmOpen = false;
  homeData = HOME_DATA;
  world = { switchOn: true, athlete: true, questions: [], keys: new Map() };
  // As athlete.html: the media viewer and the exit question are always on the page, hidden, each with an aria-modal dialog.
  dom = new JSDOM(`<!doctype html><body><main id="content"></main>
    <div class="media-modal" id="mediaModal" hidden><div class="media-dialog" role="dialog" aria-modal="true" aria-label="Exercise media"></div></div>
    <div class="exit-confirm-modal" id="exitConfirmModal" hidden><div class="exit-confirm-dialog" role="alertdialog" aria-modal="true"></div></div></body>`);
  globalThis.document = dom.window.document;
  renders = 0;
  opened = [];
});

// ---------------------------------------------------------------------------
// The read and the pick
// ---------------------------------------------------------------------------
test("Q1. one GET /questions/mine per Home entry; the pick is the literal key list; no id, code or extra field is ever text", async () => {
  world.questions = [question({ id: "q-1", extra: { secretField: "hidden-thing-42" } })];
  const calls = server();
  await enterHome();
  assert.equal(mineCalls(calls).length, 1);
  assert.equal(mineCalls(calls)[0].method, "GET");
  const literal = ["questionId", "kind", "eventTitle", "eventDay", "eventStart", "opensAt", "closesAt", "formKind", "formId", "later"];
  assert.deepEqual([...ATHLETE_QUESTION_ROW_KEYS], literal);
  assert.deepEqual(Object.keys(state.athleteQuestions.rows[0]), literal);
  const visible = [doc().body.textContent, ...$$("[aria-label]").map((el) => el.getAttribute("aria-label")), ...$$("[title]").map((el) => el.getAttribute("title"))].join(" ");
  for (const word of ["q-1", "asg-q-1", "event-of-q-1", "hidden-thing-42", "rpe", "question_not_open", "notFound"]) {
    assert.equal(visible.includes(word), false, `"${word}" must not be visible text`);
  }
  assert.equal(doc().body.innerHTML.includes("event-of-q-1"), false, "the event id is not kept at all");
  assert.equal(doc().body.innerHTML.includes("hidden-thing-42"), false);
});

test("Q2. two reads at once share one request; a late answer after a reset (a workspace switch) is dropped", async () => {
  world.questions = [question({ id: "q-1" })];
  const gate = deferred();
  let first = true;
  const calls = server({ failMine: async () => { if (first) { first = false; await gate.promise; } return { status: 200, body: { questions: [] } }; } });
  const a = loadAthleteQuestions({ render });
  const b = loadAthleteQuestions({ render });
  assert.equal(a, b);
  resetAthleteQuestions();
  gate.resolve();
  await a;
  assert.equal(mineCalls(calls).length, 1);
  assert.equal(state.athleteQuestions.status, "idle", "the old context's answer never lands");
});

test("Q3. a failed read hides everything: no prompt, no card, no error line, no retry", async () => {
  world.questions = [question({ id: "q-1" })];
  server({ failMine: () => ({ status: 500, body: { error: "internal_error", message: "The questions could not be read." } }) });
  assert.equal(await enterHome(), false);
  assert.equal(prompt(), null);
  assert.equal(card(), null);
  assert.equal(doc().body.textContent.includes("could not"), false);
  assert.equal(state.athleteQuestions.status, "hidden");
});

// ---------------------------------------------------------------------------
// The prompt: when it shows
// ---------------------------------------------------------------------------
test("Q4. one open question: the prompt over Home - aria-modal, its title and lines, Answer now focused, Later beside it", async () => {
  world.questions = [question({ id: "q-1", title: "Training", start: "16:00" })];
  server();
  assert.equal(await enterHome(), true);
  const dialog = prompt();
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(doc().getElementById(dialog.getAttribute("aria-labelledby")).textContent, "Your coach has a question");
  assert.equal(doc().getElementById(dialog.getAttribute("aria-describedby")).textContent, "How hard was it?");
  assert.match(dialog.textContent, /Training · Today 16:00/);
  assert.match(dialog.textContent, /Answer by 23:59 today\./);
  assert.equal(doc().activeElement.textContent, "Answer now");
  assert.deepEqual($$("#athleteQuestionsPromptHost button").map((b) => b.textContent), ["Answer now", "Later"]);
  assert.ok(doc().body.classList.contains("athlete-questions-prompt-open"));
  // The prompt is outside Home's content: a repaint of Home does not touch it.
  render();
  assert.ok(prompt());
});

test("Q5. no prompt: later from the server, no open question, a coach / the switch off, not on Home, a deep link, not the athlete mode", async () => {
  world.questions = [question({ id: "q-1", later: true })];
  server();
  assert.equal(await enterHome(), false, "later: true never prompts");
  assert.ok(card(), "…but the card lists it");
  world.questions = [];
  assert.equal(await enterHome(), false);
  world.questions = [question({ id: "q-2" })];
  world.athlete = false;
  assert.equal(await enterHome(), false, "a coach reads []");
  world.athlete = true;
  world.switchOn = false;
  assert.equal(await enterHome(), false, "switch off: []");
  world.switchOn = true;
  assert.equal(await enterHome({ deepLink: true }), false, "never after a deep link");
  assert.equal(await enterHome({ athleteMode: false }), false);
  state.activeTab = "tests";
  assert.equal(await enterHome(), false, "only on Home");
  state.activeTab = "athlete-home";
  assert.equal(await enterHome(), true, "q-2 was never prompted, so it is now");
});

test("Q6. nothing on top: an RPE form, a Training Load overlay, a Tests form, the notification panel, the exit question, another modal dialog", async () => {
  world.questions = [question({ id: "q-1" })];
  server();
  const blockers = [
    () => { state.trainingLoad.rpeForm = { externalAssignmentId: "x" }; },
    () => { state.trainingLoad.athleteWeeklyOpen = true; },
    () => { state.trainingLoad.showSessionList = true; },
    () => { state.tests.form = { assignmentId: "y" }; },
    () => { state.notifications.open = true; },
    () => { state.athleteExitConfirmOpen = true; },
    () => { doc().body.insertAdjacentHTML("beforeend", `<div id="other" role="dialog" aria-modal="true"></div>`); },
    () => { doc().getElementById("mediaModal").hidden = false; },
    () => { doc().getElementById("exitConfirmModal").hidden = false; },
  ];
  for (const block of blockers) {
    state.trainingLoad = emptyTrainingLoadState();
    state.tests.form = null;
    state.notifications.open = false;
    state.athleteExitConfirmOpen = false;
    doc().getElementById("other")?.remove();
    doc().getElementById("mediaModal").hidden = true;
    doc().getElementById("exitConfirmModal").hidden = true;
    block();
    assert.equal(await enterHome(), false);
    assert.equal(prompt(), null);
  }
  state.trainingLoad = emptyTrainingLoadState();
  state.tests.form = null;
  state.notifications.open = false;
  state.athleteExitConfirmOpen = false;
  doc().getElementById("other")?.remove();
  doc().getElementById("mediaModal").hidden = true;
  doc().getElementById("exitConfirmModal").hidden = true;
  assert.equal(await enterHome(), true, "with nothing on top it shows (the hidden media viewer and exit question are not on top)");
});

test("Q7. once per question per app session: closed by Answer, then not again; a reset (a new session) prompts again; a window that opens later prompts once at the next Home", async () => {
  world.questions = [question({ id: "q-1" }), question({ id: "q-late", kind: "wellness", opens: at(18), closes: at(23) })];
  server();
  assert.equal(await enterHome(), true);
  await handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-answer", questionId: "q-1" }), handlers());
  assert.equal(athleteQuestionsPromptOpen(), false);
  assert.equal(await enterHome(), false, "q-1 is not prompted twice");
  now = new Date(2026, 10, 18, 18, 5).getTime();
  assert.equal(await enterHome(), true, "q-late opened meanwhile: prompted once");
  assert.match(prompt().textContent, /How are you feeling\?/);
  assert.doesNotMatch(prompt().textContent, /How hard was it\?/);
  closeAthleteQuestionsPrompt();
  assert.equal(await enterHome(), false);
  resetAthleteQuestions();
  assert.equal(await enterHome(), true, "a new app session prompts the unanswered ones again");
});

// ---------------------------------------------------------------------------
// Later
// ---------------------------------------------------------------------------
test("Q8. Later: the prompt closes before the server answers; one POST with a fresh uuid key; then one read; never prompted again", async () => {
  world.questions = [question({ id: "q-1" })];
  const gate = deferred();
  const calls = server({ later: async (call, id) => { await gate.promise; world.questions[0].later = true; return { status: 200, body: { postponement: { questionId: id, at: at(17, 31) } } }; } });
  await enterHome();
  const pending = handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-later" }), handlers());
  await settle();
  assert.equal(prompt(), null, "closed at once");
  assert.equal(doc().activeElement?.id, "athleteQuestionsTitle", "focus to the card's title");
  assert.equal(laterCalls(calls).length, 1);
  assert.match(laterCalls(calls)[0].body.requestKey, UUID);
  assert.equal(laterCalls(calls)[0].url, "/api/calendar/questions/q-1/later");
  const readsBefore = mineCalls(calls).length;
  gate.resolve();
  await pending;
  await settle();
  assert.equal(mineCalls(calls).length, readsBefore + 1, "read again after the 200");
  assert.equal(state.athleteQuestions.rows[0].later, true);
  assert.ok(card(), "the card still lists it");
  assert.equal(doc().activeElement?.id, "athleteQuestionsTitle", "the read's repaint of Home gives the focus back to the card's title");
  assert.equal(await enterHome(), false);
});

test("Q9. Escape = Later; the backdrop too; Tab and Shift+Tab stay inside the sheet", async () => {
  world.questions = [question({ id: "q-1" })];
  const calls = server();
  await enterHome();
  const [answer, later] = $$("#athleteQuestionsPromptHost button");
  later.focus();
  const tab = key("Tab");
  assert.equal(handleAthleteQuestionsKeydown(tab, handlers()), true);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(doc().activeElement, answer, "Tab from the last goes to the first");
  assert.equal(handleAthleteQuestionsKeydown(key("Tab", { shiftKey: true }), handlers()), true);
  assert.equal(doc().activeElement, later, "Shift+Tab from the first goes to the last");
  const esc = key("Escape");
  assert.equal(handleAthleteQuestionsKeydown(esc, handlers()), true);
  assert.equal(esc.defaultPrevented, true);
  assert.equal(prompt(), null);
  await settle();
  await settle();
  assert.equal(laterCalls(calls).length, 1, "Escape sent the Later");
  assert.equal(handleAthleteQuestionsKeydown(key("Escape"), handlers()), false, "closed: Escape is not ours any more");
  // The backdrop.
  resetAthleteQuestions();
  world.questions = [question({ id: "q-2" })];
  await enterHome();
  assert.equal($(".athlete-questions-backdrop").getAttribute("data-action"), "athlete-questions-later");
  await handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-later" }), handlers());
  assert.equal(prompt(), null);
  assert.equal(laterCalls(calls).at(-1).url, "/api/calendar/questions/q-2/later");
});

test("Q10. several questions: one sheet, one Answer per row, one Later for all - one POST each with distinct keys; over three rows: 'and N more on Home'", async () => {
  world.questions = [
    question({ id: "q-1", closes: at(23, 59) }),
    question({ id: "q-2", kind: "wellness", closes: at(22) }),
  ];
  const calls = server();
  await enterHome();
  assert.equal($("#athleteQuestionsPromptTitle").textContent, "Your coach has 2 questions");
  const answers = $$("#athleteQuestionsPromptHost [data-action='athlete-questions-answer']");
  assert.deepEqual(answers.map((b) => b.getAttribute("data-question-id")), ["q-2", "q-1"], "earliest closing first");
  assert.deepEqual(answers.map((b) => b.textContent), ["Answer", "Answer"]);
  assert.equal(doc().activeElement, answers[0]);
  await handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-later" }), handlers());
  const posts = laterCalls(calls);
  assert.deepEqual(posts.map((c) => c.url), ["/api/calendar/questions/q-2/later", "/api/calendar/questions/q-1/later"]);
  assert.notEqual(posts[0].body.requestKey, posts[1].body.requestKey);
  // Four questions: three rows, the fourth on Home.
  resetAthleteQuestions();
  world.questions = ["a", "b", "c", "d"].map((id, i) => question({ id: `m-${id}`, closes: at(20 + i) }));
  await enterHome();
  assert.equal($$("#athleteQuestionsPromptHost li").length, 3);
  assert.match(prompt().textContent, /and 1 more on Home/);
  const before = laterCalls(calls).length;
  await handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-later" }), handlers());
  assert.equal(laterCalls(calls).length - before, 3, "Later for the three shown");
});

test("Q11. Later refused: 404 or question_not_open drop the row quietly and read again; try_again, 503, a 5xx or no answer count as done - no error, no second POST, no read", async () => {
  const cases = [
    { answer: { status: 404, body: { error: "notFound" } }, dropped: true },
    { answer: { status: 409, body: { error: "question_not_open", message: "This question is not open now." } }, dropped: true },
    { answer: { status: 409, body: { error: "try_again", message: "Try again in a moment." } }, dropped: false },
    { answer: { status: 503, body: { error: "outcome_unknown", message: "not confirmed" } }, dropped: false },
    { answer: { status: 500, body: { error: "internal_error", message: "Nothing was saved." } }, dropped: false },
    { answer: { throwNetworkError: true }, dropped: false },
  ];
  for (const c of cases) {
    resetAthleteQuestions();
    world.questions = [question({ id: "q-1" })];
    const calls = server({ later: () => c.answer });
    await enterHome();
    const readsBefore = mineCalls(calls).length;
    await handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-later" }), handlers());
    await settle();
    assert.equal(laterCalls(calls).length, 1, `one POST for ${c.answer.status ?? "no answer"}`);
    if (c.dropped) {
      assert.equal(mineCalls(calls).length, readsBefore + 1, "read again");
    } else {
      assert.equal(mineCalls(calls).length, readsBefore, "no read");
      assert.equal(state.athleteQuestions.rows[0].later, true, "kept, as done locally");
    }
    assert.equal(prompt(), null);
    assert.equal(/not open|try again|not confirmed|Nothing was saved|error/i.test(doc().body.textContent), false, "never an error line");
    assert.equal(await enterHome(), false, "not prompted again in this session");
  }
});

test("Q11b. a Later refused (404 or question_not_open) that lands after a reset (a workspace switch) touches nothing of the new context and reads nothing", async () => {
  for (const refusal of [{ status: 404, body: { error: "notFound" } }, { status: 409, body: { error: "question_not_open", message: "x" } }]) {
    resetAthleteQuestions();
    world.questions = [question({ id: "q-1" })];
    const gate = deferred();
    const calls = server({ later: async () => { await gate.promise; return refusal; } });
    await enterHome();
    const later = handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-later" }), handlers());
    await settle();
    // The switch: a new context whose list holds a row of the same id.
    resetAthleteQuestions();
    await loadAthleteQuestions({ render });
    const readsBefore = mineCalls(calls).length;
    assert.deepEqual(state.athleteQuestions.rows.map((r) => r.questionId), ["q-1"]);
    gate.resolve();
    await later;
    await settle();
    assert.deepEqual(state.athleteQuestions.rows.map((r) => r.questionId), ["q-1"], `${refusal.status}: the new context's row stays`);
    assert.equal(mineCalls(calls).length, readsBefore, `${refusal.status}: no read for the old context`);
  }
});

// ---------------------------------------------------------------------------
// Answer now and the card
// ---------------------------------------------------------------------------
test("Q12. Answer now: RPE opens the external assignment's form, WELLNESS the Tests assignment's form, by the form's id", async () => {
  world.questions = [question({ id: "q-1", formId: "ext-7" }), question({ id: "q-2", kind: "wellness", formId: "ta-9" })];
  const calls = server();
  await enterHome();
  await handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-answer", questionId: "q-1" }), handlers());
  await handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-answer", questionId: "q-2" }), handlers());
  assert.deepEqual(opened, [["rpe", "ext-7"], ["wellness", "ta-9"]]);
  assert.equal(laterCalls(calls).length, 0, "Answer writes no Later");
  assert.equal(prompt(), null);
});

test("Q13. an RPE form not found after Answer now: 'This question has closed.' when the new read no longer lists it; a neutral line while it is still listed", async () => {
  world.questions = [question({ id: "q-1" })];
  const calls = server();
  await enterHome();
  await handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-answer", questionId: "q-1" }), handlers({ rpeFormOpenFor: () => false }));
  assert.equal($(".athlete-questions-notice").textContent, ATHLETE_QUESTION_NOT_OPENED, "still listed: never 'has closed'");
  assert.ok($("section.athlete-questions-card [data-question-id='q-1']"), "its Answer stays");
  world.questions[0].answered = true;
  const before = mineCalls(calls).length;
  await handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-answer", questionId: "q-1" }), handlers({ rpeFormOpenFor: () => false }));
  assert.equal(mineCalls(calls).length, before + 1);
  assert.equal($(".athlete-questions-notice").textContent, ATHLETE_QUESTION_CLOSED);
  assert.equal($(".athlete-questions-notice").getAttribute("role"), "status");
  await enterHome();
  assert.equal($(".athlete-questions-notice"), null, "cleared by the next read");
});

test("Q13c. the form did not open and the reread fails (an outage): never 'has closed', a neutral line instead", async () => {
  world.questions = [question({ id: "q-1" })];
  server();
  await enterHome();
  // Now every read of the list fails.
  server({ failMine: () => ({ status: 503, body: { error: "database_busy", message: "busy" } }) });
  await handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-answer", questionId: "q-1" }), handlers({ rpeFormOpenFor: () => false }));
  assert.equal(state.athleteQuestions.status, "hidden");
  assert.equal($(".athlete-questions-notice").textContent, ATHLETE_QUESTION_UNREACHABLE);
  assert.notEqual($(".athlete-questions-notice").textContent, ATHLETE_QUESTION_CLOSED);
});

test("Q13d. a WELLNESS form that did not open: the same lines as RPE - 'has closed' once the new read no longer lists it, a neutral line while it is", async () => {
  world.questions = [question({ id: "q-2", kind: "wellness", formId: "ta-9" })];
  const calls = server();
  await enterHome();
  const closedForm = handlers({ wellnessFormOpenFor: () => false });
  await handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-answer", questionId: "q-2" }), closedForm);
  assert.deepEqual(opened, [["wellness", "ta-9"]]);
  assert.equal($(".athlete-questions-notice").textContent, ATHLETE_QUESTION_NOT_OPENED, "still listed");
  world.questions[0].answered = true;
  const before = mineCalls(calls).length;
  await handleAthleteQuestionsAction(fakeAction({ action: "athlete-questions-answer", questionId: "q-2" }), closedForm);
  assert.equal(mineCalls(calls).length, before + 1);
  assert.equal($(".athlete-questions-notice").textContent, ATHLETE_QUESTION_CLOSED);
  // A form that opened: no line, no read.
  world.questions = [question({ id: "q-3", kind: "wellness", formId: "ta-3" })];
  await enterHome();
  const reads = mineCalls(calls).length;
  assert.equal(await actions.answerAthleteQuestion("q-3", handlers({ wellnessFormOpenFor: () => true })), true);
  assert.equal(mineCalls(calls).length, reads);
});

test("Q14b. a submit with no open calendar question sends no read; with one, of this form or not, the list is read again", async () => {
  const calls = server();
  await enterHome();
  assert.equal(state.athleteQuestions.rows.length, 0);
  const none = mineCalls(calls).length;
  await athleteQuestionsAnswered("ext-unrelated");
  await athleteQuestionsAnswered("ta-unrelated");
  assert.equal(mineCalls(calls).length, none, "no question: nothing sent");
  world.questions = [question({ id: "q-1", formId: "ext-1" })];
  await enterHome();
  let reads = mineCalls(calls).length;
  await athleteQuestionsAnswered("ext-other");
  assert.equal(mineCalls(calls).length, reads + 1, "an open question: read again");
  reads = mineCalls(calls).length;
  world.questions[0].answered = true;
  await athleteQuestionsAnswered("ext-1");
  assert.equal(mineCalls(calls).length, reads + 1, "its own answer: read again");
  assert.equal(state.athleteQuestions.rows.length, 0);
});

test("Q14. the card: at the top of Home with one Answer per open question; gone after the answer (the row dropped at once, then the read)", async () => {
  world.questions = [question({ id: "q-1", formId: "ext-1", later: true }), question({ id: "q-2", kind: "wellness", formId: "ta-2", later: true })];
  const calls = server();
  await enterHome();
  const section = $("section.athlete-home");
  assert.equal(section.children[1], card(), "right after the header");
  assert.equal($("#athleteQuestionsTitle").textContent, "Questions from your coach");
  assert.equal($$("section.athlete-questions-card [data-action='athlete-questions-answer']").length, 2);
  assert.match($$("section.athlete-questions-card [data-action='athlete-questions-answer']")[0].getAttribute("aria-label"), /^Answer: How hard was it\? Training · Today 16:00$/);
  world.questions[0].answered = true;
  const before = mineCalls(calls).length;
  const reading = athleteQuestionsAnswered("ext-1");
  assert.deepEqual(state.athleteQuestions.rows.map((r) => r.questionId), ["q-2"], "dropped at once");
  await reading;
  assert.equal(mineCalls(calls).length, before + 1);
  assert.equal($$("section.athlete-questions-card li").length, 1);
  world.questions[1].answered = true;
  await athleteQuestionsAnswered("ta-2");
  assert.equal(card(), null, "no open question: no card, no heading");
});

test("Q15. Home's own WELLNESS card is hidden only when it holds exactly one assignment and that one is a question's", async () => {
  world.questions = [question({ id: "q-1", kind: "wellness", formId: "ta-1", later: true })];
  server();
  homeData = { ...HOME_DATA, wellness: { count: 1, assignmentId: "ta-1", closesAt: at(23) } };
  await enterHome();
  assert.equal($(".athlete-home-wellness"), null);
  homeData = { ...HOME_DATA, wellness: { count: 1, assignmentId: "ta-daily", closesAt: at(23) } };
  render();
  assert.ok($(".athlete-home-wellness"), "a daily WELLNESS keeps its card");
  homeData = { ...HOME_DATA, wellness: { count: 2, assignmentId: "", closesAt: at(23) } };
  render();
  assert.ok($(".athlete-home-wellness"), "two check-ins keep the card");
});

test("Q16. the minute's tick: a closed window leaves the card with no request and no repaint of Home; an open prompt whose question closed closes", async () => {
  world.questions = [question({ id: "q-1", closes: at(17, 50) }), question({ id: "q-2", kind: "wellness", later: true })];
  const calls = server();
  await enterHome();
  assert.ok(prompt());
  const header = $("section.athlete-home header");
  $("#athleteQuestionsPromptHost [data-action='athlete-questions-answer']").focus();
  const reads = mineCalls(calls).length;
  const repaints = renders;
  now = new Date(2026, 10, 18, 17, 51).getTime();
  assert.equal(athleteQuestionsTick(), true);
  assert.equal(mineCalls(calls).length, reads, "no request");
  assert.equal(renders, repaints, "Home is not painted again");
  assert.equal($("section.athlete-home header"), header, "the rest of Home is the same node");
  assert.equal($$("section.athlete-questions-card li").length, 1);
  assert.equal(prompt(), null, "the prompt of the closed question closed");
  assert.equal(doc().activeElement?.id, "athleteQuestionsTitle", "the focus goes to the card's title, not the page");
  assert.equal(athleteQuestionsTick(), false, "nothing changed since");
  now = new Date(2026, 10, 19, 0, 1).getTime();
  athleteQuestionsTick();
  assert.equal(card(), null);
  assert.equal(doc().activeElement, $("section.athlete-home .athlete-home-header h3"), "no card: Home's own heading has the focus");
});

test("Q16b. the tick keeps the time-to-answer words true: under an hour the minutes count down with no request", async () => {
  world.questions = [question({ id: "q-1", closes: at(17, 55), later: true })];
  const calls = server();
  await enterHome();
  assert.match(card().textContent, /Answer in the next 25 minutes\./);
  const reads = mineCalls(calls).length;
  now = new Date(2026, 10, 18, 17, 50).getTime();
  assert.equal(athleteQuestionsTick(), true);
  assert.match(card().textContent, /Answer in the next 5 minutes\./);
  assert.equal(mineCalls(calls).length, reads);
});

test("Q19. the phone's Back on the prompt is its Later; with no prompt open Back is not ours (answers false, sends nothing)", async () => {
  world.questions = [question({ id: "q-1" })];
  const calls = server();
  assert.equal(athleteQuestionsBack(handlers()), false, "no prompt: Back keeps its own meaning");
  await enterHome();
  assert.equal(athleteQuestionsBack(handlers()), true);
  assert.equal(prompt(), null);
  await settle();
  assert.equal(laterCalls(calls).length, 1);
  assert.equal(athleteQuestionsBack(handlers()), false);
  assert.equal(laterCalls(calls).length, 1);
});

test("Q20. real clicks on the prompt (it lives outside #content, with its own listener): Later, the backdrop and Answer now; nothing reaches the document", async () => {
  setAthleteQuestionsPromptHandlers(() => handlers());
  let reachedDocument = 0;
  const onDoc = () => { reachedDocument += 1; };
  doc().addEventListener("click", onDoc);
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  world.questions = [question({ id: "q-1" })];
  const calls = server();
  await enterHome();
  assert.equal(doc().getElementById("content").contains(prompt()), false, "outside #content");
  click($("#athleteQuestionsPromptHost [data-action='athlete-questions-later']"));
  await settle();
  await settle();
  assert.equal(prompt(), null, "Later closed it");
  assert.equal(doc().body.classList.contains("athlete-questions-prompt-open"), false, "the page scrolls again");
  assert.deepEqual(laterCalls(calls).map((c) => c.url), ["/api/calendar/questions/q-1/later"]);
  resetAthleteQuestions();
  world.questions = [question({ id: "q-2" })];
  await enterHome();
  click($("#athleteQuestionsPromptHost .athlete-questions-backdrop"));
  await settle();
  await settle();
  assert.equal(prompt(), null, "the backdrop closed it");
  assert.equal(laterCalls(calls).at(-1).url, "/api/calendar/questions/q-2/later");
  resetAthleteQuestions();
  world.questions = [question({ id: "q-3", formId: "ext-3" })];
  await enterHome();
  click($("#athleteQuestionsPromptHost [data-action='athlete-questions-answer']"));
  await settle();
  assert.deepEqual(opened, [["rpe", "ext-3"]], "Answer now opened the form once");
  assert.equal(prompt(), null);
  assert.equal(reachedDocument, 0, "the prompt's clicks go nowhere else");
  doc().removeEventListener("click", onDoc);
  setAthleteQuestionsPromptHandlers(null);
});

test("Q22. a rejecting handler behind the prompt is reported, never left unhandled", async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on("unhandledRejection", onUnhandled);
  setAthleteQuestionsPromptHandlers(() => ({ ...handlers(), openRpe: async () => { throw new Error("form failed"); } }));
  world.questions = [question({ id: "q-1" })];
  server();
  await enterHome();
  $("#athleteQuestionsPromptHost [data-action='athlete-questions-answer']").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await settle();
  await settle();
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", onUnhandled);
  setAthleteQuestionsPromptHandlers(null);
  assert.equal(unhandled, 0);
});

test("Q21. only the latest Home load may show the prompt: an older load settling after a deep link started shows nothing", async () => {
  world.questions = [question({ id: "q-1" })];
  server();
  const older = beginAthleteHomeLoad();
  await loadAthleteQuestions({ render });
  render();
  // A notification click starts its own (deep-link) load meanwhile.
  beginAthleteHomeLoad();
  assert.equal(maybeShowAthleteQuestionsPrompt({ doc: doc(), load: older }), false);
  assert.equal(prompt(), null);
});

// ---------------------------------------------------------------------------
// The notification's open path (the click itself: notifications-calendar-questions.test.mjs)
// ---------------------------------------------------------------------------
test("Q17. openCalendarQuestion: Home read without the prompt, then the form; a question not listed - 'This question isn't open right now.' and Home stays", async () => {
  world.questions = [question({ id: "q-1", formId: "ext-1" })];
  const calls = server();
  assert.equal(await openCalendarQuestion("q-1", handlers()), true);
  assert.deepEqual(opened, [["rpe", "ext-1"]]);
  assert.equal(prompt(), null, "no prompt over a deep link");
  assert.equal(mineCalls(calls).length, 1);
  opened = [];
  assert.equal(await openCalendarQuestion("q-unknown", handlers()), false);
  assert.deepEqual(opened, []);
  assert.equal($(".athlete-questions-notice").textContent, ATHLETE_QUESTION_NOT_OPEN);
  // Not open yet (the notification is written before the window).
  world.questions = [question({ id: "q-early", opens: at(19), closes: at(23) })];
  assert.equal(await openCalendarQuestion("q-early", handlers()), false);
  assert.equal($(".athlete-questions-notice").textContent, ATHLETE_QUESTION_NOT_OPEN);
});

test("Q18. the time-to-answer words: today, tomorrow, another day, under an hour", async () => {
  const { athleteQuestionDueText } = await import("../athlete-questions-view.js");
  assert.equal(athleteQuestionDueText(at(23, 59), NOW), "Answer by 23:59 today.");
  assert.equal(athleteQuestionDueText(at(12, 0, 1), NOW), "Answer by 12:00 tomorrow.");
  assert.equal(athleteQuestionDueText(at(12, 0, 3), NOW), "Answer by 12:00 on Sat 21 Nov.", "Upcoming events' own day word");
  assert.equal(athleteQuestionDueText(at(17, 55), NOW), "Answer in the next 25 minutes.");
  assert.equal(athleteQuestionDueText(at(17, 30, 0), NOW + 30_000), "Answer in the next 1 minute.");
});
