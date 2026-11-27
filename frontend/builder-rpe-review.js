import { currentUserWorkspaceContextParts } from "./access.js";
import { reportHandlerError } from "./app-errors-capture.js";
import { state } from "./state.js";

const pendingByBuilder = new WeakMap();
const snapshot = () => JSON.stringify([state.activeTab, currentUserWorkspaceContextParts(), state.builder.draft]);

export function builderRpeReviewContext() {
  return { builder: state.builder, snapshot: snapshot() };
}

export function matchesBuilderRpeReview(context) {
  return context.builder === state.builder && context.snapshot === snapshot();
}

export function offerBuilderRpeReview(error, context, payload) {
  const review = error?.status === 409 && error.data?.code === "rpe_recovery_required" ? error.data.review : null;
  if (!review || !matchesBuilderRpeReview(context) || !["this", "all"].includes(review.scope)) return false;
  if (review.scope === "all" && payload.batchScope !== "all" && payload.syncBatch !== true) return false;
  const { token, expiresAt, summary } = review;
  const expires = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  if (typeof token !== "string" || !token.trim() || token.length > 4096 || !Number.isFinite(expires) || expires <= Date.now()) return false;
  const { plans, sessions, trackingEnabledSessions, rpeEnabledSessions, trackTrainingLoadDefault, requestRpeDefault } = summary || {};
  if (![plans, sessions, trackingEnabledSessions, rpeEnabledSessions].every(value => Number.isSafeInteger(value) && value >= 0)
    || plans < 1 || rpeEnabledSessions > trackingEnabledSessions || trackingEnabledSessions > sessions
    || typeof trackTrainingLoadDefault !== "boolean" || typeof requestRpeDefault !== "boolean"
    || (requestRpeDefault && !trackTrainingLoadDefault)) return false;
  pendingByBuilder.set(context.builder, {
    context, payload: structuredClone(payload), scope: review.scope, token, expires, confirming: false,
    summary: { plans, sessions, trackingEnabledSessions, rpeEnabledSessions, trackTrainingLoadDefault, requestRpeDefault },
  });
  return true;
}

export function currentBuilderRpeReview() {
  return pendingByBuilder.get(state.builder) ?? null;
}

export function closeBuilderRpeReview(review = currentBuilderRpeReview()) {
  if (review && pendingByBuilder.get(review.context.builder) === review) pendingByBuilder.delete(review.context.builder);
}

let mounted;
let observer;
let island;
let generation = 0;

function unmount() {
  observer?.disconnect();
  observer = null;
  if (mounted) {
    island?.unmountIsland(mounted);
    mounted.remove();
  }
  mounted = null;
}

export async function mountBuilderRpeReview(root) {
  const ticket = ++generation;
  unmount();
  const review = currentBuilderRpeReview();
  if (!root || !review) return;
  if (!matchesBuilderRpeReview(review.context) || review.expires <= Date.now()) {
    closeBuilderRpeReview(review);
    return;
  }
  try {
    island ??= await import("./react-build/islands.js");
    if (ticket !== generation || !root.isConnected || currentBuilderRpeReview() !== review) return;
    if (!matchesBuilderRpeReview(review.context) || review.expires <= Date.now()) {
      closeBuilderRpeReview(review);
      return;
    }
    mounted = root.ownerDocument.createElement("div");
    root.append(mounted);
    island.mountIsland(mounted, island.BuilderRpeReview, {
      summary: review.summary, scope: review.scope, confirming: review.confirming,
    }, { name: "builder_rpe_review", onError: () => { closeBuilderRpeReview(review); unmount(); } });
    const Observer = root.ownerDocument.defaultView?.MutationObserver;
    if (Observer) {
      observer = new Observer(() => {
        if (!mounted?.isConnected) {
          closeBuilderRpeReview(review);
          unmount();
        }
      });
      observer.observe(root.ownerDocument.body, { childList: true, subtree: true });
    }
  } catch (error) {
    closeBuilderRpeReview(review);
    unmount();
    reportHandlerError(error, "builder_rpe_review");
  }
}
