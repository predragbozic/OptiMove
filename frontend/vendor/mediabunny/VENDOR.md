# Mediabunny (vendored)

| | |
|---|---|
| Package | `mediabunny` (https://mediabunny.dev, https://github.com/Vanilagy/mediabunny) |
| Version | 1.61.1 (published 2026-10-03) |
| File | `mediabunny-1.61.1.min.mjs` = the package's `dist/bundles/mediabunny.min.mjs`, **unmodified** |
| Source URL | https://cdn.jsdelivr.net/npm/mediabunny@1.61.1/dist/bundles/mediabunny.min.mjs (identical on https://unpkg.com/mediabunny@1.61.1/dist/bundles/mediabunny.min.mjs) |
| SHA-256 | `652fbe9226e55cb0c0784aaba6b4b73fea4fc0df498f62050cdc617a4bd97ca2` |
| License | MPL-2.0 (`LICENSE` beside it; the file's own license header is kept) |
| Vendored | 2026-10-20 for the on-device preparation of phone videos (`frontend/exercise-media-prepare.js`) |

Used only in the coach's browser, only on the file the coach chose: no network
access (its `UrlSource` is never used), loaded lazily when a video is chosen.

To update: replace the file with the new version's `dist/bundles/mediabunny.min.mjs`
under a new versioned name, update the import in `exercise-media-prepare.js`, this
table (version, URL, SHA-256) and the LICENSE if it changed, and run the browser
harness and the backend real-parser tests (`backend/tests/media-upload-be2.test.mjs`,
fixtures in `backend/tests/fixtures/media/`) before merging.
