// VaultAdapter — the backend-agnostic persistence interface (v2 Slice 2).
//
// The vault lives in a pluggable backend (git repo | S3); this interface is the
// contract every backend implements, so the app is decoupled from the concrete
// store. GitStore (git.ts) is the first (git) implementation.
//
// This increment (Slice 2a) introduces the interface plus the atomic CHANGESET
// commit — the primitive every higher layer builds on: one reviewed operation =
// one changeset = one atomic version. Later increments extend the contract:
//   - history() / revert()          → operation log + undo        (Slice 3)
//   - acquireLease/renew/release    → single-writer invariant     (Slice 2c)
//   - materialize()                 → read-cache for ext. agents  (Slice 4)
// The interface deliberately leaks no git specifics, so an S3 adapter (Slice 7)
// can satisfy it with a manifest-per-operation rendering of the same log.

/** One file-level change within an operation. `put` creates-or-overwrites with
 *  the full new body; `delete` removes the path. */
export type ChangeOp =
  | { op: "put"; path: string; content: string }
  | { op: "delete"; path: string };

/** A set of file changes applied as ONE atomic operation (one version). */
export interface Changeset {
  ops: ChangeOp[];
}

export interface OpMeta {
  /** Operation (commit) message. */
  message: string;
}

export interface CommitResult {
  /** The operation id (git: the commit SHA). */
  id: string;
  /** Repo-relative paths touched by the operation. */
  paths: string[];
}

/** A held single-writer lease. `token` is a monotonic fencing token that bumps
 *  on every acquire/takeover — a holder whose token no longer matches has been
 *  fenced out and must stop writing. */
export interface Lease {
  holder: string;
  token: number;
  /** Epoch-ms expiry. */
  expiresAt: number;
}

/** One entry in the operation log. */
export interface Op {
  /** The operation id (git: the commit SHA). */
  id: string;
  /** Operation message. */
  message: string;
  /** ISO-8601 timestamp of the operation. */
  date: string;
  /** Repo-relative paths the operation touched (best-effort). */
  paths: string[];
}

export interface AdapterStatus {
  /** true once a reconcile conflict paused sync; cleared by a clean reconcile. */
  conflicted: boolean;
  /** an async push is queued or in flight (local ops not yet on the remote). */
  pending: boolean;
}

/** The backend-agnostic vault persistence contract. GitStore is the git impl. */
export interface VaultAdapter {
  init(): Promise<void>;
  start(): void;
  stop(): void;
  /** Apply a changeset as one atomic operation; resolves once the local
   *  operation lands (the network sync happens asynchronously). */
  commit(changeset: Changeset, meta: OpMeta): Promise<CommitResult>;
  /** The operation log, newest-first. Optionally filtered to ops touching
   *  `path`, and capped at `limit` entries. */
  history(opts?: { path?: string; limit?: number }): Promise<Op[]>;
  /** Undo an operation by applying its inverse as a NEW operation. Throws if
   *  the inverse conflicts with later history (never leaves a partial state). */
  revert(opId: string): Promise<CommitResult>;
  /** Acquire the single-writer lease for `holder`, valid for `ttlMs`. Returns
   *  the lease, or null if another holder's lease is still valid. */
  acquireLease(holder: string, ttlMs: number): Promise<Lease | null>;
  /** Extend a held lease (must still be the holder + token). Returns the renewed
   *  lease, or null if the lease was lost/taken (fenced out). */
  renewLease(lease: Lease, ttlMs: number): Promise<Lease | null>;
  /** Release a held lease (best-effort; only if still the holder + token). */
  releaseLease(lease: Lease): Promise<void>;
  status(): AdapterStatus;
  /** Await the async push queue draining (tests / graceful shutdown). */
  flush(): Promise<void>;
  /** The whole current vault as a path→content map — the portable snapshot used
   *  to migrate between backends. */
  snapshot(): Promise<Record<string, string>>;
}
