// Shared vault-location config.
//
// The api commits captures into (and the viewer reads) a vault that lives at
// <REPO_PATH>/<VAULT_SUBDIR>. Today VAULT_SUBDIR="ctx/vault" — the vault sits
// inside the braindance checkout. At the v2 cutover the vault becomes its own
// repo whose ROOT is the vault, so VAULT_SUBDIR="" and paths collapse to
// `inbox/…`. Everything derives from these two values, so the flip is config-only.
export const REPO_PATH = process.env.REPO_PATH ?? "/srv/braindance";
export const VAULT_SUBDIR = process.env.VAULT_SUBDIR ?? "ctx/vault";

/** Build a repo-relative path inside the vault. Empty segments (e.g. an empty
 *  VAULT_SUBDIR when the checkout root IS the vault) drop out cleanly, so
 *  `vaultRel("ctx/vault","inbox","x.md")` → `ctx/vault/inbox/x.md` and
 *  `vaultRel("","inbox","x.md")` → `inbox/x.md`. */
export function vaultRel(subdir: string, ...segments: string[]): string {
  return [subdir, ...segments].filter(Boolean).join("/");
}
