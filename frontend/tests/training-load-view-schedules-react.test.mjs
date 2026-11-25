import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { JSDOM } from "jsdom";

let islands, dom;
before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "Event"]) {
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
  }
  islands = await import("../react-build/islands.js");
});
after(() => dom.window.close());

test("view schedules have no management controls and render the date and status", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  islands.mountIsland(host, islands.TrainingLoadViewSchedules, {
    loadSchedules: async () => ({ schedules: [
      { id: "internal-schedule-id", eventName: "Recovery session", startDate: "2026-11-25", status: "active" },
    ] }),
  });
  try {
    for (let attempt = 0; attempt < 50 && !host.querySelector("li"); attempt++) await wait(10);
    assert.equal(host.querySelectorAll("li").length, 1);
    assert.match(host.textContent, /Recovery session.*25\.11\.2026.*Active/s);
    assert.equal(host.querySelector("button"), null);
    assert.doesNotMatch(host.innerHTML, /internal-schedule-id/);
  } finally {
    islands.unmountIsland(host);
    host.remove();
  }
});
