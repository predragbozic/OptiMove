// Shared by every route that builds a public link back into the app
// (athlete invites, group join links, email verification) - a single
// definition so the app-origin env var is never introduced twice under two
// different names. PUBLIC_APP_URL was already wired end-to-end for invite/
// join-link URLs before email verification existed; this phase reuses it
// rather than adding a separate APP_ORIGIN with the exact same meaning.
export function resolveAppOrigin(req) {
  const configured = String(process.env.PUBLIC_APP_URL || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${protocol}://${req.get("host")}`;
}
