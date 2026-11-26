import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { bindCentralCalendarGestures } from "../central-calendar-gestures.js";

test("phone pinch shows three aligned columns; a swipe pans then changes week", () => {
  const dom = new JSDOM(`
    <section class="cc-layout-phone">
      <div class="cc-toolbar"><button data-action="central-calendar-next">Next</button></div>
      <div class="cc-timegrid">${Array.from({ length: 3 }, () => `<div class="cc-timegrid-row"><span></span>${"<span></span>".repeat(7)}</div>`).join("")}</div>
    </section>`);
  const { document, Event } = dom.window;
  const calendar = document.querySelector("section");
  const grid = calendar.querySelector(".cc-timegrid");
  grid.getBoundingClientRect = () => ({ left: 0, width: 350 });
  bindCentralCalendarGestures(calendar);

  function touch(type, points, target = grid) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const touches = points.map(([clientX, clientY]) => ({ clientX, clientY }));
    Object.assign(event, { touches: type === "touchend" ? [] : touches, changedTouches: touches });
    target.dispatchEvent(event);
  }
  const columns = () => Array.from(grid.querySelectorAll(".cc-timegrid-row"), (row) =>
    Array.from(row.children).slice(1).flatMap((cell, index) => cell.hidden ? [] : [index]));
  const sameColumns = (list) => assert.deepEqual(columns(), [list, list, list]);
  let next = 0;
  calendar.querySelector("button").addEventListener("click", () => { next++; });
  const swipe = (target = grid) => {
    touch("touchstart", [[210, 100]], target);
    touch("touchend", [[120, 103]], target);
  };

  sameColumns([0, 1, 2, 3, 4, 5, 6]);
  touch("touchstart", [[152, 100], [223, 100]]);
  touch("touchmove", [[120, 100], [257, 100]]);
  touch("touchend", [[120, 100]]);
  sameColumns([2, 3, 4]);
  swipe(calendar.querySelector(".cc-toolbar"));
  sameColumns([2, 3, 4]);
  swipe();
  swipe();
  sameColumns([4, 5, 6]);
  assert.equal(next, 0);
  swipe();
  assert.equal(next, 1);

  touch("touchstart", [[102, 100], [197, 100]]);
  touch("touchmove", [[137, 100], [162, 100]]);
  touch("touchend", [[137, 100]]);
  sameColumns([0, 1, 2, 3, 4, 5, 6]);
  calendar.insertAdjacentHTML("beforeend", '<div class="athlete-switcher"></div>');
  swipe(calendar.querySelector(".athlete-switcher"));
  assert.equal(next, 1);
  calendar.insertAdjacentHTML("beforeend", '<button class="cc-sheet-backdrop"></button><aside class="cc-sheet"></aside>');
  swipe(calendar.querySelector(".cc-sheet-backdrop"));
  assert.equal(next, 1);
  dom.window.close();
});
