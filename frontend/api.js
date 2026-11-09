import { reportApiFailure } from "./app-errors-capture.js";

const API_BASE = "";

// Option A, A2: a failure the person cannot fix is reported without a word of it (a stable code and the status only).
// The report route itself is never reported (no loop).
const reportable = (path) => !String(path).startsWith("/api/app-errors");
const codeOf = (data, status) => (typeof data?.error === "string" && /^[a-z0-9_.-]{1,60}$/.test(data.error) ? data.error : `http_${status}`);

export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: "same-origin",
      headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
      ...options,
    });
  } catch (networkError) {
    if (reportable(path) && networkError?.name !== "AbortError") reportApiFailure({ code: "no_response", status: null });
    throw networkError;
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let errorData = null;
    try {
      errorData = await response.json();
      message = errorData.error || errorData.message || message;
    } catch {}
    if (reportable(path)) {
      if (response.status >= 500) reportApiFailure({ code: codeOf(errorData, response.status), status: response.status });
      else if (!errorData && response.status !== 401) reportApiFailure({ code: "unexpected_response", status: response.status });
    }
    const error = new Error(message);
    error.status = response.status;
    error.path = path;
    error.requiresLogin = Boolean(errorData?.requiresLogin);
    // The whole error body, for callers that act on more than its code
    // (e.g. the GPEXE approval's reviewAgain / verify details).
    error.data = errorData;
    throw error;
  }
  try {
    return await response.json();
  } catch (parseError) {
    if (reportable(path) && parseError?.name !== "AbortError") reportApiFailure({ code: "unexpected_response", status: response.status });
    throw parseError;
  }
}
