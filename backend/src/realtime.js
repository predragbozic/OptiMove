const clientsByUser = new Map();

export function realtimeRouter(req, res) {
  if (!req.user?.id) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const userId = String(req.user.id);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 5000\n\n");
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const clients = clientsByUser.get(userId) || new Set();
  clients.add(res);
  clientsByUser.set(userId, clients);

  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
    if (!clients.size) clientsByUser.delete(userId);
  });
}

export function emitRealtimeEvent(userId, event, payload = {}) {
  const clients = clientsByUser.get(String(userId));
  if (!clients?.size) return;
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

export function emitRealtimeEventForUsers(userIds, event, payload = {}) {
  for (const userId of new Set(userIds.filter(Boolean).map(String))) {
    emitRealtimeEvent(userId, event, payload);
  }
}
