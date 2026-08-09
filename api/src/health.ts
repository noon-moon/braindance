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
import type { GitStoreStatus } from "./git.js";

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
    taskDefaultDurationMin: number;
    ics: {
      baseUrl: string | null;
      timedAlarmsMin: number[];
      allDayAlarmsAt: string[];
    };
  };
}

export function healthPayload(sync: GitStoreStatus, env: NodeJS.ProcessEnv = process.env): HealthPayload {
  // The SAME resolver the feed uses, so the report cannot drift from behaviour.
  const ics = icsOptionsFromEnv(env);
  return {
    ok: true,
    version: env.BUILD_SHA || "dev",
    sync,
    config: {
      tz: env.TZ || null,
      today: todayISO(),
      taskDefaultDurationMin: Number(env.TASK_DEFAULT_DURATION_MIN ?? 30) || 30,
      ics: {
        baseUrl: ics.baseUrl ?? null,
        timedAlarmsMin: ics.alarmsMin ?? [],
        allDayAlarmsAt: ics.alldayAlarmsAt ?? [],
      },
    },
  };
}
