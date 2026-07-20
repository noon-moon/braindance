// Tests the object-backed VaultAdapter against the in-memory ObjectStore — the
// same commit/history/revert/lease semantics the git adapter has, proving the
// vault is portable across backends. Run: `npm run test:object`.
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { MemoryObjectStore } from "../src/objectstore.js";
import { ObjectVaultAdapter } from "../src/objectadapter.js";

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const root = mkdtempSync(join(tmpdir(), "bd-objadapter-"));
  try {
    console.log("test: commit builds a tree; history is an op log");
    const store = new MemoryObjectStore();
    const a = new ObjectVaultAdapter({ store, localDir: join(root, "mat") });
    const r1 = await a.commit({ ops: [{ op: "put", path: "A.md", content: "alpha" }] }, { message: "add A" });
    const r2 = await a.commit(
      { ops: [{ op: "put", path: "B.md", content: "beta" }, { op: "put", path: "A.md", content: "alpha2" }] },
      { message: "add B, edit A" },
    );
    check("commit returns an op id", r1.id.startsWith("op_"));
    check("multi-file changeset reports all paths", r2.paths.length === 2);
    const hist = await a.history();
    check("history newest-first", hist[0].message === "add B, edit A" && hist[1].message === "add A");
    check("history top id matches last commit", hist[0].id === r2.id);
    check("history path filter", (await a.history({ path: "B.md" })).length === 1);

    console.log("test: materialize projects the current tree");
    await a.materialize();
    check("materialized A.md has the latest content", readFileSync(join(root, "mat", "A.md"), "utf8") === "alpha2");
    check("materialized B.md exists", existsSync(join(root, "mat", "B.md")));

    console.log("test: delete + revert restores");
    const r3 = await a.commit({ ops: [{ op: "delete", path: "B.md" }] }, { message: "drop B" });
    check("delete is history-visible", (await a.history())[0].message === "drop B");
    const rev = await a.revert(r3.id);
    check("revert creates a new op", rev.id !== r3.id);
    rmSync(join(root, "mat"), { recursive: true, force: true });
    await a.materialize();
    check("reverting the delete restores B.md", readFileSync(join(root, "mat", "B.md"), "utf8") === "beta");

    console.log("test: revert conflict detection");
    // r1 set A.md=alpha; r2 later changed A.md. Reverting r1 must conflict.
    let threw = false;
    try {
      await a.revert(r1.id);
    } catch {
      threw = true;
    }
    check("reverting an op whose path later changed conflicts", threw);

    console.log("test: lease over the object store (CAS, fencing, expiry)");
    const x = new ObjectVaultAdapter({ store: new MemoryObjectStore() });
    const la = await x.acquireLease("A", 10_000);
    check("A acquires the lease", la?.holder === "A");
    check("B refused while A's lease is valid", (await x.acquireLease("B", 10_000)) === null);
    const la2 = await x.renewLease(la!, 10_000);
    check("A renews (token unchanged)", la2?.token === la!.token);
    await x.releaseLease(la2!);
    const lb = await x.acquireLease("B", 10_000);
    check("B acquires after release, fencing token bumped", (lb?.token ?? 0) > (la?.token ?? 0));
    check("A can no longer renew (fenced out)", (await x.renewLease(la2!, 10_000)) === null);
    await x.releaseLease(lb!);
    const short = await x.acquireLease("A", 5);
    await sleep(25);
    const lc = await x.acquireLease("B", 10_000);
    check("B takes over an expired lease, token bumped", (lc?.token ?? 0) > (short?.token ?? 0));

    console.log(`\nAll ${passed} checks passed.`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("\nTEST FAILED:", e);
  process.exit(1);
});
