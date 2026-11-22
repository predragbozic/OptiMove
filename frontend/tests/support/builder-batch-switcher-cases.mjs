// The cases of the Builder batch switcher's golden test (K6, contract 1.4).
// Each case sets the shared state, calls renderBuilderBatchSwitcher and returns
// the raw HTML string, whitespace included.
const NAMES = [
  "Ana Kovač", "Ben Marsh", "Chloe Dunn", "Dario Finch", "Elena Rossi", "Farid Noor",
  "Greta Holm", "Hugo Lang", "Iris Vale", "Jonas Reid", "Kira Stone", "Luca Berg",
];

function makePlans(count, { withUnnamed = false } = {}) {
  return NAMES.slice(0, count).map((name, index) => ({
    id: `plan-${index + 1}`,
    athleteId: String(index + 1),
    athleteName: name,
    name: `Week copy ${index + 1}`,
  })).map((plan, index, all) => {
    if (withUnnamed && index === all.length - 1) return { id: plan.id, athleteId: plan.athleteId };
    return plan;
  });
}

export function buildBatchSwitcherCases({ state, renderBuilderBatchSwitcher }) {
  const cases = [];
  const add = (name, plans, index, { editDraft = false, hiddenCount = 0, photos = [], sync = true } = {}) => {
    state.athletes = photos.map((id) => ({ athlete_id: id, athlete_image_url: `https://img.example/${id}.jpg` }));
    state.builder.draft = { plan: { isEditDraft: editDraft }, batch: { hiddenCount } };
    state.builder.batchSync = sync;
    cases.push({ name, html: renderBuilderBatchSwitcher(plans, index) });
  };
  for (const [count, picks] of [[2, [0, 1]], [5, [0, 2, 4]], [12, [0, 6, 11]]]) {
    const plans = makePlans(count);
    for (const index of picks) {
      add(`${count} plans, #${index + 1} chosen`, plans, index);
      add(`${count} plans, #${index + 1} chosen, photos`, plans, index, { photos: ["1", String(count)] });
      add(`${count} plans, #${index + 1} chosen, hidden 3`, plans, index, { hiddenCount: 3 });
      add(`${count} plans, #${index + 1} chosen, edit draft`, plans, index, { editDraft: true, hiddenCount: 1 });
    }
  }
  add("sync off", makePlans(5), 2, { sync: false });
  add("a plan with neither athleteName nor name", makePlans(5, { withUnnamed: true }), 4);
  add("a single name caption and html in a name", [
    { id: "p1", athleteId: "1", athleteName: "Cher" },
    { id: "p2", athleteId: "2", athleteName: "A <b>&\"' Quote" },
  ], 1);
  add("empty batch", [], 0);
  add("negative index", makePlans(2), -1);
  return cases;
}
