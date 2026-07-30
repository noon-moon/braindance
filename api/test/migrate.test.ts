// Migration tests — the portability payoff: move a vault between backends.
// object → object and git → object, proving the VaultAdapter interface makes
// them interchangeable. Run: `npm run test:migrate`.
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { MemoryObjectStore } from "../src/objectstore.js";
import { ObjectVaultAdapter } from "../src/objectadapter.js";
import { GitStore } from "../src/git.js";
import { migrateVault } from "../src/migrate.js";

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};
const root = mkdtempSync(join(tmpdir(), "bd-migrate-"));
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

async function main() {
  try {
    console.log("test: object → object migration");
    const src = new ObjectVaultAdapter({ store: new MemoryObjectStore() });
    await src.commit({ ops: [{ op: "put", path: "A.md", content: "a" }, { op: "put", path: "B.md", content: "b" }] }, { message: "seed" });
    await src.commit({ ops: [{ op: "delete", path: "B.md" }] }, { message: "drop B" });
    const matO = join(root, "obj-mat");
    const dst = new ObjectVaultAdapter({ store: new MemoryObjectStore(), localDir: matO });
    const m1 = await migrateVault(src, dst);
    check("migrates only the CURRENT tree (B was deleted)", m1.files === 1);
    await dst.materialize();
    check("A.md migrated with content", readFileSync(join(matO, "A.md"), "utf8") === "a");
    check("B.md not migrated (deleted at source)", !existsSync(join(matO, "B.md")));
    check("destination has a clean single-op history", (await dst.history()).length === 1);

    console.log("test: git → object migration");
    const repo = join(root, "repo");
    git(root, "init", "-q", "-b", "main", "repo");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "user.email", "t@t");
    writeFileSync(join(repo, "README.md"), "# seed\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "seed");
    const gs = new GitStore({ repoPath: repo, logger: () => undefined }); // no remote ⇒ local-only
    await gs.init();
    await gs.commitCapture("Note.md", "note body\n", "add Note");
    await gs.commitCapture("inbox/x.md", "inbox item\n", "capture x");

    const snap = await gs.snapshot();
    check("git snapshot lists all tracked files", "README.md" in snap && "Note.md" in snap && "inbox/x.md" in snap);
    const matG = join(root, "git-mat");
    const dstG = new ObjectVaultAdapter({ store: new MemoryObjectStore(), localDir: matG });
    const m2 = await migrateVault(gs, dstG);
    check("git→object migrated every tracked file", m2.files === Object.keys(snap).length);
    await dstG.materialize();
    check("file content survived the migration", readFileSync(join(matG, "Note.md"), "utf8") === "note body\n");
    check("nested path (inbox/x.md) survived", existsSync(join(matG, "inbox", "x.md")));

    console.log(`\nAll ${passed} checks passed.`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("\nTEST FAILED:", e);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
