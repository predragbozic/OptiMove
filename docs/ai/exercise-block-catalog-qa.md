# PR #175: pre-merge UX polish and QA

## Existing behavior retained

The approved `f967f5b` already provides per-block cover URLs, source-image fallback for authorized users, neutral placeholders, system-admin management, selected/all-user assignments and separate Hidden/Locked discovery settings. Locked blocks may expose an explicitly configured presentation cover but never derive one from inaccessible exercise media. Locked exercise previews have no usable exercise controls or media/instructions. Source-copy ACL and revocation remain server enforced.

## Frontend-only changes

- Contain the complete cover image inside a centered 16:10 frame instead of cropping its edges. This fixes the clipped MOVEMENT LIBRARY example and supports both landscape and portrait artwork without an upload mechanism.
- Use readable Carbon-profile foregrounds and an outlined SVG lock badge. Only the locked cover is grayscale; text is not faded.
- Add Remove cover, which clears the URL, focuses the input and persists an explicit empty string on Save. Existing exercise-image/placeholder fallback then applies. Entering a replacement URL retains the current membership and access configuration.
- Fix confirmed mobile editor overflow: generic input sizing made selection checkboxes too wide. Give these checkboxes an explicit 18px width and allow long selection labels/buttons to wrap.

No backend, schema or migration file changes are part of this polish. The PR's original additive five-column migration and its startup ordering/brief table-lock considerations remain unchanged. No production requests, writes, migrations, Render changes, merge or deployment were performed.

## Visual and functional checks

Local browser QA uses synthetic data, actual frontend rendering/navigation/editor code and isolated mock API responses, not a production session. Desktop 1440px: four columns; tablet 768px: two columns; mobile 390px and 320px: one column. No horizontal page overflow. The mobile editor has no overflowing container after the checkbox fix; long URLs scroll inside their own input normally.

Checked distinct covers, the full MOVEMENT LIBRARY label, portrait fitting, exercise-image fallback, placeholder, locked badge, absence of ordinary-user admin actions, Blocks/All exercises/Other navigation, selected-user staging and all-user/Locked controls. Automated UI tests exercise cover add/replace/remove with Save payloads, unchanged membership/grants, and available → locked → hidden refresh removing the previously available image and actions. Existing real-API regressions cover source-copy access after grant revocation, denied direct requests, hidden metadata and program/Builder access.

Screenshots are local QA artifacts: PR175-polish-desktop.png, PR175-polish-tablet.png, PR175-polish-mobile.png and PR175-polish-mobile-locked.png. See the PR description for final test counts and candidate SHA. Tests should be run from a clean archive of the candidate so unrelated uncommitted workspace edits are not shipped or counted as the PR state.
