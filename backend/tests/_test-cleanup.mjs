// Runs a single fixture-cleanup step and swallows any error (logging it) so
// a failure in one step - an unexpected FK constraint, a row already gone,
// a transient connection issue - never prevents the REST of a test file's
// after() cleanup from running. Every fixture-cleanup step across the
// backend test suite is wrapped in this: a partially-failed after() must
// never leave fixtures fully orphaned in the shared dev database just
// because one earlier step failed.
export async function safeCleanup(fn, label) {
  try {
    await fn();
  } catch (error) {
    console.error(`[test cleanup] ${label} failed:`, error.message);
  }
}
