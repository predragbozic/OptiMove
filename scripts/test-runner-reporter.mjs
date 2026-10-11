// The node:test reporter the OptiMove test runner (scripts/test-runner.mjs)
// attaches to every test process. It writes one machine-readable line per
// event, prefixed so the runner can pick its lines out of whatever else the
// test file prints, and a readable error block after every failure so the
// kept log stays useful to a person.
//
// Why not the built-in TAP reporter: when a test file runs as its own
// process, TAP prints a test only when it has finished and the summary only
// when the process is about to exit, so a runner could not tell "a test is
// still running" from "every test finished but a server, client or timer
// keeps the process alive". node:test's `test:dequeue` event is delivered
// the moment a test starts, which is what the runner needs for that.
const PREFIX = "@@optimove-test@@ ";

function line(payload) {
  return `${PREFIX}${JSON.stringify(payload)}\n`;
}

function describeError(error) {
  if (!error) return { message: "", failureType: undefined };
  const failureType = error.failureType;
  const own = typeof error.message === "string" ? error.message : String(error);
  const cause = error.cause && typeof error.cause.message === "string" ? error.cause.message : "";
  const message = (cause && failureType === "hookFailed" ? `${own}: ${cause}` : own).split("\n")[0];
  return { message, failureType };
}

function stackBlock(error) {
  if (!error) return "";
  const text = typeof error.stack === "string" ? error.stack : String(error.message ?? error);
  const causeText = error.cause && typeof error.cause.stack === "string" ? `\n  caused by: ${error.cause.stack}` : "";
  return `${text}${causeText}`
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n") + "\n";
}

export default async function* optimoveTestRunnerReporter(source) {
  for await (const event of source) {
    const data = event.data || {};
    switch (event.type) {
      case "test:dequeue":
        yield line({ e: "start", name: data.name ?? "", nesting: data.nesting ?? 0 });
        break;
      case "test:pass":
        yield line({
          e: "pass",
          name: data.name ?? "",
          nesting: data.nesting ?? 0,
          durationMs: data.details?.duration_ms,
          skip: data.skip ? true : undefined,
          todo: data.todo ? true : undefined,
        });
        break;
      case "test:fail": {
        const error = data.details?.error;
        const { message, failureType } = describeError(error);
        yield line({
          e: "fail",
          name: data.name ?? "",
          nesting: data.nesting ?? 0,
          durationMs: data.details?.duration_ms,
          failureType,
          message,
          todo: data.todo ? true : undefined,
        });
        yield `  not ok: ${data.name ?? ""}\n${stackBlock(error)}`;
        break;
      }
      case "test:summary":
        yield line({ e: "summary", success: data.success, counts: data.counts, durationMs: data.duration_ms });
        break;
      case "test:diagnostic":
        yield line({ e: "diagnostic", message: typeof data.message === "string" ? data.message : String(data.message ?? "") });
        break;
      default:
        break;
    }
  }
}
