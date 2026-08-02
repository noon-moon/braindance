#!/usr/bin/env python3
"""Tests for block-cross-instance-writes.py (the C2 cross-instance guard).

Builds a throwaway two-instance registry + territory trees (incl. a real git
worktree), feeds PreToolUse JSON on stdin, and asserts the exit code:
0 = allow, 2 = block. Run: ./test_block_cross_instance_writes.py
"""
import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "block-cross-instance-writes.py")


def run(tool, tool_input, cwd, reg):
    env = dict(os.environ)
    env["BD_REGISTRY"] = reg
    # a clean env so the caller's real instance config can't interfere
    for k in ("BD_ROOT", "VAULT_PATH", "REPOS_PATH", "BD_ACTIVE_INSTANCE", "BD_USE"):
        env.pop(k, None)
    payload = json.dumps({"tool_name": tool, "tool_input": tool_input, "cwd": cwd})
    p = subprocess.run([sys.executable, HOOK], input=payload,
                       capture_output=True, text=True, env=env)
    return p.returncode


def main():
    tmp = tempfile.mkdtemp(prefix="bdxguard.")
    tmp = os.path.realpath(tmp)
    reg = os.path.join(tmp, "registry")
    os.makedirs(os.path.join(reg, "instances"))

    # two disjoint instances; personal.core is a real git repo with a worktree
    def mk(*p):
        os.makedirs(os.path.join(tmp, *p), exist_ok=True)
    for d in ("dev/braindance", "dev/vault", "dev/repo/loon",
              "work/braindance", "work/vault", "work/repo/app", "scratch"):
        mk(*d.split("/"))

    def conf(name, base):
        with open(os.path.join(reg, "instances", name + ".conf"), "w") as f:
            f.write(f"core = {tmp}/{base}/braindance\n"
                    f"vault = {tmp}/{base}/vault\n"
                    f"repos = {tmp}/{base}/repo\n")
    conf("personal", "dev")
    conf("work", "work")

    P = lambda *p: os.path.join(tmp, "dev", *p)      # personal territory
    W = lambda *p: os.path.join(tmp, "work", *p)     # work territory

    # a worktree of personal.core, OUTSIDE all territories
    g = lambda *a: subprocess.run(["git", "-C", P("braindance"), *a],
                                  capture_output=True)
    subprocess.run(["git", "-C", P("braindance"), "init", "-q"], capture_output=True)
    g("-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q",
      "--allow-empty", "-m", "init")
    wt = os.path.join(tmp, "scratch", "wt-x")
    g("worktree", "add", "-q", wt, "-b", "wt/x")

    npass = nfail = 0

    def check(desc, got, want):
        nonlocal npass, nfail
        if got == want:
            npass += 1
        else:
            nfail += 1
            print(f"FAIL: {desc} (want exit {want}, got {got})")

    # --- file tools ---
    # write within the active instance -> allow
    check("write in own vault", run("Write", {"file_path": P("vault", "n.md")},
          P("repo", "loon"), reg), 0)
    # cross-instance file write -> block
    check("write into other vault", run("Write", {"file_path": W("vault", "n.md")},
          P("repo", "loon"), reg), 2)
    check("edit into other repos", run("Edit", {"file_path": W("repo", "app", "x")},
          P("repo", "loon"), reg), 2)
    # write outside every vault/repos -> allow
    check("write to /tmp neutral", run("Write", {"file_path": os.path.join(tmp, "scratch", "z")},
          P("repo", "loon"), reg), 0)
    # neutral cwd (no active instance) -> allow even a cross-target
    check("neutral cwd allows", run("Write", {"file_path": W("vault", "n.md")},
          os.path.join(tmp, "scratch"), reg), 0)
    # NotebookEdit path honored
    check("notebook cross-block", run("NotebookEdit", {"notebook_path": W("vault", "n.ipynb")},
          P("repo", "loon"), reg), 2)

    # --- Bash ---
    # redirect into another instance's vault -> block
    check("bash redirect cross", run("Bash", {"command": f"echo x > {W('vault', 'f')}"},
          P("repo", "loon"), reg), 2)
    # redirect within active instance -> allow
    check("bash redirect own", run("Bash", {"command": "echo x > ./f"},
          P("repo", "loon"), reg), 0)
    # pure read of another instance -> allow (not a mutation)
    check("bash read other", run("Bash", {"command": f"cat {W('vault', 'f')}"},
          P("repo", "loon"), reg), 0)
    # generic mutator operand into another instance -> block
    check("bash rm cross", run("Bash", {"command": f"rm -f {W('repo', 'app', 'x')}"},
          P("repo", "loon"), reg), 2)
    # leading `cd` into work then write within work -> allow (active follows cd)
    check("bash cd-into-work own", run("Bash", {"command": f"cd {W('repo', 'app')} && echo x > f"},
          P("repo", "loon"), reg), 0)
    # leading `cd` into work then write into personal -> block (cross)
    check("bash cd-into-work cross", run("Bash", {"command": f"cd {W('repo', 'app')} && echo x > {P('vault', 'n')}"},
          P("repo", "loon"), reg), 2)

    # --- worktree: cwd is a worktree whose main root is personal.core ---
    check("worktree active via common-dir", run("Write", {"file_path": W("vault", "n.md")},
          wt, reg), 2)

    # --- no registry -> allow everything ---
    empty = os.path.join(tmp, "empty")
    os.makedirs(os.path.join(empty, "instances"))
    check("no instances allows", run("Write", {"file_path": W("vault", "n.md")},
          P("repo", "loon"), empty), 0)

    subprocess.run(["rm", "-rf", tmp])
    print("-----")
    print(f"passed={npass} failed={nfail}")
    return 1 if nfail else 0


if __name__ == "__main__":
    sys.exit(main())
