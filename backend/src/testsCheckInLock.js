// Advisory lock for the public schedule check-in link
// (/tests/check-in/:publicToken) - mirrors backend/src/joinLinkContext.js's
// "resolve without mutation, then lock, then re-check" pattern and its
// per-entity pg_advisory_xact_lock convention. A distinct namespace constant
// from every other lock namespace in the app (719402617 join-link actions,
// 719402629 applicant athlete creation) - never reused, never changed.
const TEST_ACCESS_LINK_LOCK_NAMESPACE = 719402641;

export async function lockTestAccessLinkActions(executor, linkId) {
  await executor(`select pg_advisory_xact_lock($1, hashtext($2::text))`, [TEST_ACCESS_LINK_LOCK_NAMESPACE, String(linkId)]);
}
