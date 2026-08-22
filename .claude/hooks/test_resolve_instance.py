#!/usr/bin/env python3
"""Tests for resolve-instance.py (the SessionStart context hook).

Feeds SessionStart JSON on stdin and asserts the additionalContext it injects.
Covers the resolution ladder the hook delegates to resolve.sh: BD_USE pin (1),
location incl. git common-dir (2), registry `default` (3), and UNRESOLVED (5).
Run: ./test_resolve_instance.py
"""
import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resolve-instance.py")


def run(cwd, reg, extra_env=None):
    env = dict(os.environ)
    env["BD_REGISTRY"] = reg
    for k in ("BD_ROOT", "VAULT_PATH", "REPOS_PATH", "BD_ACTIVE_INSTANCE", "BD_USE"):
        env.pop(k, None)
    env.update(extra_env or {})
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
    # `app` is a synthetic fixture repo — deliberately not a real repo name, so
    # the fixture never collides with a guard that matches on real checkouts.
    for d in ("dev/braindance", "dev/vault", "dev/repo/app", "scratch"):
        os.makedirs(os.path.join(tmp, *d.split("/")), exist_ok=True)
    with open(os.path.join(reg, "instances", "personal.conf"), "w") as f:
        f.write(f"core = {tmp}/dev/braindance\nvault = {tmp}/dev/vault\nrepos = {tmp}/dev/repo\n")

    default_file = os.path.join(reg, "default")

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

    # --- step 2: location -------------------------------------------------
    rc, out = run(os.path.join(tmp, "dev", "repo", "app"), reg)
    ctx = additional_context(out)
    check("active rc 0", rc == 0)
    check("active names personal", "personal" in ctx)
    check("active includes vault", f"{tmp}/dev/vault" in ctx)
    check("active includes repos", f"{tmp}/dev/repo" in ctx)

    # worktree cwd -> resolves personal via common-dir
    _, out = run(wt, reg)
    check("worktree names personal", "personal" in additional_context(out))

    # --- step 5: unresolved (no pin, no territory, no default) ------------
    _, out = run(os.path.join(tmp, "scratch"), reg)
    ctx = additional_context(out)
    check("neutral says none active", "No braindance instance is active" in ctx)
    check("neutral lists registered", "personal" in ctx)

    # --- step 3: registry default pointer ---------------------------------
    # REGRESSION: this hook used to resolve by territory only, so a neutral cwd
    # (BD_ROOT itself, tools/, web/, worktrees/) was reported as "no instance"
    # even with a default set. The ladder says step 3 resolves it.
    with open(default_file, "w") as f:
        f.write("personal\n")

    _, out = run(os.path.join(tmp, "scratch"), reg)
    ctx = additional_context(out)
    check("default resolves neutral cwd", "Active braindance instance" in ctx)
    check("default names personal", "personal" in ctx)

    # BD_ROOT itself — the parent of every territory, owned by none of them
    _, out = run(os.path.join(tmp, "dev"), reg)
    check("default resolves BD_ROOT", "Active braindance instance" in additional_context(out))

    # --- step 1: BD_USE pin wins over location ----------------------------
    with open(os.path.join(reg, "instances", "work.conf"), "w") as f:
        f.write(f"core = {tmp}/work/braindance\nvault = {tmp}/work/vault\nrepos = {tmp}/work/repo\n")

    _, out = run(os.path.join(tmp, "dev", "repo", "app"), reg, {"BD_USE": "work"})
    ctx = additional_context(out)
    check("pin overrides location", f"{tmp}/work/vault" in ctx)
    check("pin names work", "**work**" in ctx)

    # --- rc 4: pin names an unregistered instance -------------------------
    _, out = run(os.path.join(tmp, "scratch"), reg, {"BD_USE": "nope"})
    check("bad pin surfaced", "not registered" in additional_context(out))

    # --- no registry -> silent no-op --------------------------------------
    empty = os.path.join(tmp, "empty")
    os.makedirs(os.path.join(empty, "instances"))
    rc, out = run(os.path.join(tmp, "dev", "repo", "app"), empty)
    check("no-registry rc 0", rc == 0)
    check("no-registry silent", out.strip() == "")

    # --- step 0: preset env (escape hatch) -> silent -----------------------
    rc, out = run(os.path.join(tmp, "dev", "repo", "app"), reg,
                  {"VAULT_PATH": f"{tmp}/elsewhere/vault"})
    check("preset env rc 0", rc == 0)
    check("preset env silent", out.strip() == "")

    subprocess.run(["rm", "-rf", tmp])
    print("-----")
    print(f"passed={npass} failed={nfail}")
    return 1 if nfail else 0


if __name__ == "__main__":
    sys.exit(main())
