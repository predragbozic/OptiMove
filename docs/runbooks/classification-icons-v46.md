# Runbook: migration v46 and the icons of domains and categories (PR-1c, V4)

Contract and as built: section J6.1 of `docs/ai/gpexe-metric-variable-mapping-discovery.md` (C105: the owner decided V4
now; the *Rukovodilac*'s order and decisions of 2026-10-30).

- **v46** (`migrations_v2/202610301300_training_load_v46_classification_icons.sql`) gives a canonical domain and a
  canonical category an icon:
  - `metric_domains.icon_url` and `metric_categories.icon_url`: `null`, or `icon:` and a key's shape, at most 69
    characters (`metric_domains_icon_rule`, `metric_categories_icon_rule`).
  - `metric_classification_changes` gets `old_icon_url` and `new_icon_url` and the kind `icon` for a domain or a
    category. An `icon` row keeps the node active and its name and description, and changes the icon. A create may carry
    its icon; a rename, an archive and a restore keep it; a link's row has none.
  - The node guard lets an icon change alone of an active node through. It refuses an icon changed together with the
    name, the description or the state, and an icon change of an archived node (restore it first).
  - The two record triggers (`metric_domains_v41_record_change`, `metric_categories_v41_record_change`) fire on
    `icon_url` too, and their function writes the two icon values.
  - `metric_classification_requests` gets the operations `domain_icon` and `category_icon`; its guard compares the
    node's icon with the change's.
  - So an update of `icon_url` on a system or club domain or category needs the acting user, its change row and its
    request row in the same transaction, exactly like a rename. Without them the database refuses it (`42501`, or
    `23514` at COMMIT).
  - No table, no index, no row is added or changed.
- **The code** (one release with v46):
  - `POST /api/training-load/sources/metrics/classification/domains/:domainId/icon` and
    `…/classification/categories/:categoryId/icon`
    (`backend/src/canonicalClassificationService.js`, `backend/src/routes/sourceMetrics.js`);
  - an optional `iconKey` on the create of a domain or a category;
  - the icon in every read of a node;
  - in Training Load → Data configuration: the icon field in the create forms, **Change icon** in a node's detail, and
    the icon in the lists, the tiles, the chips, the variables' filter and the start screen's cards.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server, so the new server never meets the schema without v46.

**v46 and the code go together.** Without v46 the new code's reads name a column that does not exist, so the new server
never runs without it (the migrator runs first). While v46 is applied and the old server still serves during the
deploy, the old server has no icon route (`404`) and does not read the icon; its creates, renames, archives and
restores write their change rows as before, with no icon.

Every step that touches the production database is the owner's. The executor prepares the scripts and never runs them
there.

## Before the merge

PR-1b (v45) is merged, deployed and post-checked first. Then, the same day as the merge and deploy of PR-1c:

1. Run `docs/runbooks/classification-icons-v46-preflight.sql` one block at a time. Every value must be the expected one:
   - block 1 shows PostgreSQL 15 or later;
   - block 2 shows v41 and v45 recorded with their checksums, and no v46. If v45 is missing, stop: PR-1b goes first;
   - block 3 shows that the three functions, the two record triggers and the four checks that v46 changes are v41's,
     with every trigger of the four tables enabled;
   - block 4 shows no v46 object;
   - block 5 shows that the migrator's role owns the four tables and the three functions;
   - block 6: no row outside v41's kinds. Record `change_rows` and `request_rows` (the post-check's baseline), and the
     node counts (information only);
   - block 7 shows no actor default;
   - block 8 must show a quiet moment on the four tables.
2. Stop and report on any other value.

The merge needs the owner's order naming the pull request, the exact file
`migrations_v2/202610301300_training_load_v46_classification_icons.sql` and its sha256 (given in the pull request), with
this preflight the same day.

## Deploy order

1. PR-1b's deploy and post-check are done.
2. The owner's preflight, the same day.
3. The owner's order naming the pull request, the v46 file and its sha256.
4. The merge from exactly the reviewed head.
5. The deploy, started by the owner by hand.
6. The *Rukovodilac*'s smoke: without a login, both new routes answer `401`.
7. The owner's post-check.

## After the deploy

1. `/api/health` serves the merge commit with `ok: true`.
2. Before anyone sets an icon, run `docs/runbooks/classification-icons-v46-postcheck.sql` one block at a time:
   - block 1 compares the recorded checksum with the one in the file;
   - block 2 shows the four icon columns as nullable text and the two icon rules validated;
   - block 3 compares the three function bodies by md5, and shows their v46 comments and the two record triggers
     enabled on `icon_url`;
   - block 4 shows the four checks with the icon;
   - block 5: `change_rows` and `request_rows` equal to or above preflight block 6, `unpaired_icon_rows = 0`,
     `icon_changes = icon_requests` (all `0` before anyone used the routes);
   - block 6 shows no actor default and every trigger of the four tables enabled.

## If v46 refuses at deploy

**Lock timeout.** v46 takes `ACCESS EXCLUSIVE` on the four tables, in the order a write takes them: the request record,
the change record, the domains, the categories. While it waits for a lock (up to the runner's 30 s lock timeout), new
reads of domains and categories wait behind it. A long read or write on one of the tables makes v46 fail on the
runner's lock timeout. Nothing of v46 is written (one transaction), the new server does not start, and the old server keeps serving.
1. Check that no session holds a lock on the four tables (block 8 of the preflight).
2. Run the deploy again in a quiet moment.
3. If it fails the same way again, report to the owner. Make no manual change in the database.

**A deadlock (40P01).** One read, a variable's domains and categories (in the old server that still serves during the
deploy, and in the new one), joins the categories before the domains. If that read gets the categories just as v46
holds the domains and waits for the categories, PostgreSQL ends one of the two after a second, with nothing written:
- either the read fails once;
- or v46 fails, and the deploy is run again as for a lock timeout.

The quiet moment of block 8 is what keeps this away.

**A check refuses an existing row.** It cannot happen: the four new columns start empty, which every v41 kind accepts,
and block 6 of the preflight shows no other kind. If it happens anyway, nothing is written; report to the owner.

## When a block of the post-check differs

- **Block 1 or 3:** the recorded file or a function is not the repository's, or a trigger is missing or disabled. Stop
  and report; change nothing. Do not enable or create a trigger by hand.
- **Block 2 or 4:** a column or a check is not v46's. Stop and report; change nothing.
- **Block 5:** a count is below the preflight's, or an icon change has no request (or the reverse). Stop and report
  which. A value above the preflight's is an ordinary create, rename, archive, restore or link between the two checks.

## Rollback

On the owner's approval only, for the database the owner names (`.claude/rules/database-safety.md`):
- after a fresh restore-verified backup;
- with a deployed commit that no longer carries the v46 file (otherwise the migrator applies it again at the next
  start), nor the icon routes or the code that reads the icon.

Run `docs/runbooks/classification-icons-v46-rollback.sql` in a quiet moment as one transaction that stops at the first
error (`psql -v ON_ERROR_STOP=1 -f`; the script carries its own `BEGIN` and `COMMIT`). It refuses, changing nothing:
- while the migrator is running: it takes the migrator's advisory lock for its own transaction, without waiting;
- without v46, or under a later migration;
- once any domain or category has an icon, any change row carries an icon value, or any request is a `domain_icon` or a
  `category_icon`. They are the only record of an icon and of who set it, so from then on the way forward is a new
  migration, never this script;
- while a v46 column is missing or a v46 trigger is disabled.

It takes the four tables' locks before its checks, in v46's order. It restores v41's three functions (byte for byte,
without a comment), its two record triggers and its four checks. It drops the four icon columns, with their two rules,
and removes the v46 record. After it, the catalog before v46 comes back exactly, and v46 can be applied again.

## Using the routes

- `POST …/classification/domains/:domainId/icon` and `POST …/classification/categories/:categoryId/icon`, with the body
  `{ requestKey, expectedIconKey, iconKey }`:
  - `iconKey` is a key of the icon library, or `null` for no icon;
  - `expectedIconKey` is the key the caller saw (`null` for none).
- **Who:** the callers of a rename of the same node:
  - a system domain or category: an active platform admin in the platform workspace;
  - a club's domain or category: an active platform admin or the active admin of that club, in the club's workspace.
- **Refusals:**
  - `409 node_not_active`;
  - `409 node_changed` (another icon is stored; the answer carries the current node);
  - `409 icon_unchanged`;
  - `400 invalid_body` for a key outside the library;
  - the identical `404` for everyone else.
- **Create:** a create of a domain or a category may carry `iconKey` (a library key or `null`). A create without it is
  the create of before, and its replay matches as before.
- **A lost answer** is repeated with the same `requestKey`. The same request replays the current state and never writes
  twice. A key used with another body is `409 request_key_reused`.
