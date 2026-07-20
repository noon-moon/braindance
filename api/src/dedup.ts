// In-process capture de-duplication — closes the double-submit bug.
//
// A short-TTL memory of recent capture keys so a double-tap / retry doesn't
// produce a second byte-identical note (e.g. the leg-relaxation pair captured
// 264 ms apart). Two keys guard the flow: a content hash of the composed note
// (catches identical content from any source) and an idempotency token minted
// per funnel-form render (catches a re-POST of the same rendered form).
//
// In-process is sufficient: double-submits hit the same api process within
// seconds. This is NOT a cross-instance / cross-restart guarantee.
import { createHash } from "node:crypto";

const TTL_MS = Number(process.env.DEDUP_TTL_MS ?? 120_000);
const seen = new Map<string, number>(); // key → expiry epoch ms

/** Record `key`; return true if it was already seen within the TTL window. */
export function seenRecently(key: string): boolean {
  const now = Date.now();
  for (const [k, exp] of seen) if (exp <= now) seen.delete(k); // prune expired
  if (seen.has(key)) return true;
  seen.set(key, now + TTL_MS);
  return false;
}

export function contentHash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
