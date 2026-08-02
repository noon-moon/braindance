#!/usr/bin/env python3
"""Tests for resolve-instance.py (the SessionStart context hook).

Feeds SessionStart JSON on stdin and asserts the additionalContext it injects.
Run: ./test_resolve_instance.py
"""
import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resolve-instance.py")


def run(cwd, reg):
    env = dict(os.environ)
    env["BD_REGISTRY"] = reg
    for k in ("BD_ROOT", "VAULT_PATH", "REPOS_PATH", "BD_ACTIVE_INSTANCE", "BD_USE"):
        env.pop(k, None)
    payload = json.dumps({"hook_event_name": "SessionStart", "cwd": cwd})
    p = subprocess.run([sys.executable, HOOK], input=payload,
                       capture_output=True, text=True, env=env)
    return p.returncode, p.stdout


def additional_context(stdout):
    if not stdout.strip():
        return ""
    return json.loads(stdout)["hookSpecificOutput"]["additionalContext"]


def main():
    tmp = os.path.realpath(tempfile.mkdtemp(prefix="bdsess."))
    reg = os.path.join(tmp, "registry")
    os.makedirs(os.path.join(reg, "instances"))
    for d in ("dev/braindance", "dev/vault", "dev/repo/loon", "scratch"):
        os.makedirs(os.path.join(tmp, *d.split("/")), exist_ok=True)
    with open(os.path.join(reg, "instances", "personal.conf"), "w") as f:
        f.write(f"core = {tmp}/dev/braindance\nvault = {tmp}/dev/vault\nrepos = {tmp}/dev/repo\n")

    # a worktree of personal.core, outside all territories
    P = os.path.join(tmp, "dev", "braindance")
    subprocess.run(["git", "-C", P, "init", "-q"], capture_output=True)
    subprocess.run(["git", "-C", P, "-c", "user.email=t@e", "-c", "user.name=t",
                    "commit", "-q", "--allow-empty", "-m", "init"], capture_output=True)
    wt = os.path.join(tmp, "scratch", "wt-x")
    subprocess.run(["git", "-C", P, "worktree", "add", "-q", wt, "-b", "wt/x"],
                   capture_output=True)

    npass = nfail = 0

    def check(desc, cond):
        nonlocal npass, nfail
        if cond:
            npass += 1
        else:
            nfail += 1
            print(f"FAIL: {desc}")

    # active instance -> context names it + vault
    rc, out = run(os.path.join(tmp, "dev", "repo", "loon"), reg)
    ctx = additional_context(out)
    check("active rc 0", rc == 0)
    check("active names personal", "personal" in ctx)
    check("active includes vault", f"{tmp}/dev/vault" in ctx)

    # worktree cwd -> resolves personal via common-dir
    _, out = run(wt, reg)
    check("worktree names personal", "personal" in additional_context(out))

    # neutral cwd (instances exist) -> "no instance active" message
    _, out = run(os.path.join(tmp, "scratch"), reg)
    ctx = additional_context(out)
    check("neutral says none active", "No braindance instance is active" in ctx)
    check("neutral lists registered", "personal" in ctx)

    # no registry -> no context, exit 0
    empty = os.path.join(tmp, "empty")
    os.makedirs(os.path.join(empty, "instances"))
    rc, out = run(os.path.join(tmp, "dev", "repo", "loon"), empty)
    check("no-registry rc 0", rc == 0)
    check("no-registry silent", out.strip() == "")

    subprocess.run(["rm", "-rf", tmp])
    print("-----")
    print(f"passed={npass} failed={nfail}")
    return 1 if nfail else 0


if __name__ == "__main__":
    sys.exit(main())
