// Unit test for capture de-duplication. Run: `npm run test:dedup`.
import assert from "node:assert/strict";

process.env.DEDUP_TTL_MS = "40"; // short TTL so the expiry case is fast
const { seenRecently, contentHash } = await import("../src/dedup.js");

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("test: seenRecently windowing");
  check("first sight is not a duplicate", seenRecently("k1") === false);
  check("immediate repeat is a duplicate", seenRecently("k1") === true);
  check("a different key is not a duplicate", seenRecently("k2") === false);
  await sleep(70);
  check("after the TTL, the key is fresh again", seenRecently("k1") === false);

  console.log("test: contentHash");
  check("deterministic for identical content", contentHash("hello\nworld") === contentHash("hello\nworld"));
  check("differs for different content", contentHash("a") !== contentHash("b"));

  console.log(`\nAll ${passed} checks passed.`);
}

main().catch((e) => {
  console.error("\nTEST FAILED:", e);
  process.exit(1);
});
