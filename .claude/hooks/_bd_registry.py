"""Shared registry/territory helpers for braindance instance-aware hooks.

Reads the user-global registry (~/.config/braindance, BD_REGISTRY overridable) —
the same store configure.sh writes and resolve.sh reads. Ownership here is by
physical TERRITORY (a path under an instance's core/vault/repos), independent of
any ambient env or shell pin, so the guards enforce by location even while the
shell resolver is in escape-hatch mode. See docs/instances.md.
"""
import os
import subprocess


def registry_dir():
    return os.environ.get("BD_REGISTRY") or os.path.join(
        os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),
        "braindance",
    )


def _canon(p):
    return os.path.realpath(os.path.normpath(os.path.expanduser(p))) if p else ""


def load_instances():
    """[(name, {'core':.., 'vault':.., 'repos':..}), ...] with canonical paths."""
    d = os.path.join(registry_dir(), "instances")
    out = []
    try:
        files = sorted(os.listdir(d))
    except OSError:
        return out
    for fn in files:
        if not fn.endswith(".conf"):
            continue
        terr = {}
        try:
            with open(os.path.join(d, fn), encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip()
                    if k in ("core", "vault", "repos") and v:
                        terr[k] = _canon(v)
        except OSError:
            continue
        out.append((fn[:-5], terr))
    return out


def under(path, root):
    if not path or not root:
        return False
    return path == root or path.startswith(root + os.sep)


def owner(path, instances, keys=("core", "vault", "repos")):
    """Name of the instance whose territory (longest prefix) contains `path`."""
    best, best_len = None, -1
    for name, terr in instances:
        for k in keys:
            t = terr.get(k)
            if t and under(path, t) and len(t) > best_len:
                best, best_len = name, len(t)
    return best


def git_main_root(cwd):
    """If cwd is inside a git worktree, the main checkout root; else None."""
    try:
        r = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--git-common-dir"],
            capture_output=True, text=True, timeout=2,
        )
    except Exception:
        return None
    gcd = r.stdout.strip() if r.returncode == 0 else ""
    if not gcd:
        return None
    if not os.path.isabs(gcd):
        gcd = os.path.join(cwd, gcd)
    gcd = _canon(gcd)
    return os.path.dirname(gcd) if os.path.basename(gcd) == ".git" else None


def active_instance(cwd, instances):
    """Which instance owns cwd (by territory, incl. a worktree's main root)."""
    cwd = _canon(cwd)
    a = owner(cwd, instances)
    if a is None:
        mr = git_main_root(cwd)
        if mr:
            a = owner(mr, instances)
    return a
