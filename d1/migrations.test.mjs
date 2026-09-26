// AIMoney D1 migration guards (audit 2026-09-20-round4 Tasks 1+3).
// Static, offline, no SQLite engine: parses schema.sql, d1/migrate-*.sql,
// the worker CI workflow, and the API probe SQL as text.
// Run: npm test (node --test, no framework)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

function migrationFiles() {
  return readdirSync(join(ROOT, "d1"))
    .filter((f) => f.startsWith("migrate-") && f.endsWith(".sql"))
    .sort();
}

function addedColumns(sql) {
  const out = [];
  const re = /ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql))) out.push(m[1]);
  return out;
}

function addedColumnsByTable(sql) {
  const out = [];
  const re = /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql))) out.push({ table: m[1], column: m[2] });
  return out;
}

function tableColumns(schemaSql, table) {
  const block = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(([\\s\\S]*?)\\);`, "i").exec(schemaSql);
  assert.ok(block, `schema.sql must own CREATE TABLE ${table}`);
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z_]/.test(line))
    .map((line) => line.split(/\s+/)[0].replace(/[^A-Za-z0-9_]/g, ""));
}

describe("CI applies sorted d1/migrate-*.sql (audit 2026-09-20-round4 Task 1)", () => {
  it("runs schema.sql before the shared migration call, loop lives in one home", () => {
    const yml = read(".github/workflows/deploy-worker.yml");
    const shared = read("deploy/apply-d1-migrations.sh");
    const schemaAt = yml.indexOf("--file=d1/schema.sql");
    assert.ok(schemaAt !== -1, "workflow must apply d1/schema.sql");
    assert.ok(yml.includes("deploy/apply-d1-migrations.sh"), "workflow must invoke the shared migration script");
    assert.ok(schemaAt < yml.indexOf("deploy/apply-d1-migrations.sh"), "schema.sql must run before the shared migration call");
    assert.ok(/for f in d1\/migrate-\*\.sql/.test(shared), "shared script must iterate the sorted glob");
  });

  it("tolerates only duplicate-column re-runs and fails anything else", () => {
    const shared = read("deploy/apply-d1-migrations.sh");
    assert.ok(shared.includes("duplicate column"), "shared script must tolerate the duplicate-column no-op");
    assert.ok(shared.includes("already exists"), "shared script must tolerate the already-exists no-op");
    assert.ok(/exit 1/.test(shared), "a broken migration must fail the job");
    assert.ok(
      !/\|\| echo "==> D1: \$f already applied/.test(shared),
      "shared script must not blanket-claim every failure as already applied"
    );
  });

  it("fails fast with a named message when secrets are empty", () => {
    const yml = read(".github/workflows/deploy-worker.yml");
    assert.ok(yml.includes("CF_API_TOKEN") && yml.includes("CF_ACCOUNT_ID"), "workflow must reference both secrets");
    assert.ok(/\[ -n "\$CLOUDFLARE_API_TOKEN" \]/.test(yml), "workflow must guard the empty API token");
    assert.ok(/\[ -n "\$CLOUDFLARE_ACCOUNT_ID" \]/.test(yml), "workflow must guard the empty account id");
    assert.ok(
      yml.includes("::error::CF_API_TOKEN") && yml.includes("::error::CF_ACCOUNT_ID"),
      "empty secrets must fail with a named message"
    );
  });
});

describe("old-schema migration convergence (audit 2026-09-20-round4 Task 3)", () => {
  // Columns the money path needs on experiments: health probes read
  // revenue_cents/spent_cents/ended_at and the API writes revenue_source.
  // The swept/noise split (audit 2026-09-26-round3 Task 3) needs swept on
  // signals: the worker sweep marks it, the health split probes read it.
  const REQUIRED = {
    experiments: ["revenue_cents", "spent_cents", "revenue_source", "ended_at"],
    signals: ["swept"],
  };

  function convergedColumns(table, withhold = null) {
    const base = new Set(tableColumns(read("d1/schema.sql"), table));
    const files = migrationFiles();
    // Simulate a pre-migration database: created from an older schema.sql,
    // so it lacks every column the migrations add to this table.
    const migrated = new Set();
    for (const f of files) {
      for (const { table: t, column: c } of addedColumnsByTable(read(`d1/${f}`))) {
        if (t === table) migrated.add(c);
      }
    }
    for (const c of migrated) base.delete(c);
    // Apply schema + ordered migrations (withhold one file for the control).
    for (const f of files) {
      if (f === withhold) continue;
      for (const { table: t, column: c } of addedColumnsByTable(read(`d1/${f}`))) {
        if (t === table) base.add(c);
      }
    }
    return base;
  }

  it("ends with every probed money column after schema + ordered migrations", () => {
    const files = migrationFiles();
    assert.ok(files.length >= 1, "d1 must own at least one migrate-*.sql");
    for (const f of files) {
      assert.ok(addedColumns(read(`d1/${f}`)).length >= 1, `${f} must add at least one column`);
    }
    const final = convergedColumns("experiments");
    for (const c of REQUIRED.experiments) {
      assert.ok(final.has(c), `converged experiments table must own ${c}`);
    }
    // The required list is tied to shipped code: every SUM() column the
    // health probes read must be in the converged set.
    const api = read("functions/api/[[path]].js");
    const sums = [...api.matchAll(/SUM\((\w+)\)/g)].map((m) => m[1]);
    assert.ok(sums.length >= 2, `probe SUM() extraction must find columns, got ${sums.length}`);
    for (const c of new Set(sums)) {
      assert.ok(final.has(c), `probed SUM column ${c} must survive convergence`);
    }
    assert.ok(api.includes("revenue_source") && final.has("revenue_source"), "API-written revenue_source must survive convergence");
    assert.ok(api.includes("ended_at") && final.has("ended_at"), "probed ended_at window must survive convergence");
  });

  it("ends with the swept marker on signals after schema + ordered migrations", () => {
    const final = convergedColumns("signals");
    for (const c of REQUIRED.signals) {
      assert.ok(final.has(c), `converged signals table must own ${c}`);
    }
    // Tied to shipped code both sides: the worker sweep marks the column,
    // the health split probes read it.
    const worker = read("worker/src/index.js");
    const api = read("functions/api/[[path]].js");
    assert.ok(worker.includes("swept = 1"), "worker sweep must mark the swept column");
    assert.ok(api.includes("swept = 0") && api.includes("swept = 1"), "health split probes must read the swept column");
  });

  it("withholding any one migration file breaks convergence (positive control)", () => {
    const files = migrationFiles();
    assert.ok(files.length >= 1, "positive control needs at least one migration file");
    for (const f of files) {
      const missingExp = REQUIRED.experiments.filter((c) => !convergedColumns("experiments", f).has(c));
      const missingSig = REQUIRED.signals.filter((c) => !convergedColumns("signals", f).has(c));
      assert.ok(missingExp.length + missingSig.length >= 1, `withholding ${f} must drop a required column, else the control is blind`);
    }
  });
});
