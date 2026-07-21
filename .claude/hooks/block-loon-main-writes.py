#!/usr/bin/env python3
"""PreToolUse guard: block writes to the Loon MAIN integration checkout.

Retro item R1 (see ctx/ephemeral/loon-multiagent-retro.md). Incident B: agents
edited the shared `repo/loon` checkout by mistake — three times — because they
launched with cwd=repo/loon and forgot to `cd` into their worktree (or used a
repo-relative path). This hook makes the main checkout physically unwritable to
Claude tools while LEAVING WORKTREE WRITES ALONE.

Contract (deliberately narrow — a guardrail that misfires is worse than the bug):
  BLOCK a tool call only when it would MUTATE a path that is
      under  <repos>/loon        (the resolved guarded checkout; see below)
      but NOT under <repos>/loon/.claude/worktrees/   (agents live here)
  ALLOW everything else: worktree writes, reads, MCP tools, and every path
      outside the Loon main checkout (the braindance repo, bd-wt/, /tmp, ...).

Path resolution (single-root model — see CLAUDE.md `$BD_ROOT`): the guarded
`<repos>` dir is REPOS_PATH, else BD_ROOT (the single external root holding the
core + vault + repos as siblings), else the nested default <core>/repo. With all
three unset it resolves to the historical nested location, so the guard behaves
identically whether the repos live inside the checkout or external under BD_ROOT.
BD_CORE overrides the checkout location the nested default hangs off; the guarded
project name is `loon` by default, overridable via BD_GUARD_PROJECT.

Tools covered: Write, Edit, MultiEdit, NotebookEdit (by resolved file path), and
Bash (only when a mutating command targets a guarded path, or is run FROM the
guarded checkout root). Reads are never blocked.

Exit codes: 0 = allow (silent). 2 = block (stderr shown to the model).
Any unexpected error exits 0 (fail-open) so a hook bug can never wedge a session.
"""
import json
import os
import re
import sys

# Resolve the guarded checkout from the single-root model, defaulting to the
# historical nested layout so behavior is unchanged when nothing is set.
#   repos dir  = REPOS_PATH | BD_ROOT | <core>/repo
#   <core>     = BD_CORE | legacy default checkout
#   guarded    = <repos dir>/<project>   (project = BD_GUARD_PROJECT | "loon")
BD_CORE = os.path.expanduser(
    os.environ.get("BD_CORE") or "/Users/tiernan/dev/braindance-usr"
)
REPOS_DIR = os.path.expanduser(
    os.environ.get("REPOS_PATH")
    or os.environ.get("BD_ROOT")
    or os.path.join(BD_CORE, "repo")
)
PROJECT = os.environ.get("BD_GUARD_PROJECT", "loon")
LOON_MAIN = os.path.join(REPOS_DIR, PROJECT)
LOON_WORKTREES = os.path.join(LOON_MAIN, ".claude", "worktrees")


def canon(path: str, cwd: str) -> str:
    """Absolute, normalized path (relative paths resolve against the tool's cwd)."""
    if not path:
        return ""
    if not os.path.isabs(path):
        path = os.path.join(cwd or os.getcwd(), path)
    # realpath resolves any existing symlinked prefix; normpath handles `..`.
    return os.path.realpath(os.path.normpath(path))


def under(path: str, root: str) -> bool:
    if not path:
        return False
    root = os.path.realpath(root)
    return path == root or path.startswith(root + os.sep)


def is_guarded(path: str) -> bool:
    """True iff path is inside the Loon main checkout but not inside a worktree."""
    return under(path, LOON_MAIN) and not under(path, LOON_WORKTREES)


# Generic file mutators (non-git, non-cargo) that write to the filesystem. Kept
# specific so read-only commands (cat, ls, grep, head, ...) are never flagged.
# These only touch the guarded tree if one of their OPERANDS resolves into it,
# so branch (a) checks their targets rather than blocking purely on cwd (Bug C:
# `rm -f /tmp/x` with cwd pinned to main must NOT block).
GENERIC_MUTATE = re.compile(
    r"""(?xi)
    (^|[\s;&|(])(
        rm|rmdir|mv|cp|install|touch|mkdir|ln|
        tee|dd|truncate|
        sed\s+-i|perl\s+-i
    )($|[\s;&|)])
    """
)
# cargo/rustfmt build-family invocations. Unlike generic mutators these act on
# the cwd (writing target/, Cargo.lock, reformatting in place), so if cwd is the
# guarded checkout they mutate it regardless of operands.
CARGO_CWD = re.compile(
    r"""(?xi)
    (^|[\s;&|(])(
        cargo\s+(build|test|run|fmt|clippy|bench|add|remove|update|clean|generate-lockfile|vendor)|
        rustfmt
    )($|[\s;&|)])
    """
)
# git subcommands that mutate the working tree / index / history — the ops an
# agent must never run against the main checkout. Allows intervening global
# options (`-C <path>`, `-c k=v`, `--no-pager`, ...) between `git` and the verb.
# Deliberately EXCLUDES fetch/branch/tag/worktree/pull/push: those are ref/sync
# ops the orchestrator legitimately runs on main (fetch-on-launch, ff-pull,
# `git worktree add`), and they don't rewrite the main checkout's source.
# The verb must be a whole token: the `(?=$|[\s;&|)])` lookahead stops `merge`
# from matching the READ-ONLY `merge-base`, `commit` from `commit-tree`, etc.
# group(2) captures the global options, so we can find a `-C <path>` target.
GIT_MUTATE = re.compile(
    r"""(?xi)
    (^|[\s;&|(])git
    ((?:\s+(?:-C\s+\S+|-c\s+\S+|--exec-path=\S+|--git-dir=\S+|--work-tree=\S+|--\S+))*)
    \s+(?:add|commit|rm|mv|apply|am|checkout|switch|restore|reset|
        rebase|merge|cherry-pick|revert|stash|clean)(?=$|[\s;&|)])
    """
)
# cargo build-family invocation with an explicit --manifest-path <target>.
CARGO_MANIFEST = re.compile(
    r"""(?xi)
    cargo\s+(?:build|test|run|fmt|clippy|bench|add|remove|update|clean|
             generate-lockfile|vendor)\b
    [^;&|]*?--manifest-path[=\s]+(\S+)
    """
)
# Output redirection to a file (`> f`, `>> f`), excluding fd redirects like 2>&1
# and the /dev/null sink. The lookbehind also excludes - = < > so ->, =>, >>, <>
# aren't parsed as operators; (?!=) rejects the >= comparison; target strips
# surrounding quotes.
REDIRECT = re.compile(r"(?<![0-9&=<>-])>>?\s*(?!=)(?!/dev/null)([^\s&|;'\"<>]+)")

# A leading `cd <dir>` (the standard "enter my worktree first" pattern) changes the
# effective directory the rest of the command runs in. The Bash tool's cwd is often
# pinned to the loon MAIN checkout, so without honoring this, a `cd <worktree> &&
# cargo build` (or `&& git commit/rebase`) would false-positive as a main mutation —
# which wedged both the orchestrator's rebases and agents' in-worktree builds.
LEADING_CD = re.compile(r"^\s*cd\s+(?:-[PL]\s+)*([^\s;&|<>]+)")


def effective_cwd(command: str, cwd: str) -> str:
    m = LEADING_CD.match(command or "")
    if m:
        return canon(m.group(1).strip("'\""), cwd)
    return canon(".", cwd)


def _generic_targets_guarded(command: str, eff: str) -> bool:
    """True iff a generic file-mutator OPERAND resolves into the guarded tree.

    Splits the command into pipeline/list segments and skips each segment's first
    bareword — that is the program name (rm/mkdir/cd/...), never a write target.
    Without this skip a relative program name (`rm`) resolves against a guarded
    `eff` (=> MAIN/rm) and falsely counts as in-tree, which would re-block the
    very `rm -f /tmp/x` case Bug C is meant to allow.
    """
    for seg in re.split(r"[;&|]+", command):
        toks = re.findall(r"[^\s;&|()<>]+", seg)
        for tok in toks[1:]:               # skip the command word
            if tok.startswith("-"):        # skip flags
                continue
            if is_guarded(canon(tok.strip("'\""), eff)):
                return True
    return False


def bash_would_mutate_guarded(command: str, cwd: str) -> bool:
    """True only when the command MUTATES a path in the guarded main checkout.

    Precision over recall: a command that merely READS the main checkout (e.g.
    `cp $MAIN/golden.png ./out`, `git -C $MAIN log`, `git -C $MAIN merge-base`)
    must never be blocked. So we require the mutation to *target* the checkout —
    via cwd, a redirect target, a mutating `git -C`, or `cargo --manifest-path`.
    """
    if not command:
        return False

    eff = effective_cwd(command, cwd)

    # (a) cwd (after any leading `cd`) IS the guarded checkout and the command
    #     mutates it. git/cargo act on the cwd (kills incident E: `cargo build`/
    #     `fmt` in the main checkout, and in-cwd `git commit`). Generic file
    #     mutators (rm/cp/touch/...) only count if an OPERAND resolves in-tree,
    #     so `rm -f /tmp/x` with cwd pinned to main is allowed through (Bug C).
    if is_guarded(eff):
        if GIT_MUTATE.search(command) or CARGO_MANIFEST.search(command) \
           or CARGO_CWD.search(command):
            return True                    # git/cargo act on the guarded cwd
        if GENERIC_MUTATE.search(command) and _generic_targets_guarded(command, eff):
            return True                    # rm/cp/... only if a target is in-tree

    # (b) an output redirect whose target resolves into the guarded checkout,
    #     honoring a leading `cd <worktree>` exactly as branch (a) does (Bug B).
    for m in REDIRECT.finditer(command):
        if is_guarded(canon(m.group(1).strip("'\""), eff)):
            return True

    # (c) a MUTATING git invocation whose `-C <path>` points into the checkout.
    for m in GIT_MUTATE.finditer(command):
        for cm in re.finditer(r"-C\s+(\S+)", m.group(2) or ""):
            if is_guarded(canon(cm.group(1).strip("'\""), cwd)):
                return True

    # (d) a cargo build-family command whose --manifest-path is in the checkout.
    for m in CARGO_MANIFEST.finditer(command):
        if is_guarded(canon(m.group(1).strip("'\""), cwd)):
            return True

    return False


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0  # fail-open: never wedge a session on a parse error

    tool = data.get("tool_name", "")
    ti = data.get("tool_input", {}) or {}
    cwd = data.get("cwd", "") or os.getcwd()

    blocked_path = None

    if tool in ("Write", "Edit", "MultiEdit"):
        p = ti.get("file_path", "")
        if p and is_guarded(canon(p, cwd)):
            blocked_path = p
    elif tool == "NotebookEdit":
        p = ti.get("notebook_path", "") or ti.get("file_path", "")
        if p and is_guarded(canon(p, cwd)):
            blocked_path = p
    elif tool == "Bash":
        cmd = ti.get("command", "")
        if bash_would_mutate_guarded(cmd, cwd):
            blocked_path = LOON_MAIN

    if blocked_path is not None:
        sys.stderr.write(
            f"BLOCKED by R1 guard: this write targets the {PROJECT} MAIN integration "
            f"checkout ({LOON_MAIN}).\n"
            "Agents must never mutate the main checkout — work only inside your "
            "worktree under .claude/worktrees/<task>/ using its ABSOLUTE path "
            "(e.g. " + os.path.join(LOON_WORKTREES, "<task>") + "/...).\n"
            "If you meant to edit the main checkout, that is not permitted; move "
            "the change into your worktree.\n"
        )
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
