// Express 4 calls a route handler and ignores the promise an async handler
// returns, so a rejection that the handler does not catch itself (for
// example a pool.connect() before the handler's own try, which can now time
// out) became an unhandled rejection: under Node's default it ends the whole
// process and the request is never answered. This hands such a rejection to
// next(error), so it reaches the global error handler like a thrown error.
// It replaces Layer.prototype.handle_request with the same code plus that one
// step; error handlers (four parameters) keep their own path, untouched.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Layer = require("express/lib/router/layer.js");

if (!Layer.prototype.handle_request.asyncErrorsInstalled) {
  const handleRequest = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) {
      // not a standard request handler
      return next();
    }
    try {
      const result = fn(req, res, next);
      if (result && typeof result.then === "function") {
        result.then(undefined, (error) => next(error ?? new Error("A route handler rejected without a reason.")));
      }
    } catch (error) {
      next(error);
    }
  };
  handleRequest.asyncErrorsInstalled = true;
  Layer.prototype.handle_request = handleRequest;
}
