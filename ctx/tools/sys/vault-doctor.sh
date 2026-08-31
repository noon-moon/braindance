#!/usr/bin/env python3
# vault-doctor.sh — check that the vault's containment graph is intact.
#
# WHY THIS EXISTS.
#
# `_meta/Topics.md` is authoritative-and-generated, and every agent guide says
# the same thing about it: a MISS IS DECISIVE. If a topic is not listed there,
# the vault has no context on it and you should not go looking. That contract is
# only as good as the manifest, and the manifest is derived — from scope-note
# frontmatter, by gen-topics.sh. So a note can become invisible without anything
# appearing broken: nothing errors, nothing is missing from disk, the note is
# right there when you `ls`. It simply stops being reachable.
#
# That is not hypothetical. A device sync flushed a stale in-memory copy of two
# scope hubs back over the current ones, dropping a `Contains:` entry for a note
# that had been committed and pushed hours earlier. Git recorded it as an edit,
# because that is what it looked like. The note stayed on disk and vanished from
# the manifest, and nothing anywhere said so.
#
# WHAT IT CHECKS.
#
#   dangling   a scope's `Contains:` names a note that does not exist
#   unrooted   a note's `Contained By:` names a scope that does not exist
#   stale      _meta/Topics.md differs from what gen-topics.sh would write now,
#              so the manifest is hand-edited or was clobbered
#   orphan     a content note no scope contains — counted always, listed on
#              request, and a FAILURE only in --since mode (see below)
#
# WHY ORPHANS ARE A COUNT AND NOT A GATE.
#
# 658 of this vault's 933 notes are unfiled. That is a real backlog and worth
# knowing, but it means "no orphans" is not a bar anything can clear today, and
# a gate nothing can pass gets switched off within a week. The failure this tool
# exists to catch is not "a note is unfiled" — it is "a note that WAS filed
# stopped being filed", which is what a clobbered `Contains:` list looks like
# from the outside.
#
# So the gate is REGRESSION, not absolute state: `--since <ref>` builds the
# containment graph at that git ref, builds it again from the working tree, and
# fails if a note lost its last parent or a hub lost a child. Pre-existing debt
# is invisible to it; a single dropped entry is not. That is the check a
# pre-commit hook and vault-push can both run on every change without becoming
# noise anyone learns to ignore.
#
# WHY IT IS A SEPARATE TOOL FROM gen-topics.
#
# gen-topics WRITES; this only READS (unless asked to --fix). That split is what
# lets it run from a pre-commit hook and from vault-push without either of them
# having a side effect they did not ask for.
#
# Usage:
#   vault-doctor.sh                 # report faults + the orphan count
#   vault-doctor.sh --since HEAD    # fail if THIS change orphaned anything
#   vault-doctor.sh --fix           # regenerate Topics.md if stale
#   vault-doctor.sh --list-orphans  # enumerate the backlog
#   vault-doctor.sh --quiet         # exit code only (for hooks)
#
# Exit: 0 = clean   1 = usage / no vault   2 = problems found

import os
import re
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
BD_ROOT = os.environ.get("BD_ROOT")
VAULT = (
    os.environ.get("VAULT_PATH")
    or (os.path.join(BD_ROOT, "vault") if BD_ROOT else None)
    or os.path.join(CORE, "ctx", "vault")
)
TOPICS = os.path.join(VAULT, "_meta", "Topics.md")

# Mirrors gen-topics.sh. Kept in step deliberately: a note the generator skips
# must not be reported as an orphan by the checker, or the two tools disagree
# about what the vault even contains.
SKIP_DIRS = {"_ephemeral", "_templates", "daily", "assets", "attachments"}

# Directories that hold notes which are legitimately unscoped. `_triage` is the
# applier's inbox — a capture lands there precisely BEFORE anything files it, so
# an unfiled note there is the system working, not a fault. `_meta` is
# machinery. Daily notes are already skipped above.
UNSCOPED_OK = {"_triage", "_meta"}

# The manifest is a scope that contains itself, and the generator excludes its
# own output from the walk so generation stays a fixed point. That makes
# `[[Topics]]` look like a link to a note that does not exist, when it is the
# one note guaranteed to. Name it rather than teaching the walk an exception.
VIRTUAL = {"Topics"}


def split_frontmatter(text):
    if not text.startswith("---"):
        return None, text
    end = text.find("\n---", 3)
    if end == -1:
        return None, text
    return text[3:end].strip("\n"), text[end + 4:]


def fm_list(fm, key):
    """Block-style YAML list of wikilinks under `key`. Same shape gen-topics reads."""
    out, lines, i = [], fm.splitlines(), 0
    while i < len(lines):
        if lines[i].strip() == key + ":":
            i += 1
            while i < len(lines) and re.match(r"^\s+-\s", lines[i]):
                m = re.search(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", lines[i])
                if m:
                    out.append(m.group(1).strip())
                i += 1
            break
        i += 1
    return out


def is_scope(fm):
    return re.search(r"^\s*-\s*scope\s*$", fm, re.M) is not None


def walk():
    """Every .md the generator would consider, as {title: (relpath, frontmatter)}."""
    notes = {}
    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in files:
            if not fn.endswith(".md"):
                continue
            path = os.path.join(root, fn)
            if os.path.abspath(path) == TOPICS:
                continue
            try:
                fm, _ = split_frontmatter(open(path, encoding="utf-8").read())
            except (OSError, UnicodeDecodeError):
                continue
            rel = os.path.relpath(path, VAULT)
            notes[fn[:-3]] = (rel, fm or "")
    return notes


def graph(notes):
    """(contained, dangling, unrooted, asym) for a {title: (rel, fm)} map.

    Containment is declarable from EITHER end — a hub's `Contains:` or a note's
    own `Contained By:`. Both count, because the vault already uses both: the
    hubs are top-down, while TaskNotes stores a task's scope as `Contained By`.
    A note is filed if either direction names it."""
    scopes = {t: fm for t, (_, fm) in notes.items() if is_scope(fm)}
    contained, dangling, unrooted, asym = set(), [], [], []
    for hub, fm in scopes.items():
        for child in fm_list(fm, "Contains"):
            if child in VIRTUAL:
                continue
            if child not in notes:
                dangling.append((hub, child))
            else:
                contained.add(child)
                if hub not in fm_list(notes[child][1], "Contained By"):
                    asym.append((hub, child))
    for title, (_, fm) in notes.items():
        for parent in fm_list(fm, "Contained By"):
            if parent not in notes:
                unrooted.append((title, parent))
            else:
                contained.add(title)
    return contained, dangling, unrooted, asym


def notes_at(ref):
    """The same {title: (rel, fm)} map, read out of a git ref instead of disk.

    Uses `git show` per path rather than a checkout: the working tree is the
    thing being judged and must not be disturbed to judge it."""
    try:
        listing = subprocess.run(["git", "-C", VAULT, "ls-tree", "-r", "--name-only", ref],
                                 capture_output=True, text=True, check=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    out = {}
    for rel in listing.splitlines():
        if not rel.endswith(".md"):
            continue
        top = rel.split("/")[0]
        if top in SKIP_DIRS or top.startswith("."):
            continue
        if os.path.normpath(rel) == os.path.relpath(TOPICS, VAULT):
            continue
        r = subprocess.run(["git", "-C", VAULT, "show", f"{ref}:{rel}"],
                           capture_output=True, text=True)
        if r.returncode != 0:
            continue
        fm, _ = split_frontmatter(r.stdout)
        out[os.path.basename(rel)[:-3]] = (rel, fm or "")
    return out


def topics_is_stale():
    """Regenerate into a scratch vault-relative path and compare. gen-topics writes
    to VAULT/_meta/Topics.md unconditionally, so compare by capturing the file
    before and after a run — cheaper and more honest than reimplementing render()."""
    gen = os.path.join(SCRIPT_DIR, "gen-topics.sh")
    if not os.path.exists(gen) or not os.path.exists(TOPICS):
        return False, None
    before = open(TOPICS, encoding="utf-8").read()
    r = subprocess.run([sys.executable, gen], capture_output=True, text=True,
                       env={**os.environ, "VAULT_PATH": VAULT})
    if r.returncode != 0:
        return False, None
    after = open(TOPICS, encoding="utf-8").read()
    if after != before:
        return True, before
    return False, None


def orphans_of(notes, contained):
    out = []
    for title, (rel, fm) in sorted(notes.items()):
        if title in contained or is_scope(fm):
            continue
        top = rel.split(os.sep)[0] if os.sep in rel else rel
        if top in UNSCOPED_OK:
            continue
        if re.match(r"^\d{2}-\d{2}-\d{2}", title) or re.match(r"^\d{4}-\d{2}-\d{2}", title):
            continue  # a daily note living outside daily/ is still a daily note
        out.append((title, rel))
    return out


def main():
    args = sys.argv[1:]
    flags = set(a for a in args if a.startswith("--"))
    quiet = "--quiet" in flags
    fix = "--fix" in flags
    list_orphans = "--list-orphans" in flags
    verbose = "--verbose" in flags
    since = None
    if "--since" in args:
        i = args.index("--since")
        since = args[i + 1] if i + 1 < len(args) else "HEAD"

    if not os.path.isdir(VAULT):
        print(f"vault-doctor: no vault at {VAULT}", file=sys.stderr)
        return 1

    notes = walk()
    contained, dangling, unrooted, asym = graph(notes)
    orphans = orphans_of(notes, contained)

    stale, prior = topics_is_stale()
    if stale and not fix and prior is not None:
        open(TOPICS, "w", encoding="utf-8").write(prior)  # read-only unless --fix

    # --- the gate: what did THIS change break? -----------------------------
    regressions = []
    if since:
        before = notes_at(since)
        if before is None:
            print(f"vault-doctor: cannot read git ref {since}", file=sys.stderr)
            return 1
        was_contained, _, _, _ = graph(before)
        for title in sorted(was_contained):
            # Deleting a note is a decision; un-filing one that still exists is
            # the clobber signature. Only the second is a regression.
            if title in notes and title not in contained:
                regressions.append(title)

    failed = bool(dangling or unrooted or stale or regressions)

    if not quiet:
        for title in regressions:
            print(f"REGRESSION: [[{title}]] was filed at {since} and is not filed now — "
                  f"a scope lost its entry")
        if stale:
            print(f"stale:      _meta/Topics.md {'regenerated' if fix else 'does not match the scope frontmatter'}"
                  + ("" if fix else " — fix with: vault-doctor.sh --fix"))
        for hub, child in dangling:
            print(f"dangling:   [[{hub}]] Contains [[{child}]], which does not exist")
        for title, parent in unrooted:
            print(f"unrooted:   [[{title}]] is Contained By [[{parent}]], which does not exist")
        if list_orphans:
            for title, rel in orphans:
                print(f"orphan:     {rel}")
        if verbose:
            for hub, child in asym:
                print(f"advisory:   [[{hub}]] Contains [[{child}]] but [[{child}]] does not say so")
        scopes_n = sum(1 for _, (_, fm) in notes.items() if is_scope(fm))
        print(f"vault-doctor: {len(notes)} notes, {scopes_n} scopes, "
              f"{len(orphans)} unfiled{' (--list-orphans to see them)' if orphans and not list_orphans else ''}"
              + (f", {len(asym)} one-way" if asym and not verbose else ""))
        if not failed:
            print("vault-doctor: clean — nothing regressed, manifest current")

    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
