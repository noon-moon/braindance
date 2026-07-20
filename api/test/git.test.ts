// Integration test for the local-first GitStore against a scratch git repo that
// simulates /srv/braindance with a fake (bare) remote. Run: `npm run test:git`.
//
// Exercises: capture → local-commit → async push; concurrent captures serialized
// by the one lock; a pull --rebase reconcile of an external commit; and the
// abort-on-conflict path (rebase conflict → abort + `conflicted` flag, local
// commits preserved, no clobber).
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { GitStore, redactToken } from "../src/git.js";
import { vaultRel } from "../src/config.js";

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

const root = mkdtempSync(join(tmpdir(), "bd-gitstore-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let caseN = 0;
function setup(): { repo: string; remote: string; other: string } {
  const base = mkdtempSync(join(root, `case${caseN++}-`));
  const remote = join(base, "remote.git"); // fake GitHub origin (bare)
  const repo = join(base, "srv-braindance"); // the api's working checkout
  const other = join(base, "laptop"); // a second clone (Obsidian-on-laptop)

  git(base, "init", "--bare", "-b", "main", remote);

  git(root, "clone", remote, repo);
  git(repo, "config", "user.name", "seed");
  git(repo, "config", "user.email", "seed@local");
  writeFileSync(join(repo, "README.md"), "# seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");
  git(repo, "push", "origin", "main");

  git(root, "clone", remote, other);
  git(other, "config", "user.name", "laptop");
  git(other, "config", "user.email", "laptop@local");

  return { repo, remote, other };
}

const newStore = (repo: string, remote: string) =>
  new GitStore({
    repoPath: repo,
    remoteUrl: remote, // a local bare path is a valid git remote
    authorName: "braindance-api",
    authorEmail: "api@braindance.local",
    pushRetryBaseMs: 5,
    pushMaxRetries: 1,
    pushRetryDelayMs: 50,
    logger: () => undefined, // quiet expected-failure logs
  });

async function testCaptureCommitAndPush() {
  console.log("test: capture → local commit → async push");
  const { repo, remote, other } = setup();
  const store = newStore(repo, remote);
  await store.init();

  const before = git(repo, "rev-parse", "HEAD");
  const { path } = await store.commitCapture(
    "ctx/vault/inbox/2026-07-13-a.md",
    "---\ntags: [memo]\n---\nhello\n",
    "inbox: memo capture",
  );
  const after = git(repo, "rev-parse", "HEAD");

  check("local commit landed immediately (HEAD advanced)", before !== after);
  check("capture file exists in working tree", existsSync(join(repo, path)));
  check("commit author is the configured identity", git(repo, "log", "-1", "--format=%an") === "braindance-api");

  await store.flush();
  // Pull into the other clone and confirm the capture was pushed to the remote.
  git(other, "pull", "origin", "main");
  check("capture pushed to remote (visible from a second clone)", existsSync(join(other, path)));
  check("no conflict flag after clean push", store.status().conflicted === false);
}

async function testConcurrentCapturesSerialized() {
  console.log("test: concurrent captures serialized by the lock");
  const { repo, remote, other } = setup();
  const store = newStore(repo, remote);
  await store.init();

  const N = 8;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      store.commitCapture(`ctx/vault/inbox/2026-07-13-c${i}.md`, `body ${i}\n`, `inbox: capture ${i}`),
    ),
  );
  await store.flush();

  const inbox = join(repo, "ctx/vault/inbox");
  check(`all ${N} captures committed with no lost writes`, readdirSync(inbox).length === N);
  // A clean linear history (no corrupt/interleaved commits) — N captures + seed,
  // each a single-parent commit reachable from HEAD.
  const count = Number(git(repo, "rev-list", "--count", "HEAD"));
  check(`history is linear (${count} commits = seed + ${N})`, count === N + 1);

  await new Promise((r) => setTimeout(r, 20));
  git(other, "pull", "origin", "main");
  check("all captures reached the remote", readdirSync(join(other, "ctx/vault/inbox")).length === N);
}

async function testPullRebaseReconcile() {
  console.log("test: pull --rebase reconciles an external commit");
  const { repo, remote, other } = setup();
  const store = newStore(repo, remote);
  await store.init();

  // An external writer (laptop/Obsidian) pushes a NEW file to the remote…
  writeFileSync(join(other, "laptop-note.md"), "from the laptop\n");
  git(other, "add", "-A");
  git(other, "commit", "-m", "laptop: external note");
  git(other, "push", "origin", "main");

  // …meanwhile the api makes a local capture, then reconciles (pull --rebase).
  await store.commitCapture("ctx/vault/inbox/2026-07-13-r.md", "local\n", "inbox: local capture");
  await store.flush();

  check("external commit pulled into the api checkout", existsSync(join(repo, "laptop-note.md")));
  check("local capture preserved through the rebase", existsSync(join(repo, "ctx/vault/inbox/2026-07-13-r.md")));

  // The api's local commit is now on top of the external one, and pushed.
  git(other, "pull", "origin", "main");
  check("api capture pushed on top of the external commit", existsSync(join(other, "ctx/vault/inbox/2026-07-13-r.md")));
  check("no conflict flag (disjoint files rebase cleanly)", store.status().conflicted === false);
}

async function testConflictAbort() {
  console.log("test: rebase conflict → abort + flag, local commit preserved");
  const { repo, remote, other } = setup();
  const store = newStore(repo, remote);
  await store.init();

  // Both writers modify the SAME file divergently → a real rebase conflict.
  writeFileSync(join(other, "shared.md"), "REMOTE version\n");
  git(other, "add", "-A");
  git(other, "commit", "-m", "laptop: shared REMOTE");
  git(other, "push", "origin", "main");

  await store.commitCapture("shared.md", "LOCAL version\n", "api: shared LOCAL");
  const localHead = git(repo, "rev-parse", "HEAD");

  await store.flush(); // triggers reconcile → conflict → abort

  check("conflict flag raised (sync paused, not clobbered)", store.status().conflicted === true);
  check("local commit preserved after abort (HEAD unchanged)", git(repo, "rev-parse", "HEAD") === localHead);
  check("local file content intact (no silent clobber)", git(repo, "show", "HEAD:shared.md") === "LOCAL version");
  check("no rebase left in progress (aborted cleanly)", !existsSync(join(repo, ".git", "rebase-merge")) && !existsSync(join(repo, ".git", "rebase-apply")));
  // The remote still has only its own commit — the api did not force anything.
  git(other, "log", "-1", "--format=%s");
  check("remote unchanged (api did not push over the conflict)", git(other, "show", "HEAD:shared.md") === "REMOTE version");
}

async function testAtomicChangeset() {
  console.log("test: changeset commit is atomic (multi-file put + delete, one commit)");
  const { repo, remote, other } = setup();
  const store = newStore(repo, remote);
  await store.init();

  // Seed a file the changeset will delete in the same operation.
  await store.commitCapture("ctx/vault/inbox/old.md", "old\n", "seed old");
  const before = Number(git(repo, "rev-list", "--count", "HEAD"));

  const res = await store.commit(
    {
      ops: [
        { op: "put", path: "ctx/vault/A.md", content: "A\n" },
        { op: "put", path: "ctx/vault/B.md", content: "B\n" },
        { op: "delete", path: "ctx/vault/inbox/old.md" },
      ],
    },
    { message: "op: multi-file changeset" },
  );
  const after = Number(git(repo, "rev-list", "--count", "HEAD"));

  check("changeset applied as exactly ONE commit", after === before + 1);
  check("returned op id matches HEAD", res.id === git(repo, "rev-parse", "HEAD"));
  check("all three touched paths reported", res.paths.length === 3);
  check("put A landed", existsSync(join(repo, "ctx/vault/A.md")));
  check("put B landed", existsSync(join(repo, "ctx/vault/B.md")));
  check("delete removed old.md", !existsSync(join(repo, "ctx/vault/inbox/old.md")));

  await store.flush();
  git(other, "pull", "origin", "main");
  check(
    "whole changeset pushed atomically (puts present, delete applied on remote)",
    existsSync(join(other, "ctx/vault/A.md")) && !existsSync(join(other, "ctx/vault/inbox/old.md")),
  );
  check("no conflict after clean push", store.status().conflicted === false);
}

async function testUnsafePathRejected() {
  console.log("test: changeset with an unsafe path is rejected");
  const { repo, remote } = setup();
  const store = newStore(repo, remote);
  await store.init();
  let threw = false;
  try {
    await store.commit({ ops: [{ op: "put", path: "../escape.md", content: "x" }] }, { message: "bad" });
  } catch {
    threw = true;
  }
  check("`..` traversal path rejected", threw);
  check("nothing committed for the rejected op", !existsSync(join(repo, "escape.md")));
}

async function testHistoryAndRevert() {
  console.log("test: history() lists ops newest-first; revert() undoes one as a new op");
  const { repo, remote, other } = setup();
  const store = newStore(repo, remote);
  await store.init();

  await store.commitCapture("ctx/vault/inbox/h1.md", "one\n", "op: capture h1");
  const r2 = await store.commit(
    { ops: [{ op: "put", path: "ctx/vault/H2.md", content: "two\n" }] },
    { message: "op: add H2" },
  );

  const hist = await store.history({ limit: 10 });
  check("history newest-first (top op is 'add H2')", hist[0].message === "op: add H2");
  check("history top op id matches the commit", hist[0].id === r2.id);
  check("history records the touched path", hist[0].paths.includes("ctx/vault/H2.md"));
  check("history includes the earlier capture", hist.some((o) => o.message === "op: capture h1"));

  const headBefore = git(repo, "rev-parse", "HEAD");
  const rev = await store.revert(r2.id);
  check("revert created a NEW op (HEAD advanced)", git(repo, "rev-parse", "HEAD") !== headBefore);
  check("returned revert id is the new HEAD", rev.id === git(repo, "rev-parse", "HEAD"));
  check("reverted file removed from the working tree", !existsSync(join(repo, "ctx/vault/H2.md")));

  await store.flush();
  git(other, "pull", "origin", "main");
  check("revert pushed to remote (file gone from a second clone)", !existsSync(join(other, "ctx/vault/H2.md")));
  check("no conflict flag after revert push", store.status().conflicted === false);
}

async function testLease() {
  console.log("test: single-writer lease — mutual exclusion, renew, release, fencing, expiry");
  const { repo, remote } = setup();
  // Two instances sharing the SAME on-disk checkout (the real topology: a second
  // api process on the same mounted volume).
  const a = newStore(repo, remote);
  const b = newStore(repo, remote);
  await a.init();

  const la = await a.acquireLease("A", 10_000);
  check("A acquires the lease", la !== null && la.holder === "A");
  check("B is refused while A's lease is valid", (await b.acquireLease("B", 10_000)) === null);

  const la2 = await a.renewLease(la!, 10_000);
  check("A renews (fencing token unchanged on renew)", la2 !== null && la2.token === la!.token);

  await a.releaseLease(la2!);
  const lb = await b.acquireLease("B", 10_000);
  check("B acquires after A releases", lb !== null && lb.holder === "B");
  check("fencing token strictly increases on takeover", lb!.token > la!.token);
  check("A (fenced out) can no longer renew", (await a.renewLease(la2!, 10_000)) === null);

  // Expiry takeover: A grabs a very short lease, lets it lapse, B takes over.
  await b.releaseLease(lb!);
  const short = await a.acquireLease("A", 5);
  check("A re-acquires with a short ttl", short !== null);
  await new Promise((r) => setTimeout(r, 25));
  const lb2 = await b.acquireLease("B", 10_000);
  check("B takes over an EXPIRED lease", lb2 !== null && lb2.holder === "B");
  check("expiry takeover also bumps the fencing token", lb2!.token > short!.token);
}

async function testLeaseGatedCommit() {
  console.log("test: commit() is gated on the writer lease when requireLease is on");
  const { repo, remote } = setup();
  const leaseStore = (holder: string) =>
    new GitStore({
      repoPath: repo,
      remoteUrl: remote,
      authorName: "braindance-api",
      authorEmail: "api@braindance.local",
      pushRetryBaseMs: 5,
      pushMaxRetries: 1,
      requireLease: true,
      leaseHolder: holder,
      leaseTtlMs: 10_000,
      logger: () => undefined,
    });
  const a = leaseStore("A");
  const b = leaseStore("B");
  await a.init();

  check("A acquires the writer lease", (await a.acquireWriterLease()) === true);
  check("A status reports holdsLease", a.status().holdsLease === true);
  await a.commit({ ops: [{ op: "put", path: "ctx/vault/g1.md", content: "1\n" }] }, { message: "a: g1" });
  await a.flush();
  check("A commits while holding the lease", existsSync(join(repo, "ctx/vault/g1.md")));

  check("B cannot acquire while A holds the lease", (await b.acquireWriterLease()) === false);
  let refused = false;
  try {
    await b.commit({ ops: [{ op: "put", path: "ctx/vault/g2.md", content: "2\n" }] }, { message: "b: g2" });
  } catch {
    refused = true;
  }
  check("B commit refused without the lease", refused);
  check("B's write did not land", !existsSync(join(repo, "ctx/vault/g2.md")));

  a.stop(); // releases A's lease (async, best-effort)
  let bGot = false;
  for (let i = 0; i < 25 && !bGot; i++) {
    bGot = await b.acquireWriterLease();
    if (!bGot) await new Promise((r) => setTimeout(r, 10));
  }
  check("B acquires the lease after A releases", bGot);
  await b.commit({ ops: [{ op: "put", path: "ctx/vault/g3.md", content: "3\n" }] }, { message: "b: g3" });
  await b.flush();
  check("B commits after taking over the lease", existsSync(join(repo, "ctx/vault/g3.md")));
  b.stop();
}

function testRedactToken() {
  console.log("test: redactToken strips auth secrets from log strings");
  const url = "pull https://x-access-token:ghp_SECRETsecret1234567890@github.com/o/r.git main";
  const red = redactToken(url);
  check("x-access-token URL is redacted", red === "pull https://x-access-token:***@github.com/o/r.git main");
  check("no PAT substring survives the URL redaction", !red.includes("ghp_SECRET"));
  check("a bare ghp_ token is redacted", redactToken("token=ghp_ABCDEFGHIJ1234567890 end") === "token=*** end");
  check("a github_pat_ token is redacted", !redactToken("github_pat_11ABCDEFG0123456789 x").includes("github_pat_11ABCDEFG"));
  check("non-secret text is untouched", redactToken("just a normal message") === "just a normal message");
}

function testVaultRel() {
  console.log("test: vaultRel builds vault-relative paths for both layouts");
  check("default subdir → ctx/vault/inbox/x.md", vaultRel("ctx/vault", "inbox", "x.md") === "ctx/vault/inbox/x.md");
  check("empty subdir (vault-root) → inbox/x.md", vaultRel("", "inbox", "x.md") === "inbox/x.md");
  check("no segments → just the subdir", vaultRel("ctx/vault") === "ctx/vault");
}

async function main() {
  try {
    testRedactToken();
    testVaultRel();
    await testCaptureCommitAndPush();
    await testConcurrentCapturesSerialized();
    await testPullRebaseReconcile();
    await testConflictAbort();
    await testAtomicChangeset();
    await testUnsafePathRejected();
    await testHistoryAndRevert();
    await testLease();
    await testLeaseGatedCommit();
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
