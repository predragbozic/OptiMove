// The top bar's status pill. On a phone the OK state is only a dot (CSS keys on data-state="ok"), so the state is also
// in the accessible name; any other state keeps the text pill.
export function statusState(text) {
  if (text === "Online") return "ok";
  if (text === "Loading" || text === "Connecting") return "busy";
  if (text === "Error") return "error";
  return "info";
}
