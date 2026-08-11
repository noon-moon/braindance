// /health payload tests. Run: `npm run test:health`.
//
// The load-bearing one is the LEAK guard: /health is unauthenticated, so a field
// added carelessly later would publish a bearer credential to anyone on the
// tailnet. That test builds a payload in an environment full of secrets and
// searches the serialised output for every one of them.
import assert from "node:assert/strict";

process.env.TZ = "UTC"; // deterministic `today`
const { healthPayload } = await import("../src/health.js");

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

const SYNC = { conflicted: false, pending: false, holdsLease: true };
const build = (env: Record<string, string>) => healthPayload(SYNC, env as NodeJS.ProcessEnv);

console.log("test: health payload");
{
  const bare = build({});
  check("reports ok", bare.ok === true);
  check("an unbuilt image reads as dev", bare.version === "dev");
  check("the sync status is passed through", bare.sync.holdsLease === true);
  check("an unset TZ is reported as null, not hidden", bare.config.tz === null);
  check("…alongside the day the api actually thinks it is", /^\d{4}-\d{2}-\d{2}$/.test(bare.config.today));
  check("nothing configured means empty alarm lists",
    bare.config.ics.timedAlarmsMin.length === 0 && bare.config.ics.allDayAlarmsAt.length === 0);
  check("…and a null base url", bare.config.ics.baseUrl === null);
  check("the default duration is reported even when implicit", bare.config.taskDefaultDurationMin === 30);

  const set = build({
    BUILD_SHA: "abc1234",
    TZ: "America/Los_Angeles",
    TASK_DEFAULT_DURATION_MIN: "45",
    PUBLIC_BASE_URL: "http://box:3000",
    TODO_ICS_ALARM_MIN: "60,15",
  });
  check("the built image reports its commit", set.version === "abc1234");
  check("TZ is reported", set.config.tz === "America/Los_Angeles");
  check("a custom duration is reported", set.config.taskDefaultDurationMin === 45);
  check("timed alarms are reported", JSON.stringify(set.config.ics.timedAlarmsMin) === "[60,15]");
  check("…and so is the all-day default they imply",
    JSON.stringify(set.config.ics.allDayAlarmsAt) === '["09:00"]');
  check("a nonsense duration falls back rather than reporting NaN",
    build({ TASK_DEFAULT_DURATION_MIN: "abc" }).config.taskDefaultDurationMin === 30);
}

console.log("test: no secret reaches an unauthenticated endpoint");
{
  const SECRETS = {
    GITHUB_TOKEN: "ghp_tokenvalue0000",
    GITHUB_REPO: "owner/private-repo",
    NOTIFY_URL: "https://ntfy.sh/braindance-a3f19c7d2b84e560",
    VAULT_PATH: "/srv/vault-secret-path",
    REPO_PATH: "/srv/repo-secret-path",
    AWS_SECRET_ACCESS_KEY: "aws_secret_value0",
    S3_BUCKET: "bucket-name-secret",
    // The suggestion worker's credential — the newest way this endpoint could
    // leak one. /health may say anything about the worker at all only because
    // the key collapses to a boolean before it gets here.
    ANTHROPIC_API_KEY: "sk-ant-secretkey000",
  };
  // AI_SUGGEST=1 so the key is actually consulted: a leak guard that runs with
  // the feature off passes without touching the branch it exists to guard.
  const out = JSON.stringify(build({ ...SECRETS, TZ: "UTC", TODO_ICS_ALARM_MIN: "15", AI_SUGGEST: "1" }));
  for (const [name, value] of Object.entries(SECRETS)) {
    check(`${name}'s value is absent from the response`, !out.includes(value));
  }
  // The allowlist itself: adding a field means updating this, which is the point.
  const keys = Object.keys(build({}).config).sort().join(",");
  check("config exposes only the known-safe keys", keys === "ai,ics,taskDefaultDurationMin,today,tz");
}

console.log("test: the suggestion worker reports its state, not its credential");
{
  const off = build({}).config.ai;
  check("with neither knob set the worker reads as off", off.suggest === false);
  check("…and the model it would use is still reported", off.model === "claude-haiku-4-5");
  check("the flag alone is not enough — a key is the other half",
    build({ AI_SUGGEST: "1" }).config.ai.suggest === false);
  check("a key alone is not enough either — the flag is opt-in",
    build({ ANTHROPIC_API_KEY: "sk-ant-x" }).config.ai.suggest === false);
  check("both halves present reads as on",
    build({ AI_SUGGEST: "1", ANTHROPIC_API_KEY: "sk-ant-x" }).config.ai.suggest === true);
  check("an AI_MODEL override is reported — answering 'did the env edit land?'",
    build({ AI_MODEL: "claude-sonnet-5" }).config.ai.model === "claude-sonnet-5");
}

console.log(`\n${passed} checks passed`);
