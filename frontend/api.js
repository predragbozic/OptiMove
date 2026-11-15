import { flushLateReports, reportApiFailure } from "./app-errors-capture.js";

const API_BASE = "";

// Option A, A2: a failure the person cannot fix is reported without a word of it (a stable code and the status only).
// The report route itself is never reported (no loop).
const reportable = (path) => !String(path).startsWith("/api/app-errors");
const codeOf = (data, status) => (typeof data?.error === "string" && /^[a-z0-9_.-]{1,60}$/.test(data.error) ? data.error : `http_${status}`);

export async function api(path, options = {}) {
  // Which request it was, for a failure report: the method and the path (reduced to a route pattern by the capture).
  const failed = (code, status) => reportApiFailure({ code, status, method: options.method || "GET", path });
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: "same-origin",
      headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
      ...options,
    });
  } catch (networkError) {
    if (reportable(path) && networkError?.name !== "AbortError") failed("no_response", null);
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
      if (response.status >= 500) failed(codeOf(errorData, response.status), response.status);
      else if (!errorData && response.status !== 401) failed("unexpected_response", response.status);
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
  // The server answered: reports that could not be delivered during an outage go out now, once (never for the
  // report route itself).
  if (reportable(path)) flushLateReports();
  try {
    return await response.json();
  } catch (parseError) {
    if (reportable(path) && parseError?.name !== "AbortError") failed("unexpected_response", response.status);
    throw parseError;
  }
}
