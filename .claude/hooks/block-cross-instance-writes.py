#!/usr/bin/env python3
"""PreToolUse guard: block writes into ANOTHER braindance instance's vault/repos.

Multi-instance model (docs/instances.md, rule C2): each instance owns a vault +
repos scope; work in instance Y must never mutate instance X's vault/repos. This
guard blocks a mutation whose target lands in some registered instance X's vault
or repos while the tool's active context is a DIFFERENT instance Y (Y != X).

Contract (deliberately narrow — a guardrail that misfires is worse than the bug):
  active = the instance whose territory contains the tool's cwd (for Bash, the
           effective cwd after a leading `cd`), incl. a worktree's main checkout.
           If that is NO instance, we can't establish an active context -> ALLOW.
  BLOCK  a mutation to path P iff P is under some instance X's vault|repos and
           X != active.
  ALLOW  reads; writes within the active instance; writes outside every
           registered vault/repos; and EVERYTHING when no instance is registered
           (the bare template / pre-configure) or the active context is neutral.

Tools: Write/Edit/MultiEdit/NotebookEdit (by file path), Bash (by the set of
paths a mutating command would write). Reads are never blocked. Writing into
another instance's *core* checkout is out of scope here (C2 covers vault/repos).

Exit: 0 allow (silent). 2 block (stderr shown to the model). Any unexpected
error -> 0 (fail-open) so a hook bug can never wedge a session.

The Bash mutation-target parsing mirrors the primitives in
block-loon-main-writes.py but is self-contained and uses uniform semantics
(collect every plausible write target; the caller's predicate decides).
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _bd_registry import (  # noqa: E402
    load_instances, active_instance, owner,
)

GENERIC_MUTATE = re.compile(r"""(?xi)
    (^|[\s;&|(])(rm|rmdir|mv|cp|install|touch|mkdir|ln|tee|dd|truncate|
                 sed\s+-i|perl\s+-i)($|[\s;&|)])""")
CARGO_CWD = re.compile(r"""(?xi)
    (^|[\s;&|(])(cargo\s+(build|test|run|fmt|clippy|bench|add|remove|update|
                 clean|generate-lockfile|vendor)|rustfmt)($|[\s;&|)])""")
GIT_MUTATE = re.compile(r"""(?xi)
    (^|[\s;&|(])git
    ((?:\s+(?:-C\s+\S+|-c\s+\S+|--exec-path=\S+|--git-dir=\S+|--work-tree=\S+|--\S+))*)
    \s+(?:add|commit|rm|mv|apply|am|checkout|switch|restore|reset|
        rebase|merge|cherry-pick|revert|stash|clean)(?=$|[\s;&|)])""")
CARGO_MANIFEST = re.compile(r"""(?xi)
    cargo\s+(?:build|test|run|fmt|clippy|bench|add|remove|update|clean|
             generate-lockfile|vendor)\b
    [^;&|]*?--manifest-path[=\s]+(\S+)""")
REDIRECT = re.compile(r"(?<![0-9&=<>-])>>?\s*(?!=)(?!/dev/null)([^\s&|;'\"<>]+)")
LEADING_CD = re.compile(r"^\s*cd\s+(?:-[PL]\s+)*([^\s;&|<>]+)")


def canon(path, cwd):
    if not path:
        return ""
    if not os.path.isabs(path):
        path = os.path.join(cwd or os.getcwd(), path)
    return os.path.realpath(os.path.normpath(path))


def effective_cwd(command, cwd):
    m = LEADING_CD.match(command or "")
    return canon(m.group(1).strip("'\""), cwd) if m else canon(".", cwd)


def bash_write_targets(command, cwd):
    """Canonical paths a Bash command would MUTATE (best-effort, uniform)."""
    targets = set()
    if not command:
        return targets
    eff = effective_cwd(command, cwd)
    if GIT_MUTATE.search(command) or CARGO_MANIFEST.search(command) \
       or CARGO_CWD.search(command):
        targets.add(eff)                        # git/cargo act on the effective cwd
    if GENERIC_MUTATE.search(command):          # rm/cp/mv/touch/... operands
        for seg in re.split(r"[;&|]+", command):
            toks = re.findall(r"[^\s;&|()<>]+", seg)
            for tok in toks[1:]:                # skip the command word
                if tok.startswith("-"):
                    continue
                targets.add(canon(tok.strip("'\""), eff))
    for m in REDIRECT.finditer(command):        # > file, >> file
        targets.add(canon(m.group(1).strip("'\""), eff))
    for m in GIT_MUTATE.finditer(command):      # git -C <path> <mutating verb>
        for cm in re.finditer(r"-C\s+(\S+)", m.group(2) or ""):
            targets.add(canon(cm.group(1).strip("'\""), cwd))
    for m in CARGO_MANIFEST.finditer(command):  # cargo --manifest-path <path>
        targets.add(canon(m.group(1).strip("'\""), cwd))
    return targets


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    try:
        instances = load_instances()
        if not instances:
            return 0                            # no model in use -> allow

        tool = data.get("tool_name", "")
        ti = data.get("tool_input", {}) or {}
        cwd = data.get("cwd", "") or os.getcwd()

        if tool == "Bash":
            cmd = ti.get("command", "")
            base = effective_cwd(cmd, cwd)      # active context = where it cd's to
            targets = bash_write_targets(cmd, cwd)
        elif tool in ("Write", "Edit", "MultiEdit"):
            base = cwd
            p = ti.get("file_path", "")
            targets = {canon(p, cwd)} if p else set()
        elif tool == "NotebookEdit":
            base = cwd
            p = ti.get("notebook_path", "") or ti.get("file_path", "")
            targets = {canon(p, cwd)} if p else set()
        else:
            return 0                            # not a mutating tool -> allow

        active = active_instance(base, instances)
        if active is None:
            return 0                            # neutral context -> allow

        for p in targets:
            x = owner(p, instances, keys=("vault", "repos"))
            if x is not None and x != active:
                sys.stderr.write(
                    "BLOCKED (C2 cross-instance guard): this write targets the "
                    f"'{x}' instance's vault/repos, but the active instance here "
                    f"is '{active}'.\n"
                    f"  path: {p}\n"
                    "Work only within the active instance's territory. To act on "
                    f"'{x}', switch to it (cd into its tree, or `bd use {x}`).\n"
                )
                return 2
        return 0
    except Exception:
        return 0                                # fail-open


if __name__ == "__main__":
    sys.exit(main())
