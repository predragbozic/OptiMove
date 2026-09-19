const API_BASE = "";

export async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
    ...options,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let errorData = null;
    try {
      errorData = await response.json();
      message = errorData.error || errorData.message || message;
    } catch {}
    const error = new Error(message);
    error.status = response.status;
    error.path = path;
    error.requiresLogin = Boolean(errorData?.requiresLogin);
    // The whole error body, for callers that act on more than its code
    // (e.g. the GPEXE approval's reviewAgain / verify details).
    error.data = errorData;
    throw error;
  }
  return response.json();
}
