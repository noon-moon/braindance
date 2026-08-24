// Shared vault-location config, and the one place the model knobs resolve.
//
// The api commits captures into (and the viewer reads) a vault that lives at
// <REPO_PATH>/<VAULT_SUBDIR>. Today VAULT_SUBDIR="ctx/vault" — the vault sits
// inside the braindance checkout. At the v2 cutover the vault becomes its own
// repo whose ROOT is the vault, so VAULT_SUBDIR="" and paths collapse to
// `inbox/…`. Everything derives from these two values, so the flip is config-only.
import { join, resolve } from "node:path";

export const REPO_PATH = process.env.REPO_PATH ?? "/srv/braindance";
export const VAULT_SUBDIR = process.env.VAULT_SUBDIR ?? "ctx/vault";

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

/** Build a repo-relative path inside the vault. Empty segments (e.g. an empty
 *  VAULT_SUBDIR when the checkout root IS the vault) drop out cleanly, so
 *  `vaultRel("ctx/vault","inbox","x.md")` → `ctx/vault/inbox/x.md` and
 *  `vaultRel("","inbox","x.md")` → `inbox/x.md`. */
export function vaultRel(subdir: string, ...segments: string[]): string {
  return [subdir, ...segments].filter(Boolean).join("/");
}
