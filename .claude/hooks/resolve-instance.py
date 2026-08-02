#!/usr/bin/env python3
"""SessionStart hook: tell the agent which braindance instance is active.

Resolves the active instance for the session's cwd (by territory, incl. a
worktree's main checkout) and injects a short additionalContext line so the
agent knows its scope up front (rule C1). Purely informational — a SessionStart
hook cannot block. No registry, or a neutral cwd, -> no context is added, so this
is a silent no-op on the bare template / pre-configure. See docs/instances.md.

Output (exit 0): the documented SessionStart JSON —
  {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ...}}
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bd_registry import load_instances, active_instance  # noqa: E402


def context():
    instances = load_instances()
    if not instances:
        return None
    try:
        data = json.load(sys.stdin)
    except Exception:
        return None
    cwd = data.get("cwd") or os.getcwd()
    active = active_instance(cwd, instances)
    if active:
        terr = dict(instances).get(active, {})
        return (
            f"Active braindance instance: **{active}**\n"
            f"  vault: {terr.get('vault', '')}\n"
            f"  repos: {terr.get('repos', '')}\n"
            "Per the active-instance discipline (C2), keep reads and writes within "
            "this instance's vault/repos — a PreToolUse guard blocks writes into "
            "another instance's territory."
        )
    names = ", ".join(n for n, _ in instances)
    return (
        "No braindance instance is active for this directory (it is outside every "
        f"registered instance's territory). Registered: {names}. cd into one, or "
        "run `bd use <name>`, before doing instance-scoped work."
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
