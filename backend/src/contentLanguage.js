// The language a user reads exercise content in (owner, 2026-11-03):
// public.users.content_language, 'sr' (the default) or 'en'; the database's
// CHECK users_content_language_known keeps the same two values. Set by the
// user (PUT /api/auth/me/content-language) or, for an athlete's login, by
// whoever may edit that athlete (PUT /api/organization/athletes/:athleteId).
export const CONTENT_LANGUAGES = ["sr", "en"];
export const CONTENT_LANGUAGE_REFUSED = "Choose Srpski or English.";

export function isContentLanguage(value) {
  return CONTENT_LANGUAGES.includes(value);
}
