// The `/health` payload, built here so it can be tested without booting a server.
//
// This endpoint is the deploy diagnostic: from outside the box a stale image and
// an unapplied `/srv/.env` edit look identical, so it reports the build it is
// running and the settings it actually resolved.
//
// SECURITY: `/health` is UNAUTHENTICATED — the api is Tailscale-only and has no
// auth of its own. So this carries task and calendar settings only. A token, a
// git remote URL (which embeds one) and a notify endpoint are each a bearer
// credential, and none of them belong in a response anyone on the tailnet can
// fetch. `health.test.ts` asserts that by building a payload in an environment
// full of secrets and searching the output for them.
import { todayISO } from "./tasks.js";
import { icsOptionsFromEnv } from "./ics.js";
import { aiSuggestConfig } from "./config.js";
import { reconcileIntervalMs, DEFAULT_RECONCILE_INTERVAL_MS, type GitStoreStatus } from "./git.js";

export interface HealthPayload {
  ok: true;
  /** Commit the image was built from (api/Dockerfile's BUILD_SHA), else "dev". */
  version: string;
  sync: GitStoreStatus;
  config: {
    /** Unset means the container's UTC decides what "Today" means — the most
     *  surprising misconfiguration here, so it is reported explicitly. */
    tz: string | null;
    today: string;
    /** How often the store reconciles with the remote, in ms — the ceiling on
     *  how long an edit pushed from another machine takes to appear here.
     *
     *  Reported because it is otherwise unobservable from outside: the knob
     *  falls back to the default on an unparseable value rather than disarming
     *  the timer, so `GIT_PULL_INTERVAL_MS=10s` looks *exactly* like never
     *  having set it — the box just quietly keeps polling every 5 minutes. `0`
     *  means the timer is off and only POST /sync reconciles. */
    reconcileIntervalMs: number;
    taskDefaultDurationMin: number;
    /** The suggestion worker: whether it is running, and on what. Both halves of
     *  "enabled" (AI_SUGGEST=1 **and** a key) collapse into one boolean, which is
     *  the only thing that can be said about ANTHROPIC_API_KEY here — its value
     *  is a bearer credential and this endpoint is unauthenticated. The model id
     *  is reported unconditionally: answering "did the AI_MODEL edit land?" is
     *  the whole reason this endpoint exists, and `suggest` says whether it's in
     *  use. */
    ai: { suggest: boolean; model: string };
    ics: {
      baseUrl: string | null;
      timedAlarmsMin: number[];
      allDayAlarmsAt: string[];
    };
  };
}

export function healthPayload(sync: GitStoreStatus, env: NodeJS.ProcessEnv = process.env): HealthPayload {
  // The SAME resolvers the feed and the worker use, so the report cannot drift
  // from behaviour.
  const ics = icsOptionsFromEnv(env);
  const ai = aiSuggestConfig(env);
  return {
    ok: true,
    version: env.BUILD_SHA || "dev",
    sync,
    config: {
      tz: env.TZ || null,
      today: todayISO(),
      reconcileIntervalMs: reconcileIntervalMs(env.GIT_PULL_INTERVAL_MS, DEFAULT_RECONCILE_INTERVAL_MS),
      taskDefaultDurationMin: Number(env.TASK_DEFAULT_DURATION_MIN ?? 30) || 30,
      ai: { suggest: ai.enabled, model: ai.model },
      ics: {
        baseUrl: ics.baseUrl ?? null,
        timedAlarmsMin: ics.alarmsMin ?? [],
        allDayAlarmsAt: ics.alldayAlarmsAt ?? [],
      },
    },
  };
}
