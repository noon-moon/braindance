// Local-first git store (Slice 1 of the admin-app redesign).
//
// Replaces the old GitHub Contents-API write path (a synchronous REST PUT to
// `main`) with a read-write *local working checkout* the api owns:
//
//   capture → write file + `git commit` LOCALLY (instant; the HTTP response
//   returns the moment the commit lands) → enqueue an ASYNC push to GitHub.
//
// The viewer (`vault.ts`) reads this same working tree, so a capture is visible
// on the very next read — the old ≤3-min "write to GitHub, wait for the host
// `git pull` timer" round-trip is gone.
//
// Reconcile model (the approved "(a) spine, (b) expectations" variant):
//   - Every network sync is `git pull --rebase` THEN `git push` — ff-only breaks
//     the moment the checkout has local commits, so we always rebase local
//     commits on top of incoming history.
//   - ONE in-process async mutex serializes *all* git mutations (commit, pull,
//     rebase, push) so they never interleave and corrupt HEAD/index. This api
//     process is the single owner of the checkout (the host `git pull` timer is
//     retired — see ops/), so an in-process lock is sufficient; if a second
//     writer of `/srv/braindance` is ever reintroduced, add an on-disk `flock`
//     over the same critical section.
//   - Captures use unique timestamped filenames, so two writes never touch the
//     same path and real conflicts are near-impossible. On the RARE rebase
//     conflict we ABORT the rebase (never silently clobber), raise a loud log +
//     a `conflicted` flag (a hook for a future conflict-resolution UI), and keep
//     serving locally; local commits stay intact and re-push once cleared.
import { simpleGit, type SimpleGit } from "simple-git";
import { mkdir, writeFile, access, readFile, unlink, open, stat, rename } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { hostname } from "node:os";
import type { VaultAdapter, Changeset, OpMeta, CommitResult, Op, Lease } from "./adapter.js";

/** Serializes async critical sections: each `run()` waits for the previous to
 *  settle, so git operations never interleave. A failure in one section does
 *  not poison the chain for the next. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** A rebase conflict during reconcile — surfaced, never auto-resolved. */
export class ConflictError extends Error {
  constructor(message = "rebase conflict during reconcile") {
    super(message);
    this.name = "ConflictError";
  }
}

export interface GitStoreOptions {
  repoPath: string;
  branch?: string;
  /** Authenticated remote URL for push/pull, or null for local-only (no network
   *  — commits still land locally and are visible; the push queue no-ops). */
  remoteUrl?: string | null;
  authorName?: string;
  authorEmail?: string;
  /** Base backoff (ms) for the push retry loop (doubles per attempt). */
  pushRetryBaseMs?: number;
  pushMaxRetries?: number;
  /** After exhausting immediate retries, how long before re-queuing a push. */
  pushRetryDelayMs?: number;
  /** Periodic inbound reconcile interval (ms); 0 disables the timer. */
  pullIntervalMs?: number;
  /** When true, this store must hold the single-writer lease to `commit()`.
   *  Off by default so the pre-cutover behaviour is unchanged. */
  requireLease?: boolean;
  /** Identity recorded in the lease (defaults to `<hostname>:<pid>`). */
  leaseHolder?: string;
  /** Lease TTL (ms); renewed at half this interval. */
  leaseTtlMs?: number;
  logger?: (msg: string, err?: unknown) => void;
}

export interface GitStoreStatus {
  /** true once a rebase conflict paused sync; cleared by a clean reconcile. */
  conflicted: boolean;
  /** a push is queued or in flight (local commits not yet confirmed on remote). */
  pending: boolean;
  /** whether this store currently holds the writer lease (only meaningful when
   *  requireLease is on). */
  holdsLease: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Reject paths that would escape the repo (absolute, or containing `..`). */
function assertSafeRelPath(relPath: string): void {
  if (isAbsolute(relPath) || relPath.split("/").includes("..")) {
    throw new Error(`unsafe path: ${relPath}`);
  }
}

/** Strip auth secrets (PATs, x-access-token URLs) from a string before logging.
 *  simple-git logs the failing command — including the authenticated remote URL —
 *  on error, so without this a git failure leaks the token into the logs. */
export function redactToken(s: string): string {
  return s
    .replace(/(x-access-token:)[^@\s"']+(@)/g, "$1***$2")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, "***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, "***");
}

/** Render an error to a redacted string — includes simple-git's `.task.commands`
 *  (where the auth URL hides) and scrubs any token from the whole thing. */
function errToRedacted(e: unknown): string {
  let s = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : safeStringify(e);
  const task = (e as { task?: { commands?: unknown } } | null)?.task;
  if (task?.commands !== undefined) s += ` task.commands=${safeStringify(task.commands)}`;
  return redactToken(s);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export class GitStore implements VaultAdapter {
  private readonly git: SimpleGit;
  private readonly repoPath: string;
  private readonly branch: string;
  private readonly remoteUrl: string | null;
  private readonly pushRetryBaseMs: number;
  private readonly pushMaxRetries: number;
  private readonly pushRetryDelayMs: number;
  private readonly pullIntervalMs: number;
  private readonly log: (msg: string, err?: unknown) => void;

  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly requireLease: boolean;
  private readonly leaseHolder: string;
  private readonly leaseTtlMs: number;
  private readonly lock = new Mutex();
  private pushRequested = false;
  private pushRunning = false;
  private conflicted = false;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private heldLease: Lease | null = null;
  private leaseRenewTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: GitStoreOptions) {
    this.repoPath = opts.repoPath;
    this.branch = opts.branch ?? "main";
    this.remoteUrl = opts.remoteUrl ?? null;
    this.pushRetryBaseMs = opts.pushRetryBaseMs ?? 500;
    this.pushMaxRetries = opts.pushMaxRetries ?? 4;
    this.pushRetryDelayMs = opts.pushRetryDelayMs ?? 30_000;
    this.pullIntervalMs = opts.pullIntervalMs ?? 0;
    const rawLog = opts.logger ?? ((m: string, e?: unknown) => (e !== undefined ? console.error(m, e) : console.log(m)));
    // Scrub any auth token from the message AND the error before it's logged —
    // git errors carry the authenticated remote URL, which would leak the PAT.
    this.log = (m, e) => rawLog(redactToken(m), e === undefined ? undefined : errToRedacted(e));
    this.authorName = opts.authorName ?? "braindance-api";
    this.authorEmail = opts.authorEmail ?? "api@braindance.local";
    this.requireLease = opts.requireLease ?? false;
    this.leaseHolder = opts.leaseHolder ?? `${hostname()}:${process.pid}`;
    this.leaseTtlMs = opts.leaseTtlMs ?? 60_000;

    // Never hang on an interactive credential prompt (a bad PAT must fail fast,
    // not block the push worker). Set once for the process.
    process.env.GIT_TERMINAL_PROMPT = "0";
    // NB: we deliberately DON'T call simple-git's `.env()` — it replaces the
    // whole child environment and rejects common ambient vars (EDITOR/PAGER…)
    // as "unsafe". Identity is set as local repo config in init() instead.
    this.git = simpleGit(this.repoPath);
  }

  /** One-time init: configure the commit identity on the checkout, and mark the
   *  mounted repo a safe directory (the container user differs from the host
   *  owner of `/srv/braindance`, which otherwise trips git's dubious-ownership
   *  guard). Best-effort — a fresh call is cheap and idempotent. */
  async init(): Promise<void> {
    try {
      await this.git.raw(["config", "--global", "--add", "safe.directory", this.repoPath]);
    } catch (e) {
      this.log("git safe.directory config failed (continuing)", e);
    }
    try {
      await this.git.addConfig("user.name", this.authorName);
      await this.git.addConfig("user.email", this.authorEmail);
    } catch (e) {
      this.log("git identity config failed (continuing)", e);
    }
  }

  status(): GitStoreStatus {
    return {
      conflicted: this.conflicted,
      pending: this.pushRequested || this.pushRunning,
      holdsLease: this.heldLease !== null,
    };
  }

  /** Start the periodic inbound reconcile (pull --rebase, coalesced through the
   *  same push worker so one owner drives every mutation). */
  start(): void {
    if (this.pullIntervalMs > 0 && !this.pullTimer) {
      this.pullTimer = setInterval(() => this.requestPush(), this.pullIntervalMs);
      this.pullTimer.unref?.();
    }
  }

  stop(): void {
    if (this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }
    if (this.leaseRenewTimer) {
      clearInterval(this.leaseRenewTimer);
      this.leaseRenewTimer = null;
    }
    if (this.heldLease) {
      const lease = this.heldLease;
      this.heldLease = null;
      // Best-effort release so a takeover proceeds sooner; never let a failure
      // (e.g. the checkout already gone during shutdown) become an unhandled
      // rejection.
      void this.releaseLease(lease).catch(() => undefined);
    }
  }

  /** Apply a changeset as ONE atomic operation (one commit), then enqueue an
   *  async push. Resolves as soon as the LOCAL commit lands — the caller never
   *  waits on the network. `put` creates/overwrites a file; `delete` removes
   *  one. All paths are repo-relative; the whole set commits or none does, so a
   *  multi-file operation is atomic and undoable as a unit (foundation for the
   *  versioning + proposal layers). */
  async commit(changeset: Changeset, meta: OpMeta): Promise<CommitResult> {
    const { ops } = changeset;
    if (ops.length === 0) throw new Error("empty changeset");
    const paths = ops.map((o) => o.path);
    for (const p of paths) assertSafeRelPath(p);

    let id = "";
    await this.lock.run(async () => {
      await this.assertLeaseHeld(); // fenced out ⇒ throw before mutating anything
      for (const op of ops) {
        const abs = join(this.repoPath, op.path);
        if (op.op === "put") {
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, op.content, "utf8");
          await this.git.add([op.path]);
        } else {
          await this.git.rm([op.path]);
        }
      }
      // Scope the commit to exactly this operation's paths — the api owns the
      // checkout, but a pathspec keeps an op self-contained regardless.
      await this.git.commit(meta.message, paths);
      id = (await this.git.revparse(["HEAD"])).trim();
    });
    this.requestPush();
    return { id, paths };
  }

  /** Convenience wrapper: a single-file `put` capture. Preserves the Slice-1
   *  signature (`relPath` e.g. `ctx/vault/inbox/<stamp>-<slug>.md`); resolves
   *  when the LOCAL commit lands. */
  async commitCapture(relPath: string, content: string, message: string): Promise<{ path: string }> {
    const { paths } = await this.commit({ ops: [{ op: "put", path: relPath, content }] }, { message });
    return { path: paths[0] };
  }

  /** The whole tracked tree as path→content (repo-relative paths) — the portable
   *  snapshot for migrating this vault to another backend. */
  async snapshot(): Promise<Record<string, string>> {
    const listed = (await this.git.raw(["ls-files"])).split("\n").map((f) => f.trim()).filter(Boolean);
    const tree: Record<string, string> = {};
    for (const f of listed) tree[f] = await readFile(join(this.repoPath, f), "utf8");
    return tree;
  }

  /** The operation log (git commit history), newest-first. Each op carries the
   *  paths it touched. Optionally filtered to ops touching `path`. */
  async history(opts: { path?: string; limit?: number } = {}): Promise<Op[]> {
    const limit = opts.limit ?? 50;
    // %x1e = record separator between commits; %x1f = field separator. With
    // --name-only, each commit's touched paths follow its header line.
    const args = ["log", `--max-count=${limit}`, "--name-only", "--pretty=format:%x1e%H%x1f%aI%x1f%s"];
    if (opts.path) args.push("--", opts.path);
    const raw = await this.git.raw(args);
    return raw
      .split("\x1e")
      .filter((b) => b.trim())
      .map((block) => {
        const lines = block.split("\n");
        const [id, date, message] = lines[0].split("\x1f");
        const paths = lines.slice(1).map((l) => l.trim()).filter(Boolean);
        return { id, date, message, paths };
      });
  }

  /** Undo an operation by committing its inverse (git revert) as a NEW op. On a
   *  revert conflict (later history touched the same lines) we abort and throw —
   *  never leave a half-applied revert. */
  async revert(opId: string): Promise<CommitResult> {
    if (!/^[0-9a-f]{7,40}$/i.test(opId)) throw new Error(`invalid op id: ${opId}`);
    let id = "";
    let paths: string[] = [];
    await this.lock.run(async () => {
      await this.assertLeaseHeld(); // revert is a write — fence it like commit()
      try {
        await this.git.raw(["revert", "--no-edit", opId]);
      } catch (e) {
        await this.git.raw(["revert", "--abort"]).catch(() => undefined);
        throw new Error(`revert of ${opId} conflicts with later history; aborted`);
      }
      id = (await this.git.revparse(["HEAD"])).trim();
      const names = (await this.git.raw(["show", "--name-only", "--pretty=format:", id])).trim();
      paths = names.split("\n").map((l) => l.trim()).filter(Boolean);
    });
    this.requestPush();
    return { id, paths };
  }

  // ── Single-writer lease (Slice 2c) ─────────────────────────────────────────
  // A shared-filesystem lease: correct where writers share the mounted checkout
  // (the real topology — one api owns the checkout; a second instance during a
  // migration shares the same volume). Cross-HOST enforcement (a lease over a
  // backend ref via push-CAS) is the portable follow-up; the interface is the
  // same, so only the storage swaps. TTL bounds a crashed holder; the monotonic
  // fencing `token` lets a superseded holder detect it has lost the lease. NB:
  // commit() is not yet gated on the lease — the api acquiring/renewing a lease
  // at startup and fencing writes on it is the integration step (cutover).

  private async resolveGitDir(): Promise<string> {
    let gitDir = (await this.git.raw(["rev-parse", "--git-dir"])).trim();
    if (!isAbsolute(gitDir)) gitDir = join(this.repoPath, gitDir);
    return gitDir;
  }

  private async leaseFile(): Promise<string> {
    return join(await this.resolveGitDir(), "braindance-lease.json");
  }

  private async readLease(path: string): Promise<Lease | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Lease;
    } catch {
      return null;
    }
  }

  private async writeLease(path: string, lease: Lease): Promise<void> {
    const tmp = `${path}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(lease), "utf8");
    await rename(tmp, path); // atomic replace on the same filesystem
  }

  /** Run `fn` under an exclusive on-disk meta-lock (O_EXCL create) so the
   *  read-modify-write of the lease file is atomic across processes sharing the
   *  filesystem. A crashed holder's lock is broken once it ages past STALE_MS
   *  (the critical section itself is sub-millisecond). */
  private async withMetaLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = (await this.leaseFile()) + ".lock";
    const STALE_MS = 10_000;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const fh = await open(lock, "wx"); // O_EXCL: only one creator wins
        await fh.close();
        try {
          return await fn();
        } finally {
          await unlink(lock).catch(() => undefined);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
        try {
          const st = await stat(lock);
          if (Date.now() - st.mtimeMs > STALE_MS) {
            await unlink(lock).catch(() => undefined); // break a stale lock
            continue;
          }
        } catch {
          continue; // lock vanished between checks — retry immediately
        }
        await sleep(20);
      }
    }
    throw new Error("could not acquire lease meta-lock");
  }

  async acquireLease(holder: string, ttlMs: number): Promise<Lease | null> {
    const path = await this.leaseFile();
    return this.withMetaLock(async () => {
      const cur = await this.readLease(path);
      const now = Date.now();
      if (cur && cur.expiresAt > now && cur.holder !== holder) return null; // held & valid
      const lease: Lease = { holder, token: (cur?.token ?? 0) + 1, expiresAt: now + ttlMs };
      await this.writeLease(path, lease);
      return lease;
    });
  }

  async renewLease(lease: Lease, ttlMs: number): Promise<Lease | null> {
    const path = await this.leaseFile();
    return this.withMetaLock(async () => {
      const cur = await this.readLease(path);
      if (!cur || cur.holder !== lease.holder || cur.token !== lease.token) return null; // fenced out
      const renewed: Lease = { ...cur, expiresAt: Date.now() + ttlMs };
      await this.writeLease(path, renewed);
      return renewed;
    });
  }

  async releaseLease(lease: Lease): Promise<void> {
    const path = await this.leaseFile();
    await this.withMetaLock(async () => {
      const cur = await this.readLease(path);
      // Keep the record (mark it expired) rather than deleting it, so the fencing
      // token counter stays monotonic across a release → re-acquire.
      if (cur && cur.holder === lease.holder && cur.token === lease.token) {
        await this.writeLease(path, { ...cur, expiresAt: 0 });
      }
    });
  }

  /** Acquire and hold the writer lease for this store (a no-op returning true
   *  when requireLease is off). Starts a renewal timer at half the TTL. Returns
   *  false if another live holder owns the lease — the caller should then refuse
   *  to write (serve read-only or exit). */
  async acquireWriterLease(): Promise<boolean> {
    if (!this.requireLease) return true;
    const lease = await this.acquireLease(this.leaseHolder, this.leaseTtlMs);
    if (!lease) return false;
    this.heldLease = lease;
    if (!this.leaseRenewTimer) {
      const every = Math.max(1000, Math.floor(this.leaseTtlMs / 2));
      this.leaseRenewTimer = setInterval(() => void this.renewWriterLease(), every);
      this.leaseRenewTimer.unref?.();
    }
    return true;
  }

  private async renewWriterLease(): Promise<void> {
    if (!this.heldLease) return;
    const renewed = await this.renewLease(this.heldLease, this.leaseTtlMs);
    if (!renewed) this.log("WRITER LEASE LOST — another instance took over; writes refused until reacquired.");
    this.heldLease = renewed; // null ⇒ fenced out
  }

  /** Throw if this store must hold the lease but doesn't (or was fenced out).
   *  Re-confirms ownership against the on-disk lease before every write. */
  private async assertLeaseHeld(): Promise<void> {
    if (!this.requireLease) return;
    if (!this.heldLease) throw new Error("writer lease not held");
    const cur = await this.readLease(await this.leaseFile());
    if (!cur || cur.holder !== this.heldLease.holder || cur.token !== this.heldLease.token || cur.expiresAt <= Date.now()) {
      this.heldLease = null;
      throw new Error("writer lease lost (fenced out)");
    }
  }

  /** Request an async reconcile+push. Single-flight and coalescing: a burst of
   *  captures collapses into one pull --rebase + push. No-op in local-only mode
   *  (no remote configured) — commits still land and are visible locally. */
  requestPush(): void {
    if (!this.remoteUrl) return;
    this.pushRequested = true;
    void this.drainPush();
  }

  /** Await the queue draining — for tests / graceful shutdown. */
  async flush(): Promise<void> {
    await this.drainPush();
    while (this.pushRunning) await sleep(10);
  }

  private async drainPush(): Promise<void> {
    if (this.pushRunning || !this.remoteUrl) return;
    this.pushRunning = true;
    try {
      while (this.pushRequested) {
        this.pushRequested = false;
        await this.attemptPush();
      }
    } finally {
      this.pushRunning = false;
    }
  }

  private async attemptPush(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.reconcileAndPush();
        return;
      } catch (e) {
        if (e instanceof ConflictError) {
          // Sync paused; keep local commits, do not spin. A later reconcile
          // (periodic timer or the next capture) re-attempts once cleared.
          return;
        }
        if (attempt < this.pushMaxRetries) {
          await sleep(this.pushRetryBaseMs * 2 ** attempt);
          continue;
        }
        // Transient failure persisted (offline?). Keep the commits queued and
        // re-arm a delayed retry — the queue drains when connectivity returns.
        this.log(`push failed after ${this.pushMaxRetries + 1} attempts; retrying in ${this.pushRetryDelayMs}ms`, e);
        const t = setTimeout(() => this.requestPush(), this.pushRetryDelayMs);
        t.unref?.();
        return;
      }
    }
  }

  /** The serialized reconcile: pull --rebase incoming history, then push. On a
   *  rebase conflict, abort + flag (never clobber). Runs under the one lock so
   *  it never races a concurrent commit. */
  private async reconcileAndPush(): Promise<void> {
    if (!this.remoteUrl) return;
    await this.lock.run(async () => {
      try {
        await this.git.pull(this.remoteUrl!, this.branch, ["--rebase"]);
      } catch (e) {
        if (await this.isRebaseInProgress()) {
          await this.git.rebase(["--abort"]).catch(() => undefined);
          this.conflicted = true;
          this.log("REBASE CONFLICT during reconcile — aborted, sync PAUSED. Resolve manually.", e);
          throw new ConflictError();
        }
        throw e; // network/other — bubble up to the retry loop
      }
      await this.git.push(this.remoteUrl!, `HEAD:${this.branch}`);
      this.conflicted = false;
    });
  }

  private async isRebaseInProgress(): Promise<boolean> {
    let gitDir: string;
    try {
      gitDir = (await this.git.raw(["rev-parse", "--git-dir"])).trim();
    } catch {
      return false;
    }
    if (!isAbsolute(gitDir)) gitDir = join(this.repoPath, gitDir);
    for (const d of ["rebase-merge", "rebase-apply"]) {
      try {
        await access(join(gitDir, d));
        return true;
      } catch {
        /* not present */
      }
    }
    return false;
  }
}

/** Build an authenticated HTTPS remote URL from the PAT + `owner/repo`, or null
 *  if either is unset (local-only mode). The token is used per-operation and
 *  never persisted to the shared `.git/config`. */
export function authRemoteUrl(token?: string, repo?: string): string | null {
  if (!token || !repo) return null;
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

let store: GitStore | null = null;

/** Process-wide singleton, configured from env. */
export function gitStore(): GitStore {
  if (store) return store;
  const repoPath = process.env.REPO_PATH ?? "/srv/braindance";
  store = new GitStore({
    repoPath,
    branch: process.env.GIT_BRANCH ?? "main",
    remoteUrl: authRemoteUrl(process.env.GITHUB_TOKEN, process.env.GITHUB_REPO),
    authorName: process.env.GIT_AUTHOR_NAME,
    authorEmail: process.env.GIT_AUTHOR_EMAIL,
    pullIntervalMs: Number(process.env.GIT_PULL_INTERVAL_MS ?? 5 * 60_000),
    // Single-writer lease: off by default (pre-cutover behaviour unchanged);
    // set REQUIRE_LEASE=1 at cutover so a stray second instance can't co-write.
    requireLease: /^(1|true|yes)$/i.test(process.env.REQUIRE_LEASE ?? ""),
    leaseHolder: process.env.LEASE_HOLDER,
    leaseTtlMs: process.env.LEASE_TTL_MS ? Number(process.env.LEASE_TTL_MS) : undefined,
  });
  return store;
}
