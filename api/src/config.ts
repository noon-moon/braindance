// Where the vault is, and the model knobs. Two facts, one file.
//
// THE VAULT IS `VAULT_PATH` AND NOTHING ELSE. It used to be composed —
// `<REPO_PATH>/<VAULT_SUBDIR>`, defaulting to `/srv/braindance/ctx/vault` —
// from a time when the vault lived inside this checkout. That cutover happened;
// the vault is its own repo. What survived was a DEFAULT that pointed at a
// stale nested directory, derived independently in three modules, and it did
// exactly what a wrong default does: a live pass ran for an evening writing to
// a checkout nobody reads, because the wrapper knew the real path and did not
// pass it on. Nothing composes it now, and nothing has a fallback to be wrong
// about.
//
// Empty when unset — the caller checks and says so (see `announceVault` in
// cli.ts). A tool that writes to a vault should never leave which one implicit.
export const VAULT = process.env.VAULT_PATH ?? "";

export interface AiSuggestConfig {
  /** Both halves must be present: the feature flag AND a key. Either missing and
   *  the worker never starts, so the app makes no network call at all. */
  enabled: boolean;
  model: string;
  intervalMs: number;
}

/** Resolve the suggestion knobs from the environment. Takes `env` so /health can
 *  report the same values without reaching for the process — the icsOptionsFromEnv
 *  pattern, and for the same reason: a report that can drift from behaviour is
 *  worse than no report.
 *
 *  ANTHROPIC_API_KEY is read HERE ONLY to answer "is a key present". Its value is
 *  never returned, logged, or passed anywhere — the SDK client picks it up from
 *  the environment itself. */
export function aiSuggestConfig(env: NodeJS.ProcessEnv = process.env): AiSuggestConfig {
  const interval = Number(env.SUGGEST_INTERVAL_MS ?? 60000);
  return {
    enabled: env.AI_SUGGEST === "1" && Boolean(env.ANTHROPIC_API_KEY?.trim()),
    // Sonnet, not Haiku, and deliberately not Opus. Cost is not the deciding
    // factor at personal capture volume — the whole spread is a couple of
    // dollars a month — and latency doesn't matter either, since this runs in a
    // background worker on an interval, not on anyone's tap. What matters is how
    // often the suggestion is RIGHT: every bad scope or clumsy title is a
    // correction at the desk, which is the one thing this feature exists to
    // avoid. Matching a free-text note against ~36 bespoke scopes is intent
    // work, not keyword overlap, and that is where the tiers actually differ.
    //
    // CONSTRAINT: suggest.ts sends `output_config.effort`, which Haiku 4.5
    // REJECTS with a 400. An override here must be a Sonnet- or Opus-tier model.
    model: env.AI_MODEL?.trim() || "claude-sonnet-5",
    intervalMs: Number.isFinite(interval) && interval >= 5000 ? interval : 60000,
  };
}
