// Shared minimal DOM doubles for frontend action tests (T1 test-infrastructure
// foundation). The app's action handlers receive the clicked element and read
// its `dataset` (and sometimes `value`, `disabled` or `closest()`); these
// doubles give them exactly that, with no real DOM.
//
//   fakeAction({ action: "x", id: "1" })            -> the element a handler receives
//   fakeAction({ action: "x" }, { value: "7" })      -> with an input value
//   fakeAction({ action: "x" }, { closestResult })   -> closest() answers that element
//   fakeElement()                                    -> an empty container element
//
// They replace the per-file copies of `fakeAction` (34 suites, in three
// shapes: `{ dataset }`, `{ dataset, value }` and
// `{ dataset, disabled: false, closest }`) and `fakeElement` (16 suites).
// The shape returned here is the union of those three, so a handler that
// reads any of the fields finds what it read before.

export function fakeAction(dataset = {}, { value, disabled = false, closestResult = null, ...rest } = {}) {
  return { dataset, value, disabled, closest: () => closestResult, ...rest };
}

export function fakeElement(overrides = {}) {
  return { innerHTML: "", textContent: "", querySelector: () => null, querySelectorAll: () => [], ...overrides };
}
