import { Router } from "express";
import { query } from "../db.js";

const router = Router();

// feature/athlete-programs-profile: a narrow, self-only profile endpoint.
// Athlete resolution mirrors athleteHome.js exactly - req.authz.athleteId is
// the real public.athletes.id linked via athletes.user_id = the
// authenticated account (loaded once per request in backend/src/authz.js).
// This route never reads an athleteId from a route param, query string, or
// request body, so there is no way for one account's session to ever read
// or write a DIFFERENT athlete's profile - this holds identically for an
// athlete-only account and for a multi-role account currently in the
// athlete workspace, since authz.athleteId is computed the same way for
// both (see authz.js's own comment on that query).
//
// Only public.athletes columns that are BOTH real (confirmed via
// information_schema against the live dev DB) AND already actively read/
// written elsewhere in the app - OR explicitly requested for this second
// pass after being re-audited - are exposed here: first_name, last_name,
// image_url, birth_date, phone, country, city. display_name is kept equal
// to the derived full name, exactly mirroring the existing coach-side PUT
// /api/organization/athletes/:id (see splitName()/display_name = full_name
// there) - no consumer anywhere reads display_name as something that could
// diverge from full_name, so there is nothing to keep in sync beyond that.
//
// Explicitly NOT exposed, on purpose: athlete_id/source_external_id/user_id
// (internal identifiers), club_id/team_id (membership, not profile),
// is_active (login/roster status), gender/address_line (real columns, but
// still confirmed to have zero consumers anywhere in the app - unlike
// birth_date/phone/country/city, which this pass adds), a cover-image
// field (no such column exists on public.athletes at all), and
// athletes.email (a real but entirely dead column, never read or written
// anywhere in this codebase - not surfaced as a "contact email" field).
// users.email (login email), users.password_hash, role/workspace/
// membership data are on a completely different table and this route
// never touches public.users at all.
router.get("/", async (req, res, next) => {
  try {
    const athleteId = req.authz?.athleteId;
    if (!athleteId) return res.status(403).json({ error: "NO_ATHLETE_PROFILE" });

    const result = await query(
      `select first_name, last_name, image_url, birth_date, phone, country, city
       from public.athletes
       where id = $1
       limit 1`,
      [athleteId],
    );
    const row = result.rows[0];
    if (!row) return res.status(403).json({ error: "NO_ATHLETE_PROFILE" });

    res.json(serializeProfileRow(row));
  } catch (error) {
    next(error);
  }
});

function serializeProfileRow(row) {
  return {
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    imageUrl: row.image_url || "",
    birthDate: row.birth_date || "",
    phone: row.phone || "",
    country: row.country || "",
    city: row.city || "",
  };
}

const ALLOWED_FIELDS = new Set(["firstName", "lastName", "imageUrl", "birthDate", "phone", "country", "city"]);

// Real column limits, confirmed via information_schema against the live
// dev DB before writing this (not assumed):
//   public.athletes.first_name/last_name  varchar(100)
//   public.athletes.country/city          varchar(100)
//   public.athletes.phone                 varchar(50)
//   public.athletes.image_url             text (no DB limit - MAX_URL_LENGTH
//                                          below is an app-level sanity cap)
//   public.athletes.full_name/display_name varchar(220) - first+' '+last at
//                                          100+1+100=201 chars fits with room
//                                          to spare, so no truncation risk.
const MAX_NAME_LENGTH = 100;
const MAX_URL_LENGTH = 2000;
const MAX_PHONE_LENGTH = 50;
const MAX_COUNTRY_LENGTH = 100;
const MAX_CITY_LENGTH = 100;

function todayIsoUtc() {
  return new Date().toISOString().slice(0, 10);
}

function isValidIsoDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  // Date silently rolls over invalid calendar dates (e.g. Feb 30 -> Mar 2) -
  // a failed round-trip is how an actually-invalid date gets caught.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Validates every provided field UP FRONT and returns either
// { errors: [...] } or { values: {...} } - the route handler never issues
// an UPDATE unless every provided field passed, so a bad field can never
// cause a partial write. `values` only ever contains keys for fields that
// were actually present in the request body (used as the per-field
// "provided" flags in the single atomic UPDATE below) - "" or null in
// `values` means "explicitly clear this field", absence means "leave
// untouched".
function validatePatchBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { errors: ["Request body must be an object."] };
  }

  const unknownFields = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknownFields.length) {
    return { errors: unknownFields.map((key) => `Unknown or forbidden field: ${key}`) };
  }
  if (!Object.keys(body).length) {
    return { errors: ["No fields to update."] };
  }

  const errors = [];
  const values = {};

  if ("firstName" in body) {
    const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
    if (!firstName) errors.push("First name is required.");
    else if (firstName.length > MAX_NAME_LENGTH) errors.push(`First name must be ${MAX_NAME_LENGTH} characters or fewer.`);
    else values.firstName = firstName;
  }

  if ("lastName" in body) {
    const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";
    if (lastName.length > MAX_NAME_LENGTH) errors.push(`Last name must be ${MAX_NAME_LENGTH} characters or fewer.`);
    else values.lastName = lastName;
  }

  if ("imageUrl" in body) {
    const raw = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
    if (!raw) {
      values.imageUrl = "";
    } else if (raw.length > MAX_URL_LENGTH) {
      errors.push(`Photo URL must be ${MAX_URL_LENGTH} characters or fewer.`);
    } else {
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          errors.push("Photo URL must start with http:// or https://.");
        } else {
          values.imageUrl = raw;
        }
      } catch {
        errors.push("Photo URL must be a valid URL.");
      }
    }
  }

  if ("birthDate" in body) {
    const raw = typeof body.birthDate === "string" ? body.birthDate.trim() : "";
    if (!raw) {
      values.birthDate = null;
    } else if (!isValidIsoDateString(raw)) {
      errors.push("Date of birth must be a valid date (YYYY-MM-DD).");
    } else if (raw > todayIsoUtc()) {
      errors.push("Date of birth cannot be in the future.");
    } else {
      values.birthDate = raw;
    }
  }

  if ("phone" in body) {
    // Deliberately no format/pattern requirement - real phone numbers vary
    // far too much by country to validate against a single shape here.
    const raw = typeof body.phone === "string" ? body.phone.trim() : "";
    if (raw.length > MAX_PHONE_LENGTH) errors.push(`Phone must be ${MAX_PHONE_LENGTH} characters or fewer.`);
    else values.phone = raw;
  }

  if ("country" in body) {
    const raw = typeof body.country === "string" ? body.country.trim() : "";
    if (raw.length > MAX_COUNTRY_LENGTH) errors.push(`Country must be ${MAX_COUNTRY_LENGTH} characters or fewer.`);
    else values.country = raw;
  }

  if ("city" in body) {
    const raw = typeof body.city === "string" ? body.city.trim() : "";
    if (raw.length > MAX_CITY_LENGTH) errors.push(`City must be ${MAX_CITY_LENGTH} characters or fewer.`);
    else values.city = raw;
  }

  if (errors.length) return { errors };
  return { values };
}

router.patch("/", async (req, res, next) => {
  try {
    const athleteId = req.authz?.athleteId;
    if (!athleteId) return res.status(403).json({ error: "NO_ATHLETE_PROFILE" });

    const { errors, values } = validatePatchBody(req.body);
    if (errors) return res.status(400).json({ error: errors[0], errors });

    // Single atomic UPDATE - no prior SELECT, no "read everything then
    // write everything" round trip. Every SET expression below is a `case
    // when <field was provided> then <new value> else <the row's OWN
    // current column> end`, so a field that wasn't in this request is left
    // completely untouched by referencing the table's current value
    // directly in SQL, not a value read into JS earlier in the request.
    // Postgres serializes concurrent UPDATEs to the same row via its
    // normal row lock: if two partial PATCHes for DIFFERENT fields run at
    // the same time, whichever commits second re-evaluates its `else
    // column` branches against the row as it exists AFTER the first one's
    // commit - so neither request can ever revert the other's change (the
    // exact "SELECT-then-UPDATE" lost-update race the old version of this
    // route had, before display_name/full_name were also recomputed from
    // the row's own live columns rather than a JS-cached snapshot).
    const result = await query(
      `update public.athletes
       set first_name = case when $2 then $3 else first_name end,
           last_name = case when $4 then $5 else last_name end,
           full_name = trim(concat_ws(' ',
             case when $2 then $3 else first_name end,
             case when $4 then $5 else last_name end
           )),
           display_name = trim(concat_ws(' ',
             case when $2 then $3 else first_name end,
             case when $4 then $5 else last_name end
           )),
           image_url = case when $6 then nullif($7, '') else image_url end,
           birth_date = case when $8 then $9::date else birth_date end,
           phone = case when $10 then nullif($11, '') else phone end,
           country = case when $12 then nullif($13, '') else country end,
           city = case when $14 then nullif($15, '') else city end,
           updated_at = now()
       where id = $1
       returning first_name, last_name, image_url, birth_date, phone, country, city`,
      [
        athleteId,
        "firstName" in values, values.firstName ?? null,
        "lastName" in values, values.lastName ?? null,
        "imageUrl" in values, values.imageUrl ?? null,
        "birthDate" in values, values.birthDate ?? null,
        "phone" in values, values.phone ?? null,
        "country" in values, values.country ?? null,
        "city" in values, values.city ?? null,
      ],
    );
    if (!result.rows[0]) return res.status(403).json({ error: "NO_ATHLETE_PROFILE" });

    res.json(serializeProfileRow(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

export default router;
