// ObjectVaultAdapter — the VaultAdapter (adapter.ts) implemented over an
// ObjectStore (objectstore.ts), proving the vault is portable beyond git.
//
// Storage model (a small content-addressed store — git's shape, flattened):
//   blobs/<sha256(content)>  immutable file contents
//   manifests/<opId>         one per operation: { parent, message, date,
//                            tree: {path→sha}, changed: [paths] }
//   HEAD                     → the latest opId (advanced by compare-and-swap)
//   lease                    → the single-writer lease JSON
//
// Every commit writes new blobs + a manifest, then CAS-advances HEAD — one
// operation = one manifest = one atomic version, the same op-log the git adapter
// renders as commits (design's "manifest-per-operation" S3 rendering). Reverting
// an op restores its changed paths to their pre-op state, and refuses if a later
// op has since touched them (honouring the VaultAdapter revert contract).
//
// Simplification: each manifest carries the FULL flat tree (fine for hundreds of
// files; a nested/shared-tree encoding would scale further).
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { VaultAdapter, Changeset, OpMeta, CommitResult, Op, Lease, AdapterStatus } from "./adapter.js";
import type { ObjectStore } from "./objectstore.js";

interface Manifest {
  id: string;
  parent: string | null;
  message: string;
  date: string;
  tree: Record<string, string>;
  changed: string[];
}

export interface ObjectAdapterOptions {
  store: ObjectStore;
  /** Dir that materialize() projects the vault tree into (for file-native reads). */
  localDir?: string;
  logger?: (msg: string, err?: unknown) => void;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export class ObjectVaultAdapter implements VaultAdapter {
  private readonly store: ObjectStore;
  private readonly localDir: string | null;
  private readonly log: (msg: string, err?: unknown) => void;
  private conflicted = false;

  constructor(opts: ObjectAdapterOptions) {
    this.store = opts.store;
    this.localDir = opts.localDir ?? null;
    this.log = opts.logger ?? ((m, e) => (e ? console.error(m, e) : console.log(m)));
  }

  async init(): Promise<void> {}
  start(): void {}
  stop(): void {}
  status(): AdapterStatus {
    return { conflicted: this.conflicted, pending: false }; // writes are synchronous to the store
  }
  async flush(): Promise<void> {}

  private async head(): Promise<string | null> {
    return this.store.get("HEAD");
  }
  private async readManifest(id: string): Promise<Manifest> {
    const raw = await this.store.get(`manifests/${id}`);
    if (!raw) throw new Error(`manifest not found: ${id}`);
    return JSON.parse(raw) as Manifest;
  }
  private async treeOf(opId: string | null): Promise<Record<string, string>> {
    return opId ? (await this.readManifest(opId)).tree : {};
  }

  async commit(changeset: Changeset, meta: OpMeta): Promise<CommitResult> {
    const { ops } = changeset;
    if (ops.length === 0) throw new Error("empty changeset");
    const parent = await this.head();
    const tree = { ...(await this.treeOf(parent)) };
    const changed: string[] = [];
    for (const op of ops) {
      if (op.op === "put") {
        const sha = sha256(op.content);
        await this.store.put(`blobs/${sha}`, op.content);
        tree[op.path] = sha;
      } else {
        delete tree[op.path];
      }
      changed.push(op.path);
    }
    const id = `op_${randomUUID()}`;
    const manifest: Manifest = { id, parent, message: meta.message, date: new Date().toISOString(), tree, changed };
    await this.store.put(`manifests/${id}`, JSON.stringify(manifest));
    // Advance HEAD atomically. A CAS failure = a concurrent writer moved HEAD
    // (shouldn't happen under the single-writer lease) — surface, never clobber.
    if (!(await this.store.compareAndSwap("HEAD", parent, id))) {
      this.conflicted = true;
      throw new Error("HEAD moved during commit (concurrent writer) — aborted");
    }
    this.conflicted = false;
    return { id, paths: changed };
  }

  async history(opts: { path?: string; limit?: number } = {}): Promise<Op[]> {
    const limit = opts.limit ?? 50;
    const out: Op[] = [];
    let cur = await this.head();
    while (cur && out.length < limit) {
      const m = await this.readManifest(cur);
      if (!opts.path || m.changed.includes(opts.path)) {
        out.push({ id: m.id, message: m.message, date: m.date, paths: m.changed });
      }
      cur = m.parent;
    }
    return out;
  }

  async revert(opId: string): Promise<CommitResult> {
    const m = await this.readManifest(opId);
    const parentTree = await this.treeOf(m.parent);
    const headTree = await this.treeOf(await this.head());
    // Conflict check: refuse if any path this op touched has since changed.
    for (const path of m.changed) {
      if (m.tree[path] !== headTree[path]) {
        throw new Error(`revert of ${opId} conflicts: ${path} changed since; aborted`);
      }
    }
    const ops: Changeset["ops"] = [];
    for (const path of m.changed) {
      const prevSha = parentTree[path];
      if (prevSha === undefined) {
        ops.push({ op: "delete", path });
      } else {
        const content = await this.store.get(`blobs/${prevSha}`);
        if (content === null) throw new Error(`missing blob ${prevSha} reverting ${path}`);
        ops.push({ op: "put", path, content });
      }
    }
    return this.commit({ ops }, { message: `Revert: ${m.message}` });
  }

  // ── Single-writer lease (CAS over the store; TTL + monotonic fencing) ──────
  private async readLease(): Promise<{ raw: string | null; lease: Lease | null }> {
    const raw = await this.store.get("lease");
    return { raw, lease: raw ? (JSON.parse(raw) as Lease) : null };
  }

  async acquireLease(holder: string, ttlMs: number): Promise<Lease | null> {
    const { raw, lease: cur } = await this.readLease();
    const now = Date.now();
    if (cur && cur.expiresAt > now && cur.holder !== holder) return null;
    const lease: Lease = { holder, token: (cur?.token ?? 0) + 1, expiresAt: now + ttlMs };
    return (await this.store.compareAndSwap("lease", raw, JSON.stringify(lease))) ? lease : null;
  }

  async renewLease(lease: Lease, ttlMs: number): Promise<Lease | null> {
    const { raw, lease: cur } = await this.readLease();
    if (!cur || cur.holder !== lease.holder || cur.token !== lease.token) return null;
    const renewed: Lease = { ...cur, expiresAt: Date.now() + ttlMs };
    return (await this.store.compareAndSwap("lease", raw, JSON.stringify(renewed))) ? renewed : null;
  }

  async releaseLease(lease: Lease): Promise<void> {
    const { raw, lease: cur } = await this.readLease();
    if (cur && cur.holder === lease.holder && cur.token === lease.token) {
      await this.store.compareAndSwap("lease", raw, JSON.stringify({ ...cur, expiresAt: 0 }));
    }
  }

  /** The whole current vault tree as path→content — the portable snapshot for
   *  migrating this vault to another backend. */
  async snapshot(): Promise<Record<string, string>> {
    const head = await this.head();
    if (!head) return {};
    const out: Record<string, string> = {};
    for (const [path, sha] of Object.entries((await this.readManifest(head)).tree)) {
      const content = await this.store.get(`blobs/${sha}`);
      if (content !== null) out[path] = content;
    }
    return out;
  }

  /** Project the current vault tree into localDir (the object-store analogue of
   *  a git checkout — file-native reads for agents). */
  async materialize(): Promise<void> {
    if (!this.localDir) throw new Error("no localDir configured for materialize()");
    const head = await this.head();
    if (!head) return;
    for (const [path, sha] of Object.entries((await this.readManifest(head)).tree)) {
      const content = await this.store.get(`blobs/${sha}`);
      if (content === null) continue;
      const abs = join(this.localDir, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
  }
}
