import { loadMessages, refreshSelectedConversation } from "./messages.js";
import { loadNotifications } from "./notifications.js";
import { state } from "./state.js";

let realtimeSource = null;

export function startRealtimeInbox() {
  if (realtimeSource || !state.currentUser || typeof EventSource === "undefined") return;
  realtimeSource = new EventSource("/api/realtime");
  realtimeSource.addEventListener("messages_changed", async (event) => {
    const payload = parseRealtimePayload(event);
    await loadMessages({ silent: true });
    if (payload.conversationId && String(state.messages.selectedId || "") === String(payload.conversationId)) {
      await refreshSelectedConversation({ silent: true });
    }
  });
  realtimeSource.addEventListener("notifications_changed", () => {
    void loadNotifications({ silent: true });
  });
  realtimeSource.onerror = () => {
    // EventSource reconnects automatically. Polling remains as a fallback for notifications.
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
