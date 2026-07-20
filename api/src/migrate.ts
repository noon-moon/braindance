// Vault migration — the payoff of the portable VaultAdapter interface: move the
// whole vault from one backend to another (git ↔ object/S3) by snapshotting the
// source's current state and committing it into the destination as one
// operation. Because both backends satisfy the same interface, git and an object
// store are genuinely interchangeable.
//
// This migrates STATE (the current tree) as a single op. Full op-LOG replay
// (preserving every historical version) is a follow-up; the state migration is
// what makes "point it at a different backend" real.
import type { VaultAdapter } from "./adapter.js";

export async function migrateVault(
  source: VaultAdapter,
  dest: VaultAdapter,
  message = "migrate vault (snapshot)",
): Promise<{ id: string; files: number }> {
  const tree = await source.snapshot();
  const ops = Object.entries(tree).map(([path, content]) => ({ op: "put" as const, path, content }));
  if (ops.length === 0) return { id: "", files: 0 };
  const res = await dest.commit({ ops }, { message });
  return { id: res.id, files: ops.length };
}
