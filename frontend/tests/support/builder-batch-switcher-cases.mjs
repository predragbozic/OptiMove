// The cases of the Builder batch switcher's golden test (K6 contract 1.4): one
// list, shared by the test and by the generator that recorded the golden HTML
// before the strip was extracted into athlete-switcher.js. Synthetic names only.
const NAMES = [
  "Ana Kovac", "Ben Petrovic", "Cara Jovanovic", "Dan Ilic", "Eva Markovic", "Filip Nikolic",
  "Gala Stojanovic", "Hana Popovic", "Ivo Lukic", "Jana Pavlovic", "Kai Simic", "Lea Todorovic",
];
const PHOTOS = {
  1: "https://example.invalid/athletes/1.jpg",
  4: "https://example.invalid/athletes/4.jpg",
  9: "https://example.invalid/athletes/9.jpg",
};

// A batch of `n` plans, ids P1..Pn, athletes 1..n; `unnamed` is the 1-based
// index of a plan with neither athleteName nor name ("Program copy").
function batchOf(n, { unnamed = 0, singleNames = false } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const k = i + 1;
    if (k === unnamed) return { id: `P${k}`, athleteId: String(k) };
    const name = singleNames && k % 2 === 0 ? NAMES[i].split(" ")[0] : NAMES[i];
    return { id: `P${k}`, athleteId: String(k), athleteName: name };
  });
}

export const ATHLETES = Object.entries(PHOTOS).map(([k, url]) => (
  Number(k) === 4 ? { athlete_id: k, image_url: url } : { athlete_id: k, athlete_image_url: url }
));

// Each case: the batch, the chosen index, the hidden count, edit draft or not, the sync box.
export const CASES = [];
for (const [n, options] of [[2, {}], [5, { unnamed: 3, singleNames: true }], [12, { unnamed: 12 }]]) {
  for (const index of new Set([0, Math.floor(n / 2), n - 1])) {
    for (const isEditDraft of [false, true]) {
      CASES.push({
        name: `${n} plans, #${index + 1} chosen, ${isEditDraft ? "edit draft" : "draft"}`,
        plans: batchOf(n, options),
        index,
        hiddenCount: n === 5 ? 3 : n === 12 && index === 0 ? 1 : 0,
        isEditDraft,
        batchSync: !(n === 12 && isEditDraft === false && index === n - 1),
      });
    }
  }
}
