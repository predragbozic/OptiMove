# Owner evidence verified, 2026-11-22

Owner evidence timestamp: approximately 16:40 UTC. Deployed build at the read:
4301851f4af750295d12a7f084e646e9881b8890. PostgreSQL 17.6.
Counts: 4 dashboards, 7 widgets, 7 series. No other open transaction was reported.
All nine widget trigger definitions/body md5s/enabled states and all four replaced
function body md5s agree with the disposable v85 baseline. The full set of 60
reported function body hashes is in v85-production-function-md5s.json.
This is evidence at one moment, not a production preflight or deployment approval.
Per-dashboard production identifiers/digests remain in the owner's original file,
not copied into test fixtures or application data. Re-read on the day of deployment.

The owner subsequently confirmed the exact v87/v88/v89 filenames and checksums in migration-registry.json and that v90/v91 remain reserved for Pages. v89 is expected to merge/apply before v88; optional registry checks accept either recorded order and never infer the last migration from the version label. Final main/registry confirmation is still required at freeze.
