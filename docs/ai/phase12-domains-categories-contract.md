# J6 — phase 12: domains and categories of canonical variables (accepted contract, C101)

**Accepted on 2026-10-28 (C101 of the discovery document), as the *Rukovodilac* reads the owner's words; not
implemented.** This is phase 12's discovery delta and contract (`docs/ai/metrics-core-plan.md`, phase 12 ★). It extends
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*). The gate of phase 12 is this
document first, then the implementation, after the owner's decisions below.

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-28, on the *Rukovodilac*'s order of that day; revised the same day after the *Rukovodilac*'s review of `565a954` (two MEDIUM, four LOW, applied in this text). No code, no migration. The *Rukovodilac* gave GO on the proposal at `5b9ee9d`. **Accepted on 2026-10-28:** O1–O9 as proposed, as the *Rukovodilac* reads the owner's words (C101); the owner's read-only count of section 6 found no row in the three tables. |
| Last verified against commit | `d96936c` (merge of PR #242): `290b6cf..d96936c` changed only four documents (the plan, `CURRENT_STATE.md`, the discovery document and the v39 contract), none of the files section 1 names, which were verified at `290b6cf` (merge of PR #241). |
| Owner's words | 2026-10-27, owner turn `655fc5c6` in the *Rukovodilac*'s chat (quoted in the plan, phase 12): variables should be linkable with categories or domains, on the structure the database already has, because fitness may later be defined per domain or category (endurance, speed and the like). |

## 1. What exists (discovery delta, verified at `290b6cf`)

### 1.1 The schema (v10, `migrations_v2/202609041400_training_load_v10_metrics_catalog.sql`)
- `training_load.metric_domains` (:57) and `metric_categories` (:78), with the same shape:
  - `id`, `name` (text, no length or text rule), and the four owner columns (`system` / `club` / `team` /
    `user`, exactly one id);
  - `is_active`, `created_by_user_id`, `created_at`, `updated_at`.
  - There is no key, short name, description, hierarchy column, request record, change log or database actor check.
- `training_load.metric_structure_links` (:196) is a classification link with its own owner:
  - any non-empty combination of `domain_id`, `category_id` and `metric_definition_id`, each `on delete cascade`;
  - `temporal_smoothing_enabled`, a property of how the variable is viewed in that context (header :37-41);
  - unique `nulls not distinct` per owner and triple (:217);
  - the same definition may sit under several links (header :33-36).
- `validate_structure_link_scope_breadth()` and its trigger (:246-280) keep a link's owner inside each target's,
  through `link_scope_within_target()` (:232):
  - a `user` link may point at anything;
  - a `club` link may point at `system` targets and at targets of the same club;
  - a `system` link may point only at `system` targets.
- No later migration touches the three tables (`grep` over `migrations_v2`).

### 1.2 The older API (`/api/training-load/metrics`, `backend/src/routes/trainingLoadMetrics.js`)
- **Routes:**
  - `GET` / `POST /domains` (:182, :191) and `POST /domains/:id/archive` (:205);
  - the same three for `/categories` (:217, :226, :240);
  - `GET` / `POST /structure-links` (:391, :403) and `DELETE /structure-links/:id` (:418).
- **The service, `backend/src/trainingLoadMetricsCatalog.js`:**
  - `createNode` (:77) trims the name and inserts it under the owner the client asked for;
  - `archiveNode` (:90) sets `is_active = false`. Nothing renames or restores a node;
  - `createStructureLink` (:577) needs only *read* visibility of each target (:583-597, "classification, not a
    security boundary");
  - `deleteStructureLink` (:616) deletes the row.
- **Ownership** comes from the client: `resolveCatalogOwnerScope` (`backend/src/trainingLoadMetricsAccess.js:78`).
  - `system` only for a platform admin;
  - `club` for a manager of that club (`canManageClub`);
  - `team` for a manager of that team;
  - `user` by default.
- **Visibility** is `catalogVisibilitySql` (:116):
  - `system` rows are visible to everyone;
  - `club` rows only to that club's **club admins**: a team coach of the club does not see them;
  - `team` rows to that team's coaches;
  - `user` rows to their owner.
- **C98 (PR #219) left these routes unchanged:**
  - creating domains, categories and links stays open for every owner, `system` and `club` included;
  - only the archive and the delete answer the identical `404` to a caller who may not manage the row (A6 of the
    discovery document).
- **Nothing is recorded:** no request record, no acting-user check in the database, and no change log for any of
  the three tables.

### 1.3 Who reads them today
- **The Activities "Choose metrics" picker:** `frontend/training-load-calendar-data.js:352-382`.
  - It reads the three older GET routes and groups each definition under the name of its **first** link's domain,
    or else its category (`domainLabel`).
  - `frontend/training-load-calendar-view.js:558` shows the groups, "Other" when there is no link.
- **The dashboard (Analysis) metric pickers:** `frontend/training-load-analysis-data.js:1537-1548`.
  - They read the same three routes and carry `domainLabel` / `categoryLabel` per link.
  - `frontend/training-load-analysis-view.js:627-630` and `:754-778` group by them and show them, "Other metrics"
    or "Other" when there is none.
- **`GET /results` filters** by `domainId` / `categoryId` (`backend/src/trainingLoadMetricsMeasurements.js:1027-1072`).
  The filter re-checks the visibility of every link target.
- **Nothing in the M3-0 / R2 API** (`backend/src/canonicalVariableAdminService.js`, `/api/training-load/sources/metrics`)
  or in the Variables tab (`frontend/metric-variables-*.js`) reads or writes the three tables.

So a link written today shows up in the pickers' grouping at once, for every viewer who may see both the link and
its target. The pickers stay unchanged as code (C80). Their grouping is data.

Both pickers group a variable under its **first** visible link only: each skips every later link of the same
definition (`frontend/training-load-calendar-data.js:368`, `frontend/training-load-analysis-data.js:1546`). So a variable in several categories or domains
(O3) still shows under one group in the pickers. The other links are kept and used by the Variables tab and by
`/results`. This is a property of the data, not a code change; the owner should know it before deciding O3.

### 1.4 Production (the owner's read-only count, 2026-10-28)
The owner ran the four queries of section 6 and reported, verbatim, „Success. No rows returned za prva dve provre,
treća categories_with_several_domains 0, canonical_triples 0“ (C101). So on production:
- `metric_domains`, `metric_categories` and `metric_structure_links` hold **no row** of any owner (`system`, `club`,
  `team` or `user`): the first query groups the three tables and returned nothing;
- no link points at any variable (the second query);
- no canonical category has two domains, and no canonical link names all three ids (both 0).

The older API was never used for these tables on production. v41 meets no legacy row (O9).

## 2. The goal

The owner's need, as quoted above: an administrator links canonical variables (`system` and `club`, C98) with
categories and domains on the v10 structure. Later, phase 11 may define "fitness per domain or category" on them.

The goal implies three things:
- the classification of a canonical variable is governed like the variable itself, through the M3-0 admin API with a
  request record, an acting user and a database guard (C76). This is not the older API's open create;
- the domains and categories of the canonical owners get a stable identity that phase 11 can refer to (O5);
- the coaches' own classification (`team` / `user` rows) stays as it is.

## 3. The contract

### 3.1 Objects
- **A domain** and **a category** owned by `system` or by a club. Each has:
  - a name (the C53 / Q10 text rule; at most 80 characters, M3-0's label limit, `TEXT_LIMITS.label`);
  - an optional description (at most 500);
  - a key (O5);
  - a state (`is_active`).

  A domain or category is renamed, archived and restored, never deleted.
- **Three link shapes**, all rows of `metric_structure_links` with a canonical owner:
  - **variable → category** (`domain_id` null);
  - **variable → domain** (`category_id` null);
  - **category → domain** (`metric_definition_id` null).

  The new API never writes a link with all three ids. Such a row, written by the older API, is read as it is (O2).
- **`temporal_smoothing_enabled`** stays `false` on every link the new API writes. It is not part of phase 12.

### 3.2 Routes (under `/api/training-load/sources/metrics`, the M3-0 prefix and its access)
| # | Route | What it does |
|---|---|---|
| C1 | `GET /classification` | the root: the domains and categories of the workspace's owner (in a club workspace also the `system` ones, read-only), with their state and the category → domain links |
| C2 | `POST /classification/domains`, `POST /classification/categories` | create (`requestKey`, `name`, optional `description`, `key` or the suggested key) |
| C3 | `POST /classification/domains/:id/rename`, `…/archive`, `…/restore` and the same for categories | as R2's three acts on a variable (J3b), with `reason` for archive |
| C4 | `POST /classification/links` | create one link of the three shapes (`requestKey`, two of `variableId`, `categoryId`, `domainId`) |
| C5 | `POST /classification/links/:id/remove` | remove one link (`requestKey`, optional `reason`) |
| C6 | `GET /variables?domainId=…&categoryId=…` and the variable detail | the existing list filtered by a domain or a category, and a variable's links in its detail |

Everything new sits under `/classification`, beside `/mappings`, `/fields` and `/variables`; only C6 extends the
existing variable reads.

- **Access, the identical `404` and the request record** follow the M3-0 / R2 contract (J3, J3b):
  - the owner always comes from the active workspace;
  - the body never names an owner, actor or basis;
  - every write takes a `requestKey`, keeps its request record, uses a bounded transaction and a bounded COMMIT,
    and answers `try_again` / `outcome_unknown` as in J1.
- **Archiving a domain or category** keeps its links. They are shown as archived, and no new link may point at an
  archived node (`409 node_archived`).
- **Removing a link** deletes its row. The request record / change row keeps the link's full content (O6).

### 3.3 The database (migration v41, its own order)
- **Columns:** a `key` and a `description` on `metric_domains` and `metric_categories` (O5).
- **A request record and a change log** for the classification writes, the v36 / v38 pattern (O6). This is either a
  new table, or new operations on `metric_variable_requests`.
- **Actor guards (C76).** Every INSERT, UPDATE or DELETE on the three tables whose row has a canonical owner
  (`system` or `club`) needs four things in the same transaction (deferred link):
  - the v35 acting user;
  - the right: an active platform admin for `system`, that club's active admin or a platform admin for `club`;
  - the derived basis;
  - its request row.

  This is also C98's database twin for classification: the older API, which sets no acting user, can no longer
  write a canonical row (O7). `team` and `user` rows stay outside the guard.
- **Removing a link: the order of writes.** A DELETE leaves no row behind for a deferred check to read. So the
  change row that carries the removed link's full content (its ids, owner and `temporal_smoothing_enabled`) is
  written **before** the DELETE, in the same transaction. The DELETE's guard then requires that change row: same
  link id, kind `link_remove`, the same acting user, this transaction (`xmin`). The request row follows, keyed, last.
  12b builds exactly this order.
- **Text rule (the v38 pattern, not a CHECK).** A CHECK added by v41 would be validated against every existing row,
  so a legacy `system` / `club` name the rule refuses would make v41 fail. `NOT VALID` would only half solve it.
  Instead, the guard trigger applies `source_metric_text_ok()`:
  - on an INSERT, to the name (80) and the description (500);
  - on a rename, only to a value that changes. A value left as it was is exempt, as in v38 (a legacy name stays
    until it is renamed).

  The new `key` and `description` columns are empty when v41 adds them. v41 still ends with a fail-closed count, as
  v40 does, over those columns of the canonical rows, in case anything wrote them between the preflight and the
  migration.
- **One domain per canonical category (O3).** A partial unique index on `category_id` where
  `metric_definition_id is null and domain_id is not null and owner_scope in ('system', 'club')`. It allows at most one
  domain per category whoever owns the domain, so a club category under a `system` domain (O4) counts. `team` and
  `user` links stay outside the index. If the count of section 6 finds a canonical category with two or more domains
  already, the index cannot be created: the owner decides which link stays before v41, and v41's preflight refuses
  until then.
- **Owner breadth:** v10's trigger stays as it is, and O4 decides the cross-owner shapes.
- **Rollback, read-only preflight and post-check**, as for v38 and v39.

### 3.4 The frontend (phase 12c)
In Training Load → Data configuration → Variables (C80):
- a "Domains & categories" section to create, rename, archive and restore domains and categories;
- link and remove a category under a domain;
- in a variable's detail, its categories and domains with link and remove;
- a domain or category filter in the list.

Reviewers: `code-reviewer`, `mobile-qa`, `ux-design-reviewer` (the `CLAUDE.md` matrix).

### 3.5 The older API (O7)
For a `system` or `club` domain, category or link, the older create, archive and delete answer
`409 canonical_classification_read_only`, after the existing right check and the identical `404`. This is C98's
service-level rule, with the text naming Training Load > Data configuration. `team` and `user` rows and every read are
unchanged.

## 4. Owner decisions (C101: each accepted as proposed)

Each decision below was accepted as its proposal reads, as the *Rukovodilac* reads the owner's words (C101). Where
the text gives an alternative, the alternative was not chosen.
- **O1, who.**
  - Proposal:
    - the same admins as M3-0: an active platform admin in the platform workspace (`system`) or in a club's
      workspace (`club`), and the club's active admin in its own workspace;
    - a team coach sees the club's domains and categories read-only in the Variables tab (R2's reduced view) and
      does not link (R2's rights are rename, archive and restore of a variable only).
  - Granting coaches the link would be a new right, and the *Nezavisni revizor* would then review the contract (the
    plan, phase 12).
- **O2, the link shapes.**
  - Proposal: the three shapes of 3.1; the new API never writes a triple.
  - An existing triple (a variable under a category within a domain) is read as both a variable → category and a
    category → domain fact, and is removed only as a whole.
- **O3, how many.**
  - Proposal:
    - a variable may sit under several categories and several domains (the owner's example: one variable can serve
      endurance and speed);
    - a canonical category sits under at most one domain, whoever owns the domain (a club category under a `system`
      domain counts, O4), so the canonical classification is a tree (domain → category). The database gets this as
      the partial unique index of 3.3 (v41).
    - The pickers still group a variable under its first link only (1.3).
  - Alternative: several domains per category (no index).
- **O4, across owners.**
  - Proposal, all allowed by v10's breadth trigger:
    - a club may link its own variables and the `system` variables into its own categories and domains;
    - a club may link its own categories under a `system` domain;
    - `system` links point only at `system` targets.
  - A club never links into another club (v10 refuses it).
- **O5, the key.**
  - Proposal:
    - a stable key on domains and categories (M3-0's key rule, unique per owner, never changed), so phase 11 can name
      a domain or category in a formula without depending on its name;
    - rows written before v41 keep a NULL key until an admin gives one: an act that sets the key once, the only
      change of a key.
  - Alternative: no key (phase 11 would refer to the id).
- **O6, the record of a change.**
  - Proposal: the v38 pattern. A request row per write and an append-only change row per rename, archive, restore,
    link and remove, with the actor, the basis, the reason and the link's content.
  - The rows go in new tables `metric_classification_requests` / `metric_classification_changes`, not in
    `metric_variable_requests`, whose rows name a variable.
- **O7, the older API.**
  - Proposal:
    - C98's rule for the canonical owners (3.5), in the service and in v41's guard;
    - the older reads, and therefore the pickers' grouping, stay;
    - `team` and `user` classification stays open to their owners.
- **O8, the pickers and the coaches' view.**
  - Today a club's domains and categories are visible in the older reads to its club admins only
    (`catalogVisibilitySql`), so a team coach's picker groups a club variable under "Other".
  - Proposal: leave it in phase 12 and record it as a follow-up. Widening the older visibility is a read-contract
    change across the pickers and `/results` (C80 keeps the pickers as they are).
  - Alternative: show the club's canonical domains and categories to the club's team coaches in the older reads too.
- **O9, existing rows.**
  - Proposal: before the contract is accepted, the owner's read-only count (section 6) shows what exists.
  - If `system` or `club` rows exist:
    - they stay readable and become the new API's rows, with a NULL key (O5);
    - their names are not re-checked by the text rule until renamed (the trigger of 3.3, the v38 pattern), so a
      legacy name never makes v41 fail;
    - a canonical category with two or more domains blocks the index of 3.3: the owner decides which link stays
      before v41.
  - A legacy name the text rule would refuse is shown by v41's preflight as information; it is corrected only by a
    rename.
  - **The count's result (1.4):** no row exists, so these branches are empty. v41's preflight still checks that the
    three tables hold no canonical row it would meet, and stops if one appeared after the count.

## 5. Out of scope
- Phase 11 (derived variables, fitness per domain or category). This contract only gives it a stable key (O5).
- `temporal_smoothing_enabled` and any change to how the pickers group (C80, O8).
- `team` and `user` domains, categories and links.
- Deleting a domain or category. A link is removed; a node is archived.
- The zone model (C89), the source fields and mappings (phases 6–8).

## 6. The owner's read-only count before acceptance (red zone; Supabase SQL Editor; done 2026-10-28, see 1.4)
```sql
begin transaction read only;
select 'domains' as t, owner_scope, is_active, count(*) from training_load.metric_domains group by 2, 3
union all
select 'categories', owner_scope, is_active, count(*) from training_load.metric_categories group by 2, 3
union all
select 'links', owner_scope, null, count(*) from training_load.metric_structure_links group by 2
order by 1, 2, 3;
select l.owner_scope as link_owner, d.owner_scope as variable_owner, count(*)
  from training_load.metric_structure_links l
  join training_load.metric_definitions d on d.id = l.metric_definition_id
 group by 1, 2 order by 1, 2;
-- Canonical categories with more than one domain (they would block the index of 3.3, O3).
select count(*) as categories_with_several_domains
  from (select category_id from training_load.metric_structure_links
         where metric_definition_id is null and domain_id is not null and category_id is not null
           and owner_scope in ('system', 'club')
         group by category_id having count(*) > 1) x;
-- Canonical links that name all three ids (O2).
select count(*) as canonical_triples
  from training_load.metric_structure_links
 where domain_id is not null and category_id is not null and metric_definition_id is not null
   and owner_scope in ('system', 'club');
rollback;
```
It returns counts only, no names. Expected: no `system` or `club` rows, if the older API was never used for them; so
the last two counts are 0. **Result (2026-10-28):** the first two queries returned no rows, and the last two returned 0
(1.4, C101).

## 7. Split and gates
- **12a:** this contract (docs only). The *Rukovodilac*'s review, the owner's decisions O1–O9 and the count of
  section 6 are done (C101).
- **12b:** the backend and migration v41.
  - Reviewers: `db-reviewer`, `security-reviewer`, `code-reviewer` and the *Rukovodilac* (triggers 1 and 2). Add the
    *Nezavisni revizor* if O1 or O4 gives a new right. As accepted they give none (a team coach stays read-only),
    so the *Nezavisni revizor* is not needed.
  - The merge needs the owner's order naming v41, after its preflight; the post-check follows the deploy.
- **12c:** the frontend.
  - Reviewers: `code-reviewer`, `mobile-qa` and `ux-design-reviewer`.
  - It is merged under the standing order after the *Rukovodilac*'s GO.

## 8. Tests (for 12b and 12c)
- **v41:** the rehearsal (apply → rollback → identical catalog → re-apply), and mutations of every guard.
- **The actor guard:** the older API's insert of a `system` or `club` row is refused at the database; `team` and
  `user` rows still pass.
- **Access:** the identical `404` matrix of J3 for every route; a team coach is read-only (O1).
- **The request record:** a replay, `request_key_reused`, and the COMMIT outcome (`verified_after_commit_error`,
  `outcome_unknown`).
- **O3's tree:** a canonical category under a second domain, whoever owns that domain, is refused, in both the service
  and the database.
- **O4:** the cross-owner shapes are allowed, and another club's targets are refused.
- **The pickers' grouping** of the Activities and dashboard pickers is unchanged as code, and shows a new link
  (frontend test).
- **12c:** browser QA at 360, 375 and 390 px, and at 1280 px.
