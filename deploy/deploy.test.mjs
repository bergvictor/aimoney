// AIMoney deploy-script guards (audit 2026-09-20-round1 Tasks 1-3).
// Static, offline: parses deploy.sh, deploy/verify.sh, d1/seed.sql, and the
// worker CI workflow as text. No wrangler, no network, no D1.
// Run: npm test (node --test, no framework)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const lines = (text) => text.replace(/\r\n/g, "\n").split("\n");

const SEED_SLUGS = [
  "ai-ugc-ads-service",
  "ai-freelance-outcomes",
  "ai-chatbot-integration",
  "ai-automation-agency",
  "micro-saas-ai-tool",
  "ai-video-agency-tiktok",
  "ai-consulting-retainers",
  "ai-voice-agents-local",
  "digital-products-prompts",
  "faceless-youtube-ai",
  "ai-boilerplate-starter",
  "ai-seo-content-sites",
];
const BRIEF_SLUGS = [
  "ai-ugc-ads-service",
  "ai-freelance-outcomes",
  "ai-chatbot-integration",
  "ai-automation-agency",
];

// The tolerate-list case statement, indentation-normalized so the shared-script
// comparison is about the list itself, not nesting depth.
function caseBlock(text, label) {
  const norm = text.replace(/\r\n/g, "\n");
  const start = norm.indexOf('case "$(printf');
  assert.ok(start !== -1, `${label} lost the tolerate-list case statement`);
  const end = norm.indexOf("esac", start);
  assert.ok(end !== -1, `${label} lost the end of the tolerate-list case statement`);
  const block = norm.slice(start, end + 4).split("\n").map((l) => l.trimStart()).join("\n");
  assert.ok(block.includes('*"duplicate column"*'), `${label} case block is not the tolerate-list`);
  return block;
}

describe("seed guard fails closed (audit 2026-09-20-round1 Task 1)", () => {
  it("deploy.sh never seeds on a failed COUNT measurement", () => {
    const deploy = read("deploy/deploy.sh");
    assert.ok(!deploy.includes("|| echo 0"), "seed guard still fails open (|| echo 0 seeds on any COUNT failure)");
    assert.ok(deploy.includes("refusing to seed"), "seed guard must abort with a named error");
    assert.ok(deploy.includes('case "${COUNT:-}" in'), "seed guard must validate COUNT before use");
    assert.ok(deploy.includes("''|*[!0-9]*)"), "COUNT must be digits-only (empty/non-numeric aborts)");
    const guardAt = deploy.indexOf("refusing to seed");
    const seedAt = deploy.indexOf("--file=d1/seed.sql");
    assert.ok(seedAt !== -1, "deploy.sh must still own the seed step");
    assert.ok(guardAt !== -1 && guardAt < seedAt, "the named abort must sit before the seed step");
  });

  it("deploy.sh seeds through the resolved wrangler binary", () => {
    const deploy = read("deploy/deploy.sh");
    assert.ok(deploy.includes("$WRANGLER d1 execute aimoney --file=d1/seed.sql --remote"), "seed step must use $WRANGLER");
    assert.ok(!deploy.includes("\n  wrangler d1 execute"), "seed step must not bypass the resolved binary");
  });

  it("seed.sql opportunities INSERT is re-runnable via OR IGNORE", () => {
    const seed = read("d1/seed.sql");
    assert.ok(seed.includes("INSERT OR IGNORE INTO opportunities ("), "opportunities seed must be INSERT OR IGNORE");
    assert.ok(!/[\r\n]INSERT INTO opportunities \(/.test(seed), "plain INSERT INTO opportunities must be gone");
    assert.ok(seed.includes("notes) VALUES"), "first deploy must still insert all rows in one statement");
  });

  it("seed.sql briefs and starter experiment guard on existence", () => {
    const seed = read("d1/seed.sql");
    const briefsAt = seed.indexOf("-- Briefs");
    const expAt = seed.indexOf("-- Starter experiment");
    assert.ok(briefsAt !== -1 && expAt !== -1 && briefsAt < expAt, "seed section comments must survive");
    const briefsRegion = seed.slice(briefsAt, expAt);
    const expRegion = seed.slice(expAt);
    assert.equal((briefsRegion.match(/WHERE NOT EXISTS \(/g) || []).length, 4, "each of the 4 briefs needs its own existence guard");
    assert.equal((expRegion.match(/WHERE NOT EXISTS \(/g) || []).length, 1, "the starter experiment needs an existence guard");
    assert.ok(!briefsRegion.includes(") VALUES") && !expRegion.includes(") VALUES"), "guarded inserts must use SELECT form, not VALUES tuples");
    for (const slug of BRIEF_SLUGS) {
      assert.ok(briefsRegion.includes(`o.slug = '${slug}'`), `brief guard lost ${slug}`);
    }
    assert.ok(expRegion.includes("Spec-ad sprint: 10 brands, 10 free ads"), "starter experiment insert lost its name");
  });

  it("seed.sql still seeds the full first-deploy set", () => {
    const seed = read("d1/seed.sql");
    for (const slug of SEED_SLUGS) {
      assert.ok(seed.includes(`'${slug}'`), `seed lost opportunity ${slug}`);
    }
    assert.ok(seed.includes("Re-runnable"), "seed header must document the no-op re-run");
  });
});

describe("shared D1 migration script (audit 2026-09-20-round2 Task 1)", () => {
  it("both callers invoke the shared script, schema first", () => {
    const deploy = read("deploy/deploy.sh");
    const yml = read(".github/workflows/deploy-worker.yml");
    assert.ok(deploy.includes("deploy/apply-d1-migrations.sh"), "deploy.sh must invoke the shared migration script");
    assert.ok(yml.includes("deploy/apply-d1-migrations.sh"), "workflow must invoke the shared migration script");
    assert.ok(yml.includes("Apply D1 migrations in sorted order"), "workflow must keep the migration step name");
    const schemaAt = deploy.indexOf("--file=d1/schema.sql");
    assert.ok(schemaAt !== -1, "deploy.sh must apply d1/schema.sql");
    assert.ok(schemaAt < deploy.indexOf("deploy/apply-d1-migrations.sh"), "schema.sql must run before the shared migration call");
    const ymlSchemaAt = yml.indexOf("--file=d1/schema.sql");
    assert.ok(ymlSchemaAt !== -1 && ymlSchemaAt < yml.indexOf("deploy/apply-d1-migrations.sh"), "workflow schema must run before the shared migration call");
  });

  it("shared script loops the sorted glob and owns the tolerate-list", () => {
    const shared = read("deploy/apply-d1-migrations.sh");
    assert.ok(shared.includes("for f in d1/migrate-*.sql"), "shared script must loop the sorted migration glob");
    assert.ok(shared.includes('*"duplicate column"*'), "shared script must tolerate the duplicate-column no-op");
    assert.ok(shared.includes('*"already exists"*'), "shared script must tolerate the already-exists no-op");
    assert.ok(shared.includes("::error::D1 migration"), "a broken migration must fail with a named error");
    assert.ok(!shared.includes('|| echo "==> D1: $f already applied'), "shared script must not blanket-claim every failure as already applied");
    const surfacedAt = shared.indexOf('echo "$out"');
    const namedAt = shared.indexOf("::error::D1 migration");
    assert.ok(surfacedAt !== -1 && namedAt !== -1 && surfacedAt < namedAt, "a broken migration must surface the driver error");
    caseBlock(shared, "apply-d1-migrations.sh");
  });

  it("callers carry no duplicated loop or tolerate-list", () => {
    const deploy = read("deploy/deploy.sh");
    const yml = read(".github/workflows/deploy-worker.yml");
    assert.ok(!deploy.includes("for f in d1/migrate-*.sql"), "deploy.sh must not duplicate the migration loop");
    assert.ok(!yml.includes("for f in d1/migrate-*.sql"), "workflow must not duplicate the migration loop");
    assert.ok(!deploy.includes('*"duplicate column"*'), "deploy.sh must not duplicate the tolerate-list");
    assert.ok(!yml.includes('*"duplicate column"*'), "workflow must not duplicate the tolerate-list");
  });
});

describe("dashboard-appjs parse gate (audit 2026-09-20-round2 Task 2)", () => {
  it("requires the served bundle to parse as JS, not merely contain its marker", () => {
    const verify = read("deploy/verify.sh");
    const appjsAt = verify.indexOf("dashboard-appjs");
    assert.ok(appjsAt !== -1, "verify.sh lost the dashboard-appjs check");
    const block = verify.slice(appjsAt, verify.indexOf('check "release-marker"'));
    assert.ok(block.includes("renderLedger"), "dashboard-appjs must keep its renderLedger marker");
    assert.ok(block.includes("node --check"), "dashboard-appjs must parse the bundle with node --check");
    assert.ok(block.includes("does not parse as JS"), "an unparsable bundle must fail named");
    assert.ok(block.includes("ok   dashboard-appjs"), "a parsing bundle must pass named");
  });

  it("fails named when unreachable, markerless, or node is missing", () => {
    const verify = read("deploy/verify.sh");
    assert.ok(verify.includes("FAIL dashboard-appjs: unreachable"), "an unreachable app.js must fail named");
    assert.ok(verify.includes("FAIL dashboard-appjs: marker not found /renderLedger/"), "a markerless app.js must fail named");
    assert.ok(verify.includes("FAIL dashboard-appjs: node not found"), "a missing node binary must fail named, not pass silent");
  });

  it("parses fetched bytes from a temp file and cleans up", () => {
    const verify = read("deploy/verify.sh");
    assert.ok(verify.includes('APPJS_DIR="$(mktemp -d)"'), "the parse gate must stage bytes in a temp dir");
    assert.ok(verify.includes('> "$APPJS_DIR/app.js"'), "the parse gate must stage the fetched bytes as app.js");
    assert.ok(verify.includes('rm -rf "$APPJS_DIR"'), "the parse gate must clean up its temp dir");
  });
});

describe("worker-status gate requires ok:true (audit 2026-09-20-round3 Task 3)", () => {
  it("fails a D1-dead worker root that still serves its agent marker", () => {
    const workerChecks = lines(read("deploy/verify.sh")).filter((l) => l.includes("$WORKER/"));
    assert.ok(workerChecks.length >= 1, "verify.sh lost the worker-status check");
    const joined = workerChecks.join("\n");
    assert.ok(joined.includes('"agent":"research-v1"'), "worker-status gate must keep the agent marker");
    assert.ok(joined.includes('"ok":true'), 'worker-status gate must require "ok":true so a D1-dead worker (ok:false) fails verification');
  });
});

describe("verify.sh requires live revision == deployed commit (audit 2026-09-20-round1 Task 3)", () => {
  it("takes an expected SHA, defaulting to the current short HEAD", () => {
    const verify = read("deploy/verify.sh");
    assert.ok(verify.includes('EXPECTED_REV="${1:-${EXPECTED_REV:-$(git rev-parse --short HEAD'), "verify.sh must take $1/EXPECTED_REV with a short-HEAD default");
    assert.ok(verify.includes("cannot determine the expected revision"), "an undeterminable expected revision must fail named");
  });

  it("requires the body to parse as JSON with revision == expected", () => {
    const verify = read("deploy/verify.sh");
    assert.ok(verify.includes("json.load(sys.stdin).get('revision'"), "verify.sh must parse the revision out of JSON");
    assert.ok(verify.includes('[ "$REV" = "$EXPECTED_REV" ]'), "verify.sh must compare live revision to expected");
    assert.ok(verify.includes("ok   live-revision"), "a matching revision must pass named");
    assert.ok(!verify.includes("==> live revision:"), "the print-without-comparing placeholder pass must be gone");
  });

  it("fails immediately on HTML, unparsable, or placeholder bodies", () => {
    const verifyLines = lines(read("deploy/verify.sh"));
    const sleepAt = verifyLines.findIndex((l) => l.includes('sleep "$VERIFY_RETRY_DELAY"'));
    assert.ok(sleepAt !== -1, "verify.sh must bound stale-revision retries with a sleep");
    for (const marker of ["FAIL live-revision: expected JSON, got an HTML body", "FAIL live-revision: unparsable body", "FAIL live-revision: placeholder revision dev-undeployed"]) {
      const at = verifyLines.findIndex((l) => l.includes(marker));
      assert.ok(at !== -1, `verify.sh lost the ${marker} gate`);
      assert.ok(verifyLines[at].includes("break"), `${marker} must break immediately, never retry`);
      assert.ok(at < sleepAt, `${marker} must sit before the retry sleep`);
    }
  });

  it("retries a stale revision a bounded number of times, then fails", () => {
    const verify = read("deploy/verify.sh");
    assert.ok(verify.includes('VERIFY_ATTEMPTS="${VERIFY_ATTEMPTS:-6}"'), "retry attempts must be bounded with a default");
    assert.ok(verify.includes('while [ "$ATTEMPT" -lt "$VERIFY_ATTEMPTS" ]'), "the revision gate must loop bounded");
    assert.ok(verify.includes("FAIL live-revision: stale revision"), "an always-stale edge must fail named");
  });

  it("keeps every existing marker check and documents the stamp step", () => {
    const verify = read("deploy/verify.sh");
    for (const marker of ["AIMoney Lab", "renderLedger", '"project":"aimoney"', '"ok":true', '"opportunities"', '"runs"', '"agent":"research-v1"']) {
      assert.ok(verify.includes(marker), `verify.sh lost the ${marker} marker check`);
    }
    assert.ok(verify.includes("scripts/stamp-release.sh"), "verify.sh must document the build command that stamps release.json");
  });
});

describe("full-SHA revision plus package release (audit 2026-09-20-round1 Task 4)", () => {
  it("stamp-release.sh stamps the full SHA plus release, short form stays in the log", () => {
    const stamp = read("scripts/stamp-release.sh");
    assert.ok(stamp.includes("CF_PAGES_COMMIT_SHA"), "stamp must keep the Pages SHA source");
    assert.ok(stamp.includes("git rev-parse HEAD"), "stamp fallback must read the full HEAD, not a short form");
    assert.ok(!stamp.includes("git rev-parse --short"), "stamp must not cut the stamped revision to short");
    assert.ok(stamp.includes("cut -c1-7"), "stamp must keep the short form for the deploy log");
    assert.ok(stamp.includes("package.json") && stamp.includes("version"), "stamp must read the release from package.json");
    assert.ok(stamp.includes('"revision":"%s","release":"%s","built_at"'), "release.json must carry revision + release + built_at");
    assert.ok(stamp.includes('"$SHA" "$REL" "$STAMP"'), "stamped revision must be the full SHA with release, not the short REV");
    assert.ok(stamp.includes("rev=${REV} release=${REL}"), "deploy log must keep the short form plus release");
  });

  it("deploy.sh stamps the full SHA plus release, short form stays in the log", () => {
    const deploy = read("deploy/deploy.sh");
    assert.ok(deploy.includes("git rev-parse HEAD"), "deploy must read the full HEAD for the stamped revision");
    assert.ok(!deploy.includes("git rev-parse --short HEAD"), "deploy must not stamp the short form");
    assert.ok(deploy.includes("cut -c1-7"), "deploy must keep the short form for the log");
    assert.ok(deploy.includes("package.json") && deploy.includes("version"), "deploy must read the release from package.json");
    assert.ok(deploy.includes('"revision":"%s","release":"%s","built_at"'), "release.json must carry revision + release + built_at");
    assert.ok(deploy.includes('"$FULL" "$REL" "$STAMP"'), "stamped revision must be the full SHA with release");
    assert.ok(deploy.includes("FULL=\"${FULL}-dirty\"") && deploy.includes("REV=\"${REV}-dirty\""), "dirty must tag both the full revision and the short log form");
    assert.ok(deploy.includes("rev=${REV} release=${REL}"), "deploy log must keep the short form plus release");
  });

  it("verify.sh accepts a full revision against a short expected prefix and vice versa", () => {
    const verify = read("deploy/verify.sh");
    assert.ok(verify.includes('[ "$REV" = "$EXPECTED_REV" ]'), "verify must keep the exact-match pass");
    assert.ok(verify.includes('case "$REV" in'), "verify must prefix-match live full against expected short");
    assert.ok(verify.includes('"$EXPECTED_REV"*)'), "verify must accept live starting with expected");
    assert.ok(verify.includes('case "$EXPECTED_REV" in'), "verify must prefix-match expected full against live short");
    assert.ok(verify.includes('"$REV"*)'), "verify must accept expected starting with live");
    const exactAt = verify.indexOf('[ "$REV" = "$EXPECTED_REV" ]');
    const fwdAt = verify.indexOf('case "$REV" in');
    const revAt = verify.indexOf('case "$EXPECTED_REV" in');
    const staleAt = verify.indexOf("FAIL live-revision: stale revision");
    assert.ok(exactAt !== -1 && fwdAt > exactAt && revAt > fwdAt && staleAt > revAt, "prefix passes must sit after exact match and before the stale fail");
  });
});

describe("gitignore covers local secrets (audit 2026-09-20-round7 Task 3)", () => {
  it(".gitignore lists .env and .env.* so one broad add cannot stage credentials", () => {
    const ignored = lines(read(".gitignore")).map((l) => l.trim());
    assert.ok(ignored.includes(".env"), ".gitignore lost the .env line");
    assert.ok(ignored.includes(".env.*"), ".gitignore lost the .env.* line");
    assert.ok(ignored.includes(".dev.vars"), ".gitignore lost the pre-existing .dev.vars line");
  });
});

describe("worker rev stamp + gate (audit 2026-09-20-round7 Task 3)", () => {
  it("both callers stamp via the shared helper before deploying the worker", () => {
    const deploy = read("deploy/deploy.sh");
    const yml = read(".github/workflows/deploy-worker.yml");
    assert.ok(deploy.includes("./deploy/stamp-worker-rev.sh"), "deploy.sh must invoke the shared worker-rev stamp");
    assert.ok(yml.includes("./deploy/stamp-worker-rev.sh"), "workflow must invoke the shared worker-rev stamp");
    assert.ok(yml.includes("Stamp worker revision"), "workflow must keep the stamp step name");
    const deployStampAt = deploy.indexOf("./deploy/stamp-worker-rev.sh");
    const deployAt = deploy.indexOf("deploy --config worker/wrangler.toml");
    assert.ok(deployAt !== -1 && deployStampAt < deployAt, "deploy.sh must stamp before deploying the worker");
    const ymlStampAt = yml.indexOf("./deploy/stamp-worker-rev.sh");
    const ymlDeployAt = yml.indexOf("deploy --config worker/wrangler.toml");
    assert.ok(ymlDeployAt !== -1 && ymlStampAt < ymlDeployAt, "workflow must stamp before deploying the worker");
  });

  it("shared helper stamps the full SHA into worker/src/rev.js", () => {
    const stamp = read("deploy/stamp-worker-rev.sh");
    assert.ok(stamp.includes("worker/src/rev.js"), "stamp must own worker/src/rev.js");
    assert.ok(stamp.includes("WORKER_REV"), "stamp must write the WORKER_REV binding");
    assert.ok(stamp.includes("git rev-parse HEAD"), "stamp fallback must read the full HEAD, not a short form");
    assert.ok(!stamp.includes("git rev-parse --short"), "stamp must not cut the revision to short");
    assert.ok(stamp.includes('export const WORKER_REV = "%s"'), "stamp must write a rev.js module");
  });

  it("worker root serves the stamped rev with an unknown dev default", () => {
    const worker = read("worker/src/index.js");
    const rev = read("worker/src/rev.js");
    assert.ok(worker.includes('from "./rev.js"'), "worker root must read the stamped rev module");
    assert.ok(worker.includes("rev: workerRev"), "worker root must serve the rev key");
    assert.ok(rev.includes('WORKER_REV = "unknown"'), "committed rev.js must default to unknown for wrangler dev");
  });

  it("verify.sh fails a mismatched worker rev the way it fails a stale Pages rev", () => {
    const verify = read("deploy/verify.sh");
    assert.ok(verify.includes("json.load(sys.stdin).get('rev'"), "verify.sh must parse the worker rev out of JSON");
    assert.ok(verify.includes("FAIL worker-revision: unreachable"), "an unreachable worker must fail named");
    assert.ok(verify.includes("FAIL worker-revision: unparsable body"), "an unparsable worker body must fail named");
    assert.ok(verify.includes("FAIL worker-revision: placeholder rev unknown"), "an unstamped worker rev must fail named");
    assert.ok(verify.includes("FAIL worker-revision: stale revision"), "a stale worker rev must fail named");
    assert.ok(verify.includes("ok   worker-revision"), "a matching worker rev must pass named");
    assert.ok(verify.includes('case "$WREV" in'), "verify must prefix-match worker full against expected short");
    assert.ok(verify.includes('case "$EXPECTED_REV" in'), "verify must prefix-match expected full against worker short");
  });
});
