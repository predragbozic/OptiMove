-- Adds an optional custom name to plans.plan_sessions - additive to the
-- existing AM/PM + Before/Training/After classification (am_pm/bta), never
-- a replacement for it (see backend/src/routes/builder.js's session
-- create/update/copy call sites and frontend/builder-helpers.js's
-- sessionLabel(), which renders the name as an extra line ABOVE the
-- existing badge line, not instead of it).
alter table plans.plan_sessions add column if not exists name character varying(120);
