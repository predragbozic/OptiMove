# Builder Training Load review on Submit

A legacy draft can require explicit confirmation of the Training Load and RPE settings already stored in it. The review covers only those effects on the selected plan. Ordinary content edits still follow the existing Builder access, lock, validation and save rules. The review cannot grant authority to assign, add a sibling, edit another plan or change stored settings.

The existing Submit operation replies HTTP 409 with code rpe_recovery_required. An authorized review carries a two-minute challenge, scope this, and effective plan defaults and per-session counts. Accept it by retrying the same operation body and query with rpeReviewToken added. Refresh a changed draft before requesting another review. The batch path cannot accept this token. Use Save only this athlete to review one plan.

Use the same dedicated BUILDER_RPE_REVIEW_SIGNING_KEY on every instance. Supply 32 random bytes encoded as exactly 64 hex digits through the secret configuration. With the key absent or malformed, the guard holds the draft and no review is issued. Configure the key only after the prerequisite guard rollout and recovery verification. Rotation or clearing invalidates outstanding challenges. Keep the key and tokens out of logs.
