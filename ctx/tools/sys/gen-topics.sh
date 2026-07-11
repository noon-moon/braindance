#!/usr/bin/env python3
# gen-topics.sh — generate ctx/vault/_meta/Topics.md, the topics manifest.
# Part of the braindance lifecycle; not a user-authored note.
#
# Walks every `scope`-tagged vault note's frontmatter (tags / scope_kind /
# Contains / Contained By) and emits the manifest: a Content-scopes section and
# a System-scopes section (scope_kind: system), each entry = the hub wikilink,
# a one-line purpose, and its Contains children. Output is a pure, deterministic
# function of the scope notes' frontmatter — alphabetical, so regen diffs stay
# clean and the file is idempotent (re-running never changes bytes).
#
# Usage:  ctx/tools/sys/gen-topics.sh            # regenerate in place
#         ctx/tools/sys/gen-topics.sh --check    # exit 1 if out of date (CI)
#
# Named .sh for discoverability alongside its sibling lifecycle scripts; it is a
# python3 program (stdlib only — no third-party deps) because frontmatter and
# wikilink parsing are cleaner there than in pure sh.
"""Generate the braindance topics manifest (ctx/vault/_meta/Topics.md)."""

import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BD_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
VAULT = os.path.join(BD_ROOT, "ctx", "vault")
OUT = os.path.join(VAULT, "_meta", "Topics.md")

# Vault dirs that never hold content/system scope notes.
SKIP_DIRS = {"_ephemeral", "_templates", "daily", "assets", "attachments"}

WIKILINK = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")


def split_frontmatter(text):
    """Return (frontmatter, body) for a note, or (None, text) if none."""
    if not text.startswith("---"):
        return None, text
    end = text.find("\n---", 3)
    if end == -1:
        return None, text
    fm = text[3:end].strip("\n")
    body = text[end + 4:]
    return fm, body


def fm_list(fm, key):
    """Extract a block-style YAML list of wikilinks for `key` from frontmatter."""
    lines = fm.splitlines()
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r"^(\w[\w ]*):\s*(.*)$", line)
        if m and m.group(1).strip().lower() == key.lower():
            inline = m.group(2).strip()
            if inline.startswith("["):  # inline flow list on the same line
                out += WIKILINK.findall(inline)
            j = i + 1
            while j < len(lines) and re.match(r"^\s*-\s", lines[j]):
                out += WIKILINK.findall(lines[j])
                j += 1
            return out
        i += 1
    return out


def fm_scalar(fm, key):
    for line in fm.splitlines():
        m = re.match(r"^(\w[\w ]*):\s*(.*)$", line)
        if m and m.group(1).strip().lower() == key.lower():
            return m.group(2).strip().strip("\"'")
    return None


def is_scope(fm):
    tags = fm_list_raw_tags(fm)
    return "scope" in tags


def fm_list_raw_tags(fm):
    """Tags as a set, handling block list and inline `tags: [a, b]`."""
    lines = fm.splitlines()
    tags = set()
    for i, line in enumerate(lines):
        m = re.match(r"^tags:\s*(.*)$", line)
        if m:
            inline = m.group(1).strip()
            if inline.startswith("["):
                for t in inline.strip("[]").split(","):
                    t = t.strip().strip("\"'")
                    if t:
                        tags.add(t)
            j = i + 1
            while j < len(lines) and re.match(r"^\s*-\s", lines[j]):
                tags.add(lines[j].split("-", 1)[1].strip().strip("\"'"))
                j += 1
            break
    return tags


# Inline preamble lines some notes carry before their real prose (a non-YAML
# "Created:/Status:/Tags:" header block, or a bare Zettel timestamp) — skipped
# when deriving a note's one-line purpose.
META_LINE = re.compile(
    r"^\s*("
    r"(created|updated|modified|status|tags|aliases|alias|date|author|source|"
    r"link|url|type|rating|year|topic)\s*:"
    r"|\d{6,}\s*$"
    r")", re.IGNORECASE)


HR = re.compile(r"^\s*(-{3,}|\*{3,}|_{3,})\s*$")


def first_purpose(body):
    """The note's first real prose paragraph, as a single line trimmed to one
    sentence. Skips heading lines, horizontal rules, fenced code (e.g. Dataview
    blocks), and the inline metadata preamble some notes carry."""
    collected = []
    in_fence = False
    for ln in body.splitlines():
        s = ln.strip()
        if s.startswith("```") or s.startswith("~~~"):
            in_fence = not in_fence
            if collected:
                break
            continue
        if in_fence:
            continue
        skip = (not s or s.startswith("#") or HR.match(s) or META_LINE.match(ln))
        if skip:
            if collected:
                break  # a blank/heading/rule ends the first prose paragraph
            continue
        collected.append(s)
    if not collected:
        return ""
    one = " ".join(" ".join(collected).split())
    one = re.sub(r"^[*_>\s]+", "", one)  # strip leading emphasis / blockquote
    # First sentence, if reasonably long.
    m = re.match(r"^(.{40,}?[.!?])\s", one)
    if m:
        one = m.group(1)
    if len(one) > 240:
        one = one[:239].rsplit(" ", 1)[0] + "…"
    return one


# The manifest is a scope too (self-hosting), but it is excluded from the walk
# above so generation stays a fixed point; inject its entry canonically instead.
SELF_ENTRY = {
    "title": "Topics",
    "kind": "system",
    "contains": [],
    "purpose": "This manifest — the generated index of every scope hub.",
}


def collect():
    scopes = [dict(SELF_ENTRY)]
    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in files:
            if not fn.endswith(".md"):
                continue
            path = os.path.join(root, fn)
            if os.path.abspath(path) == OUT:
                continue  # never scan our own output — keeps generation a fixed point
            text = open(path, encoding="utf-8").read()
            fm, body = split_frontmatter(text)
            if fm is None or not is_scope(fm):
                continue
            scopes.append({
                "title": fn[:-3],
                "kind": (fm_scalar(fm, "scope_kind") or "content").lower(),
                "contains": fm_list(fm, "Contains"),
                "purpose": first_purpose(body),
            })
    return scopes


def render(scopes):
    content = sorted((s for s in scopes if s["kind"] != "system"),
                     key=lambda s: s["title"].lower())
    system = sorted((s for s in scopes if s["kind"] == "system"),
                    key=lambda s: s["title"].lower())

    def entry(s):
        lines = ["### [[%s]]" % s["title"]]
        if s["purpose"]:
            lines.append(s["purpose"])
        if s["contains"]:
            kids = " · ".join("[[%s]]" % c for c in s["contains"])
            lines.append("**Contains:** " + kids)
        return "\n".join(lines)

    out = []
    out.append("---")
    out.append("tags:")
    out.append("  - scope")
    out.append("scope_kind: system")
    out.append("Contained By:")
    out.append('  - "[[Agent Context]]"')
    out.append("---")
    out.append("")
    out.append("<!-- GENERATED — do not edit; regen: ctx/tools/sys/gen-topics.sh -->")
    out.append("")
    out.append("# Topics")
    out.append("")
    out.append(
        "The authoritative manifest of every `scope` hub in this vault — the "
        "one-stop \"does the repo have context on this topic, and where's its "
        "hub?\" lookup. It is **authoritative-and-generated**: regenerated "
        "mechanically from scope-note frontmatter, so a **miss is decisive** — "
        "if a topic isn't listed here, the vault has no scope for it (don't "
        "grep for it). Start from an entry's hub `[[wikilink]]` and follow its "
        "links. See [[Agent Context]] for how this fits the agent-context model."
    )
    out.append("")
    out.append("## Content scopes")
    out.append("")
    out.append("\n\n".join(entry(s) for s in content) if content
               else "_(none yet)_")
    out.append("")
    out.append("## System scopes")
    out.append("")
    out.append("Agent / infrastructure / meta scopes (`scope_kind: system`) — "
               "excluded from a content search unless explicitly granted.")
    out.append("")
    out.append("\n\n".join(entry(s) for s in system) if system
               else "_(none yet)_")
    out.append("")
    return "\n".join(out)


def main():
    scopes = collect()
    text = render(scopes)
    if "--check" in sys.argv:
        current = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else ""
        if current != text:
            sys.stderr.write("Topics.md is out of date — run ctx/tools/sys/gen-topics.sh\n")
            sys.exit(1)
        return
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    n_sys = sum(1 for s in scopes if s["kind"] == "system")
    print("Wrote %s (%d content, %d system scopes)"
          % (os.path.relpath(OUT, BD_ROOT), len(scopes) - n_sys, n_sys))


if __name__ == "__main__":
    main()
