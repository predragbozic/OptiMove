import { loadMessages, refreshSelectedConversation } from "./messages.js";
import { loadNotifications } from "./notifications.js";
import { state } from "./state.js";

let realtimeSource = null;

// hotfix/athlete-home-mobile-layout: onConnectionChange(connected: boolean)
// is the one real, existing signal for "is the live connection currently
// up" - EventSource's own open/error events, not an invented state. Called
// with true once the connection actually opens, and false on every error
// (EventSource keeps retrying on its own after an error; onopen fires again
// once a retry succeeds, flipping the caller's indicator back). Optional -
// callers that don't care about connection status can omit it entirely,
// same as before this parameter existed.
export function startRealtimeInbox(onConnectionChange) {
  if (realtimeSource || !state.currentUser || typeof EventSource === "undefined") return;
  realtimeSource = new EventSource("/api/realtime");
  realtimeSource.addEventListener("messages_changed", async (event) => {
    const payload = parseRealtimePayload(event);
    if (payload.conversationId && String(state.messages.selectedId || "") === String(payload.conversationId)) {
      await refreshSelectedConversation({ silent: true });
    }
    await loadMessages({ silent: true });
  });
  realtimeSource.addEventListener("notifications_changed", () => {
    void loadNotifications({ silent: true });
  });
  realtimeSource.onopen = () => {
    onConnectionChange?.(true);
  };
  realtimeSource.onerror = () => {
    // EventSource reconnects automatically. Polling remains as a fallback for notifications.
    onConnectionChange?.(false);
  };
}

export function stopRealtimeInbox() {
  if (!realtimeSource) return;
  realtimeSource.close();
  realtimeSource = null;
}

function parseRealtimePayload(event) {
  try {
    return JSON.parse(event.data || "{}");
  } catch {
    return {};
  }
}
