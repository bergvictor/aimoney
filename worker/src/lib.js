// AIMoney shared pure helpers (worker). Imported by src/index.js so the
// scoring/triage math is unit-testable without Workers bindings.

export const clamp10 = (v, d = 5) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : d;
};

export const slugify = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 80);

// Priority score. MUST match functions/api/[[path]].js scoreOf and the README:
//   score = 100 * (value * confidence * fit) / (effort + 1)
export const scoreOf = (o) =>
  Math.round(100 * ((o.value * o.confidence * o.fit) / (o.effort + 1)) * 10) / 10;

// The triage model replies with one JSON object per line (NDJSON). A hard
// token cap truncates ARRAY output into unparseable garbage (proven live:
// every verdict lost); with NDJSON a cut tail only loses the last lines.
export function parseJsonLines(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const t = line.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
    if (!t.startsWith("{") || !t.endsWith("}")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      continue; // truncated tail line: drop it, keep the rest
    }
  }
  return out;
}
