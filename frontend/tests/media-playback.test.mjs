import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// FE-1: the media descriptor normalizer (media.js) and the short-lived
// access adapter (media-playback.js), against isolated fake answers in the
// shape of the final Codex contract (context + slots; results by index) -
// the backend is not implemented yet, so nothing here reaches a server.

const media = await import("../media.js");
const playback = await import("../media-playback.js");

const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const ctx = (id, type = "exercise") => ({ type, id });
const asset = (mediaId, url, minutes = 10) => ({ source: "asset", mediaId, url, expiresAt: minutesFromNow(minutes), mimeType: "image/jpeg" });

// A fetch fake: every call recorded, answered by `answer(url, body, n)`.
function fakeFetch(answer) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (options.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url: String(url), method: options.method || "GET", body });
    const reply = await answer(String(url), body, calls.length);
    if (reply?.status && reply.status >= 400) return { ok: false, status: reply.status, statusText: "Error", json: async () => reply.json || {} };
    return { ok: true, status: 200, json: async () => reply };
  };
  return calls;
}

// The batch fake: one result per request, each slot answered from `pick(context, slot)`.
const batchAnswer = (pick) => (url, body) => ({
  results: body.requests.map((request, index) => {
    const entries = {};
    for (const slot of request.slots) {
      const entry = pick(request.context, slot);
      if (entry) entries[slot] = entry;
    }
    return { index, media: entries };
  }),
});

const row = (overrides = {}) => ({ id: "e1", name: "Dead Bug", image_url: "", video_url: "", ...overrides });

test("0. the descriptor: asset / legacy / none per slot (mediaId), legacy fields only without a descriptor, the context { type, id } or null", () => {
  const described = media.exerciseMediaOf(row({
    image_url: "https://legacy.example/ignored.jpg",
    video_url: "https://youtu.be/dQw4w9WgXcQ",
    media: { video: { source: "legacy", url: "https://youtu.be/dQw4w9WgXcQ" }, image: { source: "asset", mediaId: "img-1" }, accessContext: { type: "exercise", id: "e1" } },
  }));
  assert.deepEqual(described.image, { source: "asset", mediaId: "img-1", url: "", kind: "asset" });
  assert.deepEqual(described.video, { source: "legacy", mediaId: "", url: "https://youtu.be/dQw4w9WgXcQ", kind: "youtube" });
  assert.deepEqual(described.accessContext, { type: "exercise", id: "e1" });
  assert.equal(media.hasAnyMedia(described), true);

  // "none" wins over a legacy column that still holds a value.
  const none = media.exerciseMediaOf(row({ image_url: "https://legacy.example/old.jpg", media: { video: { source: "none" }, image: { source: "none" }, accessContext: ctx("e1") } }));
  assert.equal(none.image.source, "none");
  assert.equal(none.video.source, "none");
  assert.equal(media.hasAnyMedia(none), false);

  // No descriptor: the legacy fields, in every spelling the render sites use; no context.
  const legacy = media.exerciseMediaOf({ imageUrl: "https://drive.google.com/file/d/FILE_1/view", video: "https://cdn.example/clip.mp4" });
  assert.equal(legacy.image.kind, "drive");
  assert.equal(legacy.video.kind, "url");
  assert.equal(legacy.accessContext, null);
  // A legacy slot without its own url reads the row's column; an asset slot without an id is nothing;
  // a context without a type or an id is none; a numeric id is kept as text.
  const partial = media.exerciseMediaOf(row({ video_url: "https://youtu.be/dQw4w9WgXcQ", media: { video: { source: "legacy" }, image: { source: "asset" }, accessContext: { type: "exercise" } } }));
  assert.equal(partial.video.url, "https://youtu.be/dQw4w9WgXcQ");
  assert.equal(partial.image.source, "none");
  assert.equal(partial.accessContext, null);
  assert.deepEqual(media.normalizeAccessContext({ type: " exercise ", id: 7 }), { type: "exercise", id: "7" });
  assert.equal(media.normalizeAccessContext("exercise:e1"), null);

  // The open-media attributes: the legacy links as before, the media ids and the context only for assets.
  assert.equal(media.mediaAccessAttributes(legacy), `data-image="https://drive.google.com/file/d/FILE_1/view" data-video="https://cdn.example/clip.mp4"`);
  const attributes = media.mediaAccessAttributes(described);
  assert.match(attributes, /^data-image="" data-video="https:\/\/youtu\.be\/dQw4w9WgXcQ" data-image-media-id="img-1" data-media-access-context="/);
  assert.doesNotMatch(attributes, /data-video-media-id|assetId/);
  const dom = new JSDOM(`<button ${attributes}></button>`);
  assert.deepEqual(media.decodeAccessContext(dom.window.document.querySelector("button").dataset.mediaAccessContext), { type: "exercise", id: "e1" });
  assert.equal(media.decodeAccessContext(""), null);
  assert.equal(media.decodeAccessContext("{not json"), null);
  assert.equal(media.decodeAccessContext(JSON.stringify("opaque")), null, "a context is { type, id }, nothing else");
  // An asset picture: no address, the id, the slot, the context, the public fallbacks.
  const picture = media.renderMediaImage(described, "thumb");
  assert.match(picture, /^<img class="thumb" alt="" data-media-id="img-1" data-media-slot="image" data-media-access-context="[^"]+">$/);
  assert.doesNotMatch(picture, / src=/);
  assert.equal(media.renderMediaImage(legacy, "thumb"), media.renderImage(legacy.image.url, "thumb"));
  assert.equal(media.renderMediaImage(none, "thumb"), "");
  dom.window.close();
});

test("1. the player's address: one request with the context and the slot, reused while fresh, forgotten on demand or past its margin; the poster in the same request", async () => {
  playback.forgetMediaAccess();
  const calls = fakeFetch((url, body) => {
    const answer = {};
    if (body.slots.includes("video")) answer.video = asset("vid-1", "https://r2.example/v1?sig=1");
    if (body.slots.includes("image")) answer.image = asset("img-1", "https://r2.example/i1?sig=1");
    return answer;
  });
  const first = await playback.loadPlayback(ctx("e1"));
  assert.equal(first.url, "https://r2.example/v1?sig=1");
  assert.equal(first.mediaId, "vid-1");
  assert.equal(first.poster, "");
  assert.deepEqual(calls, [{ url: playback.ACCESS_ROUTE, method: "POST", body: { context: { type: "exercise", id: "e1" }, slots: ["video"] } }]);
  const again = await playback.loadPlayback(ctx("e1"));
  assert.equal(again.url, first.url);
  assert.equal(calls.length, 1, "a fresh address is not asked for again");
  // The poster: only the missing slot is asked for.
  const withPoster = await playback.loadPlayback(ctx("e1"), { withPoster: true });
  assert.equal(withPoster.poster, "https://r2.example/i1?sig=1");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { context: { type: "exercise", id: "e1" }, slots: ["image"] });
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "video").url, first.url);
  playback.forgetMediaAccess(ctx("e1"), "video");
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "video"), null);
  assert.ok(playback.cachedMediaAccess(ctx("e1"), "image"), "forgetting one slot leaves the other");
  await playback.loadPlayback(ctx("e1"));
  assert.equal(calls.length, 3);
  // An address inside its margin counts as expired; no expiry means the contract's ten minutes.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ video: { source: "asset", mediaId: "vid-2", url: "https://r2.example/short", expiresAt: new Date(Date.now() + 5_000).toISOString() } }) });
  await playback.loadPlayback(ctx("e2"));
  assert.equal(playback.cachedMediaAccess(ctx("e2"), "video"), null, "five seconds left is inside the 30 s margin");
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ video: { source: "asset", mediaId: "vid-3", url: "https://r2.example/noexp" } }) });
  const assumed = await playback.loadPlayback(ctx("e3"));
  assert.ok(assumed.expiresAt > Date.now() + playback.PLAYBACK_TTL_MS - 2_000);
  playback.forgetMediaAccess();
});

test("2. every failure carries a stable code: context_invalid, not_available, unavailable, refused, answer_unexpected, aborted", async () => {
  playback.forgetMediaAccess();
  const code = async (answer, context = ctx("ex"), options) => {
    fakeFetch(() => answer);
    try {
      await playback.loadPlayback(context, options);
      return "no error";
    } catch (error) {
      return error.code;
    }
  };
  assert.equal(await code({ video: asset("v", "https://r2.example/v") }, { type: "exercise" }), "context_invalid");
  assert.equal(await code({ status: 404, json: { error: "notFound" } }), "not_available");
  assert.equal(await code({ status: 403, json: { error: "forbidden" } }), "not_available");
  assert.equal(await code({ status: 503, json: { error: "busy" } }), "unavailable");
  assert.equal(await code({ status: 400, json: { error: "invalidBody" } }), "refused");
  assert.equal(await code({ image: asset("i", "https://r2.example/i") }), "not_available", "an answer without the video slot");
  assert.equal(await code({ video: { source: "asset", mediaId: "v" } }), "not_available", "a slot without an address");
  assert.equal(await code(null), "answer_unexpected");
  const controller = new AbortController();
  controller.abort();
  assert.equal(await code({ video: asset("v", "https://r2.example/late") }, ctx("ex"), { signal: controller.signal }), "aborted");
  assert.equal(playback.cachedMediaAccess(ctx("ex"), "video"), null, "nothing is cached after a failure");
  playback.forgetMediaAccess();
});

test("3. the same object under two contexts never shares an address: cached per (context, slot), never per media id", async () => {
  playback.forgetMediaAccess();
  const calls = fakeFetch((url, body) => ({ video: asset("shared-vid", `https://r2.example/shared?for=${body.context.type}:${body.context.id}`) }));
  const coach = await playback.loadPlayback(ctx("e1"));
  const athlete = await playback.loadPlayback(ctx("p9", "program_item"));
  assert.equal(coach.mediaId, athlete.mediaId, "the very same object");
  assert.equal(calls.length, 2, "one request per context");
  assert.notEqual(coach.url, athlete.url);
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "video").url, "https://r2.example/shared?for=exercise:e1");
  assert.equal(playback.cachedMediaAccess(ctx("p9", "program_item"), "video").url, "https://r2.example/shared?for=program_item:p9");
  assert.equal(playback.cachedMediaAccess(ctx("e1", "program_item"), "video"), null, "the same id under another type is another context");
  playback.forgetMediaAccess(ctx("e1"));
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "video"), null);
  assert.ok(playback.cachedMediaAccess(ctx("p9", "program_item"), "video"), "forgetting one context leaves the other");
  // The batch, likewise: two contexts asking for the same object are two requests with two addresses.
  const batch = fakeFetch(batchAnswer((context, slot) => asset("shared-img", `https://r2.example/img?for=${context.id}&slot=${slot}`)));
  const answers = await playback.resolveMediaAccess([{ context: ctx("a"), slot: "image" }, { context: ctx("b"), slot: "image" }]);
  assert.equal(batch[0].body.requests.length, 2);
  assert.equal(answers.get(playback.accessKey(ctx("a"), "image")).url, "https://r2.example/img?for=a&slot=image");
  assert.equal(answers.get(playback.accessKey(ctx("b"), "image")).url, "https://r2.example/img?for=b&slot=image");
  playback.forgetMediaAccess();
});

test("4. a batch asks once per context with the slots it needs, in calls of at most 50 requests, shares a running request, leaves out what the server did not answer", async () => {
  playback.forgetMediaAccess();
  const ids = Array.from({ length: 120 }, (_, index) => `e${index}`);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = fakeFetch(async (url, body) => {
    assert.equal(url, playback.ACCESS_BATCH_ROUTE);
    assert.ok(body.requests.length <= playback.ACCESS_BATCH_LIMIT);
    await gate;
    // Every third context is left out (no right, or deleted); one comes back without an address.
    return {
      results: body.requests.map((request, index) => ({ index, media: Object.fromEntries(request.slots.map((slot) => [slot, asset(`${request.context.id}-${slot}`, index === 1 ? null : `https://r2.example/${request.context.id}/${slot}`)])) }))
        .filter((result) => result.index % 3 !== 0),
    };
  });
  const items = ids.map((id) => ({ context: ctx(id), slot: "image" }));
  // The same pairs asked twice while the first request runs, one context asking for two slots: one set of requests.
  const [first, second] = await (async () => {
    const a = playback.resolveMediaAccess([...items, { context: ctx("e1"), slot: "image" }, { context: ctx("e1"), slot: "video" }, { context: { type: "exercise" }, slot: "image" }, { context: ctx("e2"), slot: "poster" }]);
    const b = playback.resolveMediaAccess(items.slice(0, 10));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    return Promise.all([a, b]);
  })();
  assert.equal(calls.length, 3, "120 contexts: 50 + 50 + 20");
  assert.deepEqual(calls.map((call) => call.body.requests.length), [50, 50, 20]);
  assert.deepEqual(calls[0].body.requests[1], { context: { type: "exercise", id: "e1" }, slots: ["image", "video"] }, "one request per context, both slots at once");
  const key = (id, slot = "image") => playback.accessKey(ctx(id), slot);
  assert.equal(first.has(key("e0")), false, "left out by the server");
  assert.equal(first.get(key("e2")).url, "https://r2.example/e2/image");
  assert.equal(first.get(key("e2")).mediaId, "e2-image");
  assert.equal(first.has(key("e1")), false, "a slot without an address is not an address");
  assert.equal(first.has(key("e1", "video")), false);
  assert.equal(second.get(key("e2")).url, "https://r2.example/e2/image", "the second caller shared the first request");
  // Cached pairs are not asked again; only the missing ones go out.
  await playback.resolveMediaAccess(items.slice(0, 3));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3].body.requests.map((request) => request.context.id), ["e0", "e1"]);
  // A failed batch gives nothing and throws nothing.
  globalThis.fetch = async () => { throw new Error("network"); };
  assert.equal((await playback.resolveMediaAccess([{ context: ctx("new"), slot: "image" }])).size, 0);
  playback.forgetMediaAccess();
});

test("5. the pictures on screen get their addresses in one batch; an unanswered one moves to its fallbacks, and with none left it ends in the app's error path", async () => {
  playback.forgetMediaAccess();
  const dom = new JSDOM(`<main>
    ${media.renderAssetImage("img-a", ctx("a"), "thumb")}
    ${media.renderAssetImage("img-a", ctx("a"), "thumb")}
    ${media.renderAssetImage("img-b", ctx("b"), "thumb", { fallbacks: ["https://cover.example/b1.jpg", "https://cover.example/b2.jpg"] })}
    ${media.renderAssetImage("img-c", null, "thumb")}
    <img class="thumb" src="https://legacy.example/d.jpg" alt="">
  </main>`);
  const doc = dom.window.document;
  const calls = fakeFetch(batchAnswer((context) => (context.id === "a" ? asset("img-a-current", "https://r2.example/a") : null)));
  const errors = [];
  doc.addEventListener("error", (event) => errors.push(event.target.className), true);
  assert.equal(await playback.resolvePendingThumbnails(doc), 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.requests, [{ context: { type: "exercise", id: "a" }, slots: ["image"] }, { context: { type: "exercise", id: "b" }, slots: ["image"] }], "two cards of one context are one request; a picture without a context is never asked for");
  const [a1, a2, b, c] = doc.querySelectorAll("img");
  assert.equal(a1.src, "https://r2.example/a");
  assert.equal(a2.src, "https://r2.example/a");
  assert.equal(a1.dataset.mediaId, "img-a-current", "the context's current object");
  assert.equal(b.src, "https://cover.example/b1.jpg", "the first public fallback");
  assert.deepEqual(JSON.parse(b.dataset.fallbacks), ["https://cover.example/b2.jpg"]);
  assert.equal(b.dataset.mediaId, undefined, "from here on an ordinary picture");
  assert.equal(c.hasAttribute("src"), false);
  assert.equal(c.dataset.mediaId, undefined);
  assert.deepEqual(errors, ["thumb"], "only the picture with nothing left was handed to the error path");
  // Nothing pending any more: no request.
  assert.equal(await playback.resolvePendingThumbnails(doc), 0);
  assert.equal(calls.length, 1);
  playback.forgetMediaAccess();
  dom.window.close();
});

test("6. a picture whose address failed to load asks for a new one once, never twice", async () => {
  playback.forgetMediaAccess();
  const dom = new JSDOM(`<main>${media.renderAssetImage("img-a", ctx("a"), "thumb")}</main>`);
  const image = dom.window.document.querySelector("img");
  let issued = 0;
  const calls = fakeFetch(batchAnswer(() => asset("img-a", `https://r2.example/a?sig=${++issued}`)));
  await playback.resolvePendingThumbnails(dom.window.document);
  assert.equal(image.src, "https://r2.example/a?sig=1");
  assert.equal(playback.retryExpiredMediaImage(image), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 2, "the cached address was forgotten and a new one asked for");
  assert.equal(image.src, "https://r2.example/a?sig=2");
  assert.equal(playback.retryExpiredMediaImage(image), false, "a second failure is left to the fallbacks");
  assert.equal(calls.length, 2);
  assert.equal(playback.retryExpiredMediaImage(dom.window.document.createElement("img")), false, "an ordinary picture is not ours");
  playback.forgetMediaAccess();
  dom.window.close();
});

test("7. the installed resolver asks for every new picture on the next frame, in one request", async () => {
  playback.forgetMediaAccess();
  const dom = new JSDOM("<main></main>", { pretendToBeVisual: true });
  const doc = dom.window.document;
  const calls = fakeFetch(batchAnswer((context) => asset(`img-${context.id}`, `https://r2.example/${context.id}`)));
  const uninstall = playback.installThumbnailResolver(doc.body);
  doc.querySelector("main").innerHTML = `${media.renderAssetImage("img-1", ctx("1"), "thumb")}${media.renderAssetImage("img-2", ctx("2"), "thumb")}`;
  await new Promise((resolve) => dom.window.requestAnimationFrame(() => setTimeout(resolve, 0)));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.requests.map((request) => request.context.id), ["1", "2"]);
  assert.deepEqual([...doc.querySelectorAll("img")].map((image) => image.src), ["https://r2.example/1", "https://r2.example/2"]);
  uninstall();
  doc.querySelector("main").insertAdjacentHTML("beforeend", media.renderAssetImage("img-3", ctx("3"), "thumb"));
  await new Promise((resolve) => dom.window.requestAnimationFrame(() => setTimeout(resolve, 0)));
  assert.equal(calls.length, 1, "uninstalled: nothing asked");
  playback.forgetMediaAccess();
  dom.window.close();
});

// Owner, 2026-10-30 ("Deploy + C pa A"), option C: the pictures on screen get
// their addresses first, in a small batch of their own; the rest follow in
// full batches sent at the same time, each batch shown as soon as it answers.

const ON_SCREEN = { top: 100, bottom: 200, left: 0, right: 100, width: 100, height: 100 };
const BELOW = { top: 2000, bottom: 2100, left: 0, right: 100, width: 100, height: 100 };
const ABOVE = { top: -500, bottom: -400, left: 0, right: 100, width: 100, height: 100 };

// A page of `count` pictures (one context each), the given ones on screen,
// the `above` ones scrolled past, the rest below.
function page(count, visible = [], above = []) {
  const dom = new JSDOM(`<main>${Array.from({ length: count }, (_, index) => media.renderAssetImage(`img-${index}`, ctx(String(index)), "thumb")).join("")}</main>`, { pretendToBeVisual: true });
  const images = [...dom.window.document.querySelectorAll("img")];
  images.forEach((image, index) => {
    const rect = visible.includes(index) ? ON_SCREEN : above.includes(index) ? ABOVE : BELOW;
    image.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top });
  });
  return { dom, doc: dom.window.document, images };
}

// Every batch call held until released by its index.
function heldBatches() {
  const releases = [];
  const calls = fakeFetch((url, body) => new Promise((resolve) => {
    releases.push(() => resolve(batchAnswer((context) => asset(`img-${context.id}`, `https://r2.example/${context.id}`))(url, body)));
  }));
  return { calls, release: (index) => releases[index]() };
}

const ids = (call) => call.body.requests.map((request) => request.context.id);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const range = (from, to) => Array.from({ length: to - from }, (_, index) => String(from + index));

test("8. the pictures on screen go first: a page of 60 with 8 on screen sends the 8 (then the next 4) in a first batch of 12 and the other 48 at the same time; the first 12 are shown before the big batch answers", async () => {
  playback.forgetMediaAccess();
  assert.equal(playback.ACCESS_FIRST_BATCH_LIMIT, 12);
  const visible = range(20, 28).map(Number);
  const { dom, doc, images } = page(60, visible, range(0, 20).map(Number));
  const { calls, release } = heldBatches();
  const done = playback.resolvePendingThumbnails(doc);
  assert.equal(calls.length, 3, "every batch leaves at once");
  assert.deepEqual(ids(calls[0]), range(20, 28), "the 8 on screen alone, in page order (the 20 scrolled past are not on screen)");
  assert.deepEqual(ids(calls[1]), [...range(0, 20), ...range(28, 58)], "the rest in page order, 50 at a time");
  assert.deepEqual(ids(calls[2]), range(58, 60));
  images[50].remove();
  release(0);
  await settle();
  for (const index of visible) assert.equal(images[index].src, `https://r2.example/${index}`, `picture ${index} is shown while the big batch is still out`);
  assert.equal(images[0].hasAttribute("src"), false, "the big batch has not answered yet");
  release(1);
  release(2);
  assert.equal(await done, 59, "every picture still on the page got its address");
  assert.equal(images[30].src, "https://r2.example/30");
  assert.equal(images[50].hasAttribute("src"), false, "a picture gone from the page is left alone");
  playback.forgetMediaAccess();
  dom.window.close();
});

test("8b. more than 12 on screen: the first 12 of them go first, the other on-screen ones lead the next batch", async () => {
  playback.forgetMediaAccess();
  const { dom, doc } = page(40, range(10, 30).map(Number));
  const { calls, release } = heldBatches();
  const done = playback.resolvePendingThumbnails(doc);
  assert.deepEqual(calls.map((call) => call.body.requests.length), [12, 28]);
  assert.deepEqual(ids(calls[0]), range(10, 22));
  assert.deepEqual(ids(calls[1]), [...range(22, 30), ...range(0, 10), ...range(30, 40)]);
  release(0);
  release(1);
  assert.equal(await done, 40);
  playback.forgetMediaAccess();
  dom.window.close();
});

test("9. with nothing on screen the page order holds: 112 pictures go out as 12, 50 and 50, all at once, and each batch is shown as soon as it answers, not after the last", async () => {
  playback.forgetMediaAccess();
  const { dom, doc, images } = page(112);
  const { calls, release } = heldBatches();
  const done = playback.resolvePendingThumbnails(doc);
  assert.deepEqual(calls.map((call) => call.body.requests.length), [12, 50, 50]);
  assert.deepEqual(ids(calls[0]), range(0, 12));
  assert.deepEqual(ids(calls[2]), range(62, 112));
  release(1);
  await settle();
  assert.equal(images[12].src, "https://r2.example/12", "the second batch is shown though the first and the third are still out");
  assert.equal(images[61].src, "https://r2.example/61");
  assert.equal(images[0].hasAttribute("src"), false);
  assert.equal(images[62].hasAttribute("src"), false);
  release(0);
  release(2);
  assert.equal(await done, 112);
  playback.forgetMediaAccess();
  dom.window.close();
});

test("10. a context is never asked for twice: not while its request is out (a second pass or a new picture of it waits for the same answer), not once it is known", async () => {
  playback.forgetMediaAccess();
  const { dom, doc, images } = page(3, [0, 1, 2]);
  const { calls, release } = heldBatches();
  const first = playback.resolvePendingThumbnails(doc);
  assert.equal(calls.length, 1);
  assert.equal(await playback.resolvePendingThumbnails(doc), 0, "pictures already being resolved are not taken again");
  doc.querySelector("main").insertAdjacentHTML("beforeend", media.renderAssetImage("img-1", ctx("1"), "thumb"));
  const twin = doc.querySelector("main").lastElementChild;
  const second = playback.resolvePendingThumbnails(doc);
  assert.equal(calls.length, 1, "a new picture of a context that is out waits for that answer");
  release(0);
  assert.equal(await first, 3);
  assert.equal(await second, 1);
  assert.equal(twin.src, "https://r2.example/1");
  doc.querySelector("main").insertAdjacentHTML("beforeend", media.renderAssetImage("img-2", ctx("2"), "thumb"));
  assert.equal(await playback.resolvePendingThumbnails(doc), 1);
  assert.equal(calls.length, 1, "a known context is not asked again");
  assert.ok(images.every((image) => image.src));
  playback.forgetMediaAccess();
  dom.window.close();
});

test("11. the installed resolver: a picture scrolled to later already has its address (the whole page is asked for, on-screen first), and pictures added by Load more are asked for on the next frame", async () => {
  playback.forgetMediaAccess();
  const dom = new JSDOM("<main></main>", { pretendToBeVisual: true });
  const doc = dom.window.document;
  const calls = fakeFetch(batchAnswer((context) => asset(`img-${context.id}`, `https://r2.example/${context.id}`)));
  const uninstall = playback.installThumbnailResolver(doc.body);
  doc.querySelector("main").innerHTML = Array.from({ length: 30 }, (_, index) => media.renderAssetImage(`img-${index}`, ctx(String(index)), "thumb")).join("");
  [...doc.querySelectorAll("img")].forEach((image, index) => {
    const rect = index >= 25 ? ON_SCREEN : BELOW;
    image.getBoundingClientRect = () => ({ ...rect });
  });
  await new Promise((resolve) => dom.window.requestAnimationFrame(() => setTimeout(resolve, 0)));
  await settle();
  assert.deepEqual(ids(calls[0]), range(25, 30), "the five on screen first, alone");
  assert.equal(calls.length, 2, "30 pictures: the 5 on screen, then the other 25");
  assert.deepEqual(ids(calls[1]), range(0, 25));
  assert.ok([...doc.querySelectorAll("img")].every((image) => image.src), "every picture has its address before it is scrolled to");
  doc.querySelector("main").insertAdjacentHTML("beforeend", Array.from({ length: 10 }, (_, index) => media.renderAssetImage(`img-${30 + index}`, ctx(String(30 + index)), "thumb")).join(""));
  await new Promise((resolve) => dom.window.requestAnimationFrame(() => setTimeout(resolve, 0)));
  await settle();
  assert.equal(calls.length, 3, "Load more: one more batch");
  assert.deepEqual(ids(calls[2]), range(30, 40), "only the new pictures");
  assert.equal(doc.querySelectorAll("img:not([src])").length, 0);
  uninstall();
  playback.forgetMediaAccess();
  dom.window.close();
});
