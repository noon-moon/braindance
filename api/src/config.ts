// Shared vault-location config.
//
// Also the one place the AI-suggestion knobs resolve, so /health can report what
// the worker is running without importing the worker (or the SDK).
//
// The api commits captures into (and the viewer reads) a vault that lives at
// <REPO_PATH>/<VAULT_SUBDIR>. Today VAULT_SUBDIR="ctx/vault" — the vault sits
// inside the braindance checkout. At the v2 cutover the vault becomes its own
// repo whose ROOT is the vault, so VAULT_SUBDIR="" and paths collapse to
// `inbox/…`. Everything derives from these two values, so the flip is config-only.
import { join, resolve } from "node:path";

export const REPO_PATH = process.env.REPO_PATH ?? "/srv/braindance";
export const VAULT_SUBDIR = process.env.VAULT_SUBDIR ?? "ctx/vault";

/** Where agent proposals live — api-owned control-plane state, outside the vault
 *  checkout so nothing here is ever captured or synced. */
export const PROPOSALS_DIR = process.env.PROPOSALS_DIR ?? join(REPO_PATH, "..", "braindance-proposals");

/** Where the suggestion worker's sidecars live. OUTSIDE the vault checkout —
 *  same reason as PROPOSALS_DIR: a sidecar is api-owned control-plane state, and
 *  the one guarantee the worker makes is that nothing it writes can reach the
 *  vault except through the user's click. A directory the git store can't see
 *  makes that structural rather than a rule.
 *
 *  An absolute literal rather than a path derived from REPO_PATH, because this
 *  directory is a NAMED DOCKER VOLUME (docker-compose.yml) and a mount point is
 *  a fixed string: a default that moved with REPO_PATH would, on the day
 *  REPO_PATH changes, quietly point at the container's ephemeral layer again and
 *  silently un-persist every `dead` marker the cost story rests on. Override
 *  with SUGGESTIONS_DIR — but then move the volume's mount point with it. */
export const SUGGESTIONS_DIR = process.env.SUGGESTIONS_DIR ?? "/srv/braindance-suggestions";

/** The two api-owned state dirs pointing at the same place, or null.
 *
 *  Checked because the suggestion store PRUNES: it deletes sidecars whose note
 *  has left the inbox, and pointed at the proposals dir that sweep would be a
 *  silent mass delete of every pending proposal on the first tick. Cheap to
 *  detect, unrecoverable if missed, so the suggestion feature refuses to run at
 *  all rather than trusting a prefix check to save it. */
export function stateDirConflict(): string | null {
  return resolve(SUGGESTIONS_DIR) === resolve(PROPOSALS_DIR)
    ? `SUGGESTIONS_DIR and PROPOSALS_DIR both resolve to ${resolve(SUGGESTIONS_DIR)}`
    : null;
}

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
    // Haiku is the right tier for this job: one small, schema-constrained
    // classification per capture, with no reasoning required — at 1/5th Opus's
    // price in both directions. NOTE: Haiku 4.5 REJECTS `output_config.effort`,
    // which is why suggest.ts no longer sends it. Read that comment before
    // pointing this at a model whose cost you'd want to tune with effort.
    model: env.AI_MODEL?.trim() || "claude-haiku-4-5",
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
