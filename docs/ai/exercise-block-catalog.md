# Exercise blocks: catalog and discovery

## Reused architecture

Application blocks remain `library.exercise_collections`, existing system-exercise membership and explicit user grants. An exercise still belongs to at most one application block. Private copies remain owned, retain provenance, and require access to the canonical source. Collections are not program templates and no exercise or program copies are created by browsing, selecting or assigning a block.

Administration still requires a real platform-admin role in the selected platform workspace. Everyone else receives only authorized content, or deliberately configured discovery previews. Existing collection revisions, audit records, shared reuse/exclusive grant mutation guards, access-change realtime invalidation and UNIQUE indexes are retained.

## Added behavior

- Blocks button in Exercise Library opens template-style package cards. All exercises returns the ordinary library; opening an available block uses the same list, search, filters and existing view modes with a server-side block predicate.
- Other is a virtual group of accessible exercises whose canonical original belongs to no application block. It never grants access to unassigned restricted exercises and is not stored as a collection. Existing private source copies are grouped by their canonical original.
- Card cover uses an explicit HTTP(S) image URL, otherwise the first visible active original in alphabetical name/ID order. Missing first-image data produces a placeholder. A locked block never falls back to restricted exercise media; only the administrator's explicitly supplied presentation cover may be shown.
- Editor adds description, cover URL and staged checkbox selection with Add selected. Pending choices survive searches; selections only persist after Save. Conflicting membership is still rejected transactionally. Exercise removal from a block is not exercise deletion. No new order editor was introduced; the existing alphabetical membership order is retained.
- Assign uses existing selected-user grants, or explicit all-users access (including future authorized application users). Existing selections are retained while everyone is enabled. Legacy PATCH clients that omit new fields preserve their current values.
- Administrator configures block discovery and exercise discovery separately: hidden, or locked. Both default to hidden, including on existing blocks. Locked block cards expose presentation metadata/counts; locked exercise previews expose only ID/name and an explicitly visible block name (null for a hidden block), never instruction/video/image URLs, editable detail or reusable exercise objects. They cannot be copied, tagged, played or inserted through those previews. Real read/reuse/copy ACL still denies direct requests.
- Ordinary exercise search returns authorized exercises and a separate locked-preview list in the same response; no additional frontend search request or breaking cache/parallel-start behavior. Previews are name matches, shown for active/unhidden system browsing without personal/classification/owner filters, not Favorites/Marked/private/archive result substitutes.
- Access-required text directs the user to the administrator. This change does not send access-request notifications, implement payments, publish a marketplace, import a paid package or grant access automatically.

## Migration and release

`202610162230_exercise_block_catalog.sql` only adds five metadata columns to existing collections: description, cover_image_url, access_all, block_preview, exercise_preview. Defaults preserve existing restrictions; there are no new tables, changed memberships, deleted records, FK/UNIQUE changes or program/media rewrites. Migration uses the repository's existing migrations_v2 runner and must run before the new backend starts. Normal brief ALTER TABLE locks remain a deployment consideration; the official local migration runner is covered by a populated preservation test. No database rollback should be automatic.

An older application ignores discovery metadata and all-users access; application rollback would hide newly public content from users lacking individual grants, rather than grant additional access. Leave additive columns in place. No production schema or data writes, merge, deployment, backup or restore are authorized by this implementation.
