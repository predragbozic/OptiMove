import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const REVIEW_DURATION_MS = 2 * 60 * 1000;

function signingKey() {
  const secret = process.env.BUILDER_RPE_REVIEW_SIGNING_KEY;
  if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) return null;
  return Buffer.from(secret, "hex");
}

export function refuseBuilderRpeRecovery() {
  return Object.assign(new Error("The draft is still saved. Confirm its Training Load settings before publishing."), {
    status: 409, code: "rpe_recovery_required",
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

async function readLockedSnapshot(client, draftId, targetId) {
  const ids = [...new Set([draftId, targetId])];
  const { rows } = await client.query(
    `select p.id, to_jsonb(p)::text as plan,
            coalesce(jsonb_agg(jsonb_build_array(to_jsonb(d),to_jsonb(s)) order by d.id,s.id)
              filter(where d.id is not null),'[]')::text as schedule,
            count(s.id) as sessions,
            count(s.id) filter(where s.training_load_enabled) as tracking,
            count(s.id) filter(where s.rpe_enabled) as rpe
       from plans.plans p
       left join plans.plan_days d on d.plan_id=p.id
       left join plans.plan_sessions s on s.plan_day_id=d.id
      where p.id=any($1::uuid[])
      group by p.id order by p.id`, [ids],
  );
  if (rows.length !== ids.length) throw refuseBuilderRpeRecovery();
  return rows;
}

export async function confirmBuilderRpeRecovery(client, req, context, { check, authorize, markUse }) {
  const supplied = req.body?.rpeReviewToken;
  let recoveryRequired = false;
  try {
    await check();
  } catch (error) {
    if (error?.code !== "rpe_recovery_required") throw error;
    recoveryRequired = true;
  }
  if (!recoveryRequired) {
    if (supplied !== undefined) throw refuseBuilderRpeRecovery();
    return;
  }

  await authorize();
  const secret = signingKey();
  if (!secret || !req.sessionToken || req.body?.batchScope === "all") throw refuseBuilderRpeRecovery();
  const { rows: [session] } = await client.query(
    "select id from public.auth_sessions where user_id=$1 and token_hash=$2 and expires_at>now() for share",
    [req.user.id, createHash("sha256").update(req.sessionToken).digest("base64url")],
  );
  if (!session) throw refuseBuilderRpeRecovery();

  const { scope, draftId, targetId, operation } = context;
  const { rpeReviewToken: ignoredToken, ...body } = req.body ?? {};
  const snapshot = await readLockedSnapshot(client, draftId, targetId);
  const action = JSON.stringify([
    session.id, req.user.id, scope.type, scope.clubId ?? null, scope.teamId ?? null, scope.userId ?? null,
    operation, "this", draftId, targetId, canonical(body), canonical(req.query), snapshot,
  ]);
  const sign = expires => createHmac("sha256", secret)
    .update("optimove:builder-rpe-review:v1:").update(expires).update(":").update(action).digest();
  const now = Date.now();
  if (supplied !== undefined) {
    const parts = typeof supplied === "string" && /^([0-9]{13})\.([A-Za-z0-9_-]{43})$/.exec(supplied);
    if (!parts || Number(parts[1]) <= now || Number(parts[1]) > now + REVIEW_DURATION_MS ||
      !timingSafeEqual(sign(parts[1]), Buffer.from(parts[2], "base64url"))) throw refuseBuilderRpeRecovery();
    await markUse();
    return;
  }

  const expiry = String(now + REVIEW_DURATION_MS);
  const reviewed = snapshot.find(row => row.id === draftId);
  throw Object.assign(refuseBuilderRpeRecovery(), {
    review: {
      token: expiry + "." + sign(expiry).toString("base64url"),
      expiresAt: new Date(Number(expiry)).toISOString(),
      scope: "this",
      summary: { plans: 1, sessions: Number(reviewed.sessions), trackingEnabledSessions: Number(reviewed.tracking), rpeEnabledSessions: Number(reviewed.rpe) },
    },
  });
}
