// Unit test for the proposal store against a scratch PROPOSALS_DIR.
// Run: `npm run test:proposals`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// Point the store at a temp dir BEFORE importing it (module reads env at load).
const dir = mkdtempSync(join(tmpdir(), "bd-proposals-"));
process.env.PROPOSALS_DIR = dir;
const { submitProposal, getProposal, listProposals, setStatus, removeProposal, updateProposal } = await import("../src/proposals.js");

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};
const rejects = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

async function main() {
  try {
    console.log("test: submit → persist → round-trip");
    const p = await submitProposal({
      intent: "triage the inbox",
      rationale: "file 2, drop 1",
      changeset: [
        { op: "put", path: "All Neon Like.md", content: "x" },
        { op: "delete", path: "inbox/old.md" },
      ],
      contextPointers: ["Topics.md"],
    });
    check("submit returns a prefixed id + pending status", p.id.startsWith("prop_") && p.status === "pending");
    check("submit records an ISO createdAt", typeof p.createdAt === "string" && p.createdAt.includes("T"));

    const got = await getProposal(p.id);
    check("getProposal round-trips the changeset", got?.changeset.length === 2 && got.changeset[0].path === "All Neon Like.md");
    check("getProposal preserves rationale + contextPointers", got?.rationale === "file 2, drop 1" && got?.contextPointers?.[0] === "Topics.md");

    console.log("test: list ordering + status filter");
    await new Promise((r) => setTimeout(r, 5));
    const p2 = await submitProposal({ intent: "second", changeset: [{ op: "put", path: "b.md", content: "b" }] });
    const pend = await listProposals("pending");
    check("listProposals returns both pending", pend.length === 2);
    check("listProposals is newest-first", pend[0].id === p2.id);

    const approved = await setStatus(p.id, "approved");
    check("setStatus flips to approved", approved?.status === "approved");
    const pendAfter = await listProposals("pending");
    check("approved proposal drops out of pending", pendAfter.length === 1 && pendAfter[0].id === p2.id);
    check("listProposals('approved') finds it", (await listProposals("approved")).some((x) => x.id === p.id));

    await removeProposal(p2.id);
    check("removeProposal deletes it", (await getProposal(p2.id)) === null);

    console.log("test: updateProposal (edit) + returned status");
    const p3 = await submitProposal({ intent: "orig", changeset: [{ op: "put", path: "z.md", content: "z" }] });
    const up = await updateProposal(p3.id, {
      intent: "edited",
      changeset: [{ op: "put", path: "z.md", content: "EDITED" }],
      status: "returned",
      feedback: "please revise",
    });
    check("updateProposal merges intent", up?.intent === "edited");
    check("updateProposal merges changeset content", up?.changeset[0].op === "put" && up.changeset[0].content === "EDITED");
    check("updateProposal sets status + feedback", up?.status === "returned" && up?.feedback === "please revise");
    check("returned drops out of the pending list", !(await listProposals("pending")).some((x) => x.id === p3.id));
    check("listProposals('returned') finds it", (await listProposals("returned")).some((x) => x.id === p3.id));

    console.log("test: validation");
    check("empty intent rejected", await rejects(() => submitProposal({ intent: "  ", changeset: [{ op: "put", path: "a", content: "x" }] })));
    check("empty changeset rejected", await rejects(() => submitProposal({ intent: "x", changeset: [] })));
    // deliberately malformed inputs (bypassing the types) must be rejected at runtime
    check("invalid op rejected", await rejects(() => submitProposal({ intent: "x", changeset: [{ op: "nuke", path: "a" }] } as never)));
    check("put without content rejected", await rejects(() => submitProposal({ intent: "x", changeset: [{ op: "put", path: "a" }] } as never)));

    console.log(`\nAll ${passed} checks passed.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("\nTEST FAILED:", e);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
