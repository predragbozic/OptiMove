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
// written elsewhere in the app are exposed here: first_name, last_name,
// image_url. display_name is kept equal to the derived full name, exactly
// mirroring the existing coach-side PUT /api/organization/athletes/:id
// (see splitName()/display_name = full_name there) - no consumer anywhere
// reads display_name as something that could diverge from full_name, so
// there is nothing to keep in sync beyond that.
//
// Explicitly NOT exposed, on purpose: athlete_id/source_external_id/user_id
// (internal identifiers), club_id/team_id (membership, not profile),
// is_active (login/roster status), birth_date/phone/gender/country/city/
// address_line (real columns but confirmed to have zero consumers anywhere
// in the app today - see the audit for this branch), and athletes.email
// (a real but entirely dead column, never read or written anywhere in this
// codebase - not surfaced as a "contact email" field). users.email
// (login email), users.password_hash, role/workspace/membership data are
// on a completely different table and this route never touches
// public.users at all.
router.get("/", async (req, res, next) => {
  try {
    const athleteId = req.authz?.athleteId;
    if (!athleteId) return res.status(403).json({ error: "NO_ATHLETE_PROFILE" });

    const result = await query(
      `select first_name, last_name, image_url
       from public.athletes
       where id = $1
       limit 1`,
      [athleteId],
    );
    const row = result.rows[0];
    if (!row) return res.status(403).json({ error: "NO_ATHLETE_PROFILE" });

    res.json({
      firstName: row.first_name || "",
      lastName: row.last_name || "",
      imageUrl: row.image_url || "",
    });
  } catch (error) {
    next(error);
  }
});

const ALLOWED_FIELDS = new Set(["firstName", "lastName", "imageUrl"]);
const MAX_NAME_LENGTH = 80;
const MAX_URL_LENGTH = 2000;

// Validates every provided field UP FRONT and returns either
// { errors: [...] } or { values: {...} } - the route handler never issues
// an UPDATE unless every provided field passed, so a bad field can never
// cause a partial write (see the route handler below).
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

  if (errors.length) return { errors };
  return { values };
}

router.patch("/", async (req, res, next) => {
  try {
    const athleteId = req.authz?.athleteId;
    if (!athleteId) return res.status(403).json({ error: "NO_ATHLETE_PROFILE" });

    const { errors, values } = validatePatchBody(req.body);
    if (errors) return res.status(400).json({ error: errors[0], errors });

    const current = await query(
      `select first_name, last_name, image_url from public.athletes where id = $1 limit 1`,
      [athleteId],
    );
    if (!current.rows[0]) return res.status(403).json({ error: "NO_ATHLETE_PROFILE" });

    const nextFirstName = values.firstName !== undefined ? values.firstName : current.rows[0].first_name || "";
    const nextLastName = values.lastName !== undefined ? values.lastName : current.rows[0].last_name || "";
    const nextImageUrl = values.imageUrl !== undefined ? values.imageUrl : current.rows[0].image_url || "";
    const nextFullName = [nextFirstName, nextLastName].filter(Boolean).join(" ") || nextFirstName;

    const result = await query(
      `update public.athletes
       set first_name = $2,
           last_name = $3,
           full_name = $4,
           display_name = $4,
           image_url = nullif($5, ''),
           updated_at = now()
       where id = $1
       returning first_name, last_name, image_url`,
      [athleteId, nextFirstName, nextLastName, nextFullName, nextImageUrl],
    );
    if (!result.rows[0]) return res.status(403).json({ error: "NO_ATHLETE_PROFILE" });

    const row = result.rows[0];
    res.json({
      firstName: row.first_name || "",
      lastName: row.last_name || "",
      imageUrl: row.image_url || "",
    });
  } catch (error) {
    next(error);
  }
});

export default router;
