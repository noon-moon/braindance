// ObjectStore — the minimal object-storage contract the object-backed vault
// adapter (objectadapter.ts) is built on. S3 and an in-memory map are two
// implementations; the adapter is store-agnostic, which is what makes the vault
// portable across a git repo (git.ts) and an object store alike.
//
// The only non-trivial requirement is a compare-and-swap (CAS) primitive, used
// for the HEAD pointer and the lease. Real S3 provides it via conditional
// writes (If-None-Match / If-Match ETag); the memory store below does it exactly.

export interface ObjectStore {
  get(key: string): Promise<string | null>;
  put(key: string, body: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix` (exact-prefix match). */
  list(prefix: string): Promise<string[]>;
  /** Set `key` to `next` only if its current value equals `expected`
   *  (`expected === null` means "expected absent"). Returns whether it swapped. */
  compareAndSwap(key: string, expected: string | null, next: string): Promise<boolean>;
}

/** In-memory ObjectStore — the reference implementation and test double. */
export class MemoryObjectStore implements ObjectStore {
  private readonly m = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.m.has(key) ? (this.m.get(key) as string) : null;
  }
  async put(key: string, body: string): Promise<void> {
    this.m.set(key, body);
  }
  async delete(key: string): Promise<void> {
    this.m.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix));
  }
  async compareAndSwap(key: string, expected: string | null, next: string): Promise<boolean> {
    const cur = this.m.has(key) ? (this.m.get(key) as string) : null;
    if (cur !== expected) return false;
    this.m.set(key, next);
    return true;
  }
}
