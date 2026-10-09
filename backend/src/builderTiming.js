export function createBuilderTiming(res, now = () => performance.now()) {
  const started = now();
  const phases = new Map();
  return {
    async measure(name, work) {
      const phaseStart = now();
      try { return await work(); }
      finally { phases.set(name, (phases.get(name) || 0) + now() - phaseStart); }
    },
    json(body) {
      const timings = [...phases, ["total", now() - started]];
      res.setHeader?.("Server-Timing", timings.map(([name, duration]) => `${name};dur=${duration.toFixed(1)}`).join(", "));
      return res.json(body);
    },
  };
}
