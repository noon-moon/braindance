#!/usr/bin/env python3
"""Regression self-test for the R1 write-guard hook (block-loon-main-writes.py).

Feeds each case to the hook as PreToolUse JSON on stdin and asserts the exit code
(0 = allow, 2 = block). Guards against the three false-positive classes fixed in
the "R1 write-guard false-positives" change:

  A  arrow/comparison operators (`->`, `=>`, `>=`) misparsed as file redirects
  B  a relative redirect target after `cd <worktree>` resolving against the
     pinned (main) cwd instead of the effective (worktree) cwd
  C  a mutating command run from the main cwd blocked even when its only targets
     are absolute paths outside the guarded tree (e.g. `rm -f /tmp/x`)

Run:  python3 test_block_loon_main_writes.py            # tests the sibling hook
      python3 test_block_loon_main_writes.py /path/hook # tests an explicit hook
Exit 0 = all pass, 1 = one or more failures.

Paths below are built from the hook's own hardcoded guarded root, so the test is
self-consistent regardless of where the repo is cloned.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "block-loon-main-writes.py")


def _guarded_root():
    """Read LOON_MAIN out of the hook so cases target its actual guarded root."""
    ns = {}
    with open(HOOK) as f:
        for line in f:
            if line.startswith("LOON_MAIN"):
                exec(line, ns)  # noqa: S102 - trusted sibling source
                return ns["LOON_MAIN"]
    raise SystemExit("could not find LOON_MAIN in hook")


MAIN = _guarded_root()
WT = os.path.join(MAIN, ".claude", "worktrees", "sim-human")

# (label, command, cwd, expected_exit)
CASES = [
    # --- must NOT block (exit 0) ---
    ("A: arrow in gh title",
     'gh pr create --title "garden: stream cache -> evict on exit"', MAIN, 0),
    ("A: arrow in awk",
     "awk '{print $1 -> $2}'", MAIN, 0),
    ("A: >= comparison",
     '[ "$x" -ge 5 ] && [ "$y" >= 3 ]', MAIN, 0),
    ("B: cd wt && cat > relative target",
     f"cd {WT} && cat > crates/garden-game/examples/traj.rs", WT, 0),
    ("A/B: cd wt && git commit -F - with arrow in body",
     f"cd {WT} && git commit -F - <<'EOF'\nfix: stream cache -> evict on exit\nEOF", WT, 0),
    ("C: rm -f /tmp target, cwd=main",
     "rm -f /tmp/scratch.py", MAIN, 0),
    ("C: mkdir out-of-tree scratch, cwd=main",
     "mkdir -p /tmp/ephemeral-scratch/foo", MAIN, 0),
    # --- must STILL block (exit 2): regression guard against over-narrowing ---
    ("still-block: cat > main src, cwd=main, no cd",
     "cat > crates/loon-sim/src/x.rs", MAIN, 2),
    ("still-block: echo x > $MAIN/foo absolute",
     f"echo x > {MAIN}/foo", MAIN, 2),
    ("still-block: cd $MAIN && cargo build",
     f"cd {MAIN} && cargo build", MAIN, 2),
]


def run(cmd, cwd):
    payload = json.dumps(
        {"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd}
    )
    p = subprocess.run(
        [sys.executable, HOOK], input=payload, capture_output=True, text=True
    )
    return p.returncode


def main():
    print(f"hook: {HOOK}")
    print(f"guarded root: {MAIN}\n")
    failures = 0
    for label, cmd, cwd, expected in CASES:
        got = run(cmd, cwd)
        ok = got == expected
        failures += not ok
        verb = "block" if expected == 2 else "allow"
        print(f"[{'PASS' if ok else 'FAIL'}] expect {verb}(exit {expected}) "
              f"got exit {got}  :: {label}")
    print()
    if failures:
        print(f"{failures} FAILURE(S)")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
