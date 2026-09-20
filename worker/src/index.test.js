// Research worker regression tests (round2 Task 2): POST /run discloses the
// triage-only split, and cron ticks carry the extra-brief backlog guard.
// Run: npm test (node --test, no framework)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";

describe("manual run disclosure (/run)", () => {
  it("202 carries briefs_skipped:true with a reason", async () => {
    const req = new Request("http://localhost/run", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const env = { ADMIN_TOKEN: "secret", DB: null, AI: null };
    const ctx = { waitUntil(p) { if (p && p.catch) p.catch(() => {}); } };
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.status, "accepted");
    assert.equal(body.briefs_skipped, true);
    assert.ok(body.reason && body.reason.length > 0);
  });

  it("still 401s without the admin token", async () => {
    const req = new Request("http://localhost/run", { method: "POST" });
    const env = { ADMIN_TOKEN: "secret", DB: null, AI: null };
    const ctx = { waitUntil() {} };
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 401);
  });
});

describe("extra brief on old backlog (static guard)", () => {
  it("cron path briefs one extra oldest-unreviewed row past 48h within budget", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("extraBare"), "worker lost the extra-brief query");
    assert.ok(src.includes("48 * 3600000"), "worker lost the 48h backlog gate");
    assert.ok(src.includes("retries: 0"), "extra brief must use retries:0 to stay in budget");
    assert.ok(src.includes("state.ai_calls < MAX_AI_CALLS"), "extra brief must respect MAX_AI_CALLS");
  });
});
