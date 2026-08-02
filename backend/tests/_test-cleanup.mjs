// Runs every fixture-cleanup step in a test file's after() hook, even if an
// earlier one fails (an unexpected FK constraint, a row already gone, a
// transient connection issue) - a failure in one step must never prevent
// the REST of that file's cleanup from running, or fixtures get orphaned in
// the shared dev database. Once every step has been attempted, if ANY of
// them failed, this throws an AggregateError - node:test then reports the
// file's after() hook (and therefore the whole run) as failed, so a
// standard `npm test` can never go green while cleanup silently left data
// behind. Never swallow the errors here; that would make cleanup failures
// invisible to the normal test run.
//
// steps: an array of [label, fn] pairs, run in order.
export async function runCleanupSteps(steps) {
  const errors = [];
  for (const [label, fn] of steps) {
    try {
      await fn();
    } catch (error) {
      errors.push(new Error(`${label}: ${error.message}`, { cause: error }));
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, `${errors.length} of ${steps.length} cleanup step(s) failed`);
  }
}
