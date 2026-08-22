#!/usr/bin/env python3
"""SessionStart hook: tell the agent which braindance instance is active.

Delegates to the canonical resolver (`ctx/tools/sys/resolve.sh`) so the context
injected here follows the SAME ladder the shell, `bd`, and the docs describe —
BD_USE pin (1), location/territory (2), registry `default` (3) — rather than
reimplementing one rung of it. Purely informational: a SessionStart hook cannot
block. No resolution -> no context, so this stays a silent no-op on the bare
template / pre-configure. See docs/instances.md.

Do NOT resolve through `_bd_registry` here. That helper is territory-only ON
PURPOSE, so the PreToolUse write guards enforce by physical location and cannot
be disarmed by a pin or a default. Borrowing it for session context was the bug
this file used to have: every neutral directory — `$BD_ROOT` itself, `tools/`,
`web/`, `worktrees/` — was reported as "no instance active" even when the
registry `default` pointer resolved it (ladder step 3). It is still imported
below, but only to LIST registered names in the unresolved message.

The resolver ships beside `wt.sh` in THIS checkout, so locate it from __file__ —
never from $BD_CORE, which may be inherited from a pre-move shell and aim at a
resolver that no longer exists (the same trap wt.sh documents for BD_RESOLVE).

Output (exit 0): the documented SessionStart JSON —
  {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ...}}
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bd_registry import load_instances  # noqa: E402  (listing only — not resolution)

# <core>/.claude/hooks/this-file -> <core>
CORE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RESOLVER = os.path.join(CORE, "ctx", "tools", "sys", "resolve.sh")


def resolve(cwd):
    """Run the canonical resolver for `cwd`.

    Returns (rc, {KEY: value}) parsed from its env-contract stdout. Per
    docs/instances.md: rc 0 = resolved / honored / legacy, 3 = UNRESOLVED,
    4 = pin or default names an unregistered instance.
    """
    p = subprocess.run(
        ["bash", RESOLVER, cwd], capture_output=True, text=True, timeout=5,
    )
    env = {}
    for line in p.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return p.returncode, env


def context():
    if not os.path.isfile(RESOLVER):
        return None
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    cwd = data.get("cwd") or os.getcwd()

    rc, env = resolve(cwd)
    name = env.get("BD_ACTIVE_INSTANCE")

    if rc == 0 and name:
        return (
            f"Active braindance instance: **{name}**\n"
            f"  vault: {env.get('VAULT_PATH', '')}\n"
            f"  repos: {env.get('REPOS_PATH', '')}\n"
            "Per the active-instance discipline (C2), keep reads and writes within "
            "this instance's vault/repos — a PreToolUse guard blocks writes into "
            "another instance's territory."
        )

    if rc == 0:
        # Step 0 (preset env — the escape hatch) or step 4 (no instances
        # registered). Both mean "resolution is dormant"; say nothing.
        return None

    if rc == 4:
        return (
            "braindance: the `bd use` pin or the registry `default` names an "
            "instance that is not registered. Run `bd ls-instances` to see the "
            "registry before doing instance-scoped work."
        )

    # rc 3 — genuinely unresolved: no pin, no territory match, no default.
    names = ", ".join(n for n, _ in load_instances()) or "(none)"
    return (
        "No braindance instance is active for this directory (no `bd use` pin, no "
        "registered instance's territory contains it, and the registry has no "
        f"`default`). Registered: {names}. cd into one, run `bd use <name>`, or "
        "set a default with `./configure --default`, before doing instance-scoped work."
    )


def main():
    try:
        ctx = context()
    except Exception:
        ctx = None
    if ctx:
        json.dump(
            {"hookSpecificOutput": {"hookEventName": "SessionStart",
                                    "additionalContext": ctx}},
            sys.stdout,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
