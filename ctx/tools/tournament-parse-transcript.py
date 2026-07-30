#!/usr/bin/env python3
"""
tournament-parse-transcript.py — token + latency instrumentation for the
braindance optimization tournament (artifact #1).

STAGED, NOT LANDED. Intended canonical home: core template
`noon-moon/braindance:master` under `ctx/tools/` (generic tooling, same family as
sync.sh / flatten-vault.sh). It is written here in `_ephemeral/` only as a
ready-to-PR staging copy — do NOT commit it to the fork; promote to the template
once the orchestrator greenlights publish (per Q7 split: parser = generic template;
its CSV output = ephemeral instance data).

WHAT IT DOES
------------
Given one Claude Code session id (or a session .jsonl path), it walks the whole
agent tree — the main-loop transcript plus every `subagents/agent-*.jsonl` — and
rolls up, per the tournament's three token/latency axes:

  tokens : input / output / cache_read / cache_creation, split main vs sub-agents,
           per-model (so S-TIER model-tiering is visible)
  latency: total wall-clock, time-to-first-useful-response (ttfu), and
           main-thread busy proxy
  tree   : sub-agent count + max spawn depth (for S-DEPTH)

Emits a one-line human summary and (with --csv) one CSV row per run, ready to
concatenate across tournament cells. It performs NO model calls — it only reads
transcripts the harness already writes, so measuring is free (§3.4).

USAGE
-----
  tournament-parse-transcript.py <session-id-or-jsonl> [--label cell=T1,cfg=baseline] [--csv out.csv]
  tournament-parse-transcript.py --projects-dir ~/.claude/projects/<proj> <session-id>

Session layout it expects (Claude Code):
  <proj>/<session>.jsonl                         # main loop
  <proj>/<session>/subagents/agent-*.jsonl       # one per sub-agent
  <proj>/<session>/subagents/agent-*.meta.json   # {agentType, description, spawnDepth}
"""

import argparse
import csv
import glob
import json
import os
import sys
from datetime import datetime, timezone

DEFAULT_PROJECTS_DIR = os.path.expanduser(
    "~/.claude/projects/-Users-tiernan-dev-braindance-usr"
)


def _parse_ts(s):
    """ISO8601 (with trailing Z) -> aware datetime, or None."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def parse_one_transcript(path):
    """Roll up one .jsonl transcript (main loop OR a single sub-agent).

    Returns a dict with token sums (overall + per model), first/last assistant
    timestamps, first user timestamp, and the ttfu (first user -> first
    assistant-with-output).
    """
    agg = {
        "input": 0,
        "output": 0,
        "cache_read": 0,
        "cache_creation": 0,
        "assistant_msgs": 0,
        "per_model": {},  # model -> {input, output, cache_read, cache_creation}
        "first_user_ts": None,
        "first_assistant_output_ts": None,
        "first_ts": None,
        "last_ts": None,
    }
    try:
        f = open(path, "r", encoding="utf-8")
    except OSError as e:
        print(f"warn: cannot open {path}: {e}", file=sys.stderr)
        return agg
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = _parse_ts(rec.get("timestamp"))
            if ts:
                if agg["first_ts"] is None or ts < agg["first_ts"]:
                    agg["first_ts"] = ts
                if agg["last_ts"] is None or ts > agg["last_ts"]:
                    agg["last_ts"] = ts
            rtype = rec.get("type")
            msg = rec.get("message")
            if rtype == "user" and agg["first_user_ts"] is None and ts:
                agg["first_user_ts"] = ts
            if rtype != "assistant" or not isinstance(msg, dict):
                continue
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            model = msg.get("model", "unknown")
            i = usage.get("input_tokens", 0) or 0
            o = usage.get("output_tokens", 0) or 0
            cr = usage.get("cache_read_input_tokens", 0) or 0
            cc = usage.get("cache_creation_input_tokens", 0) or 0
            agg["input"] += i
            agg["output"] += o
            agg["cache_read"] += cr
            agg["cache_creation"] += cc
            agg["assistant_msgs"] += 1
            pm = agg["per_model"].setdefault(
                model, {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}
            )
            pm["input"] += i
            pm["output"] += o
            pm["cache_read"] += cr
            pm["cache_creation"] += cc
            # ttfu marker: first assistant message that actually emitted output
            if o > 0 and agg["first_assistant_output_ts"] is None and ts:
                agg["first_assistant_output_ts"] = ts
    return agg


def resolve_paths(session_or_path, projects_dir):
    """Return (main_jsonl_path, subagents_dir) from a session id or a .jsonl path."""
    if session_or_path.endswith(".jsonl") and os.path.exists(session_or_path):
        main = session_or_path
        base = main[: -len(".jsonl")]
    else:
        session = os.path.basename(session_or_path).replace(".jsonl", "")
        main = os.path.join(projects_dir, session + ".jsonl")
        base = os.path.join(projects_dir, session)
    subagents_dir = os.path.join(base, "subagents")
    return main, subagents_dir


def collect(session_or_path, projects_dir):
    main_path, subagents_dir = resolve_paths(session_or_path, projects_dir)
    if not os.path.exists(main_path):
        raise FileNotFoundError(f"main transcript not found: {main_path}")

    main = parse_one_transcript(main_path)

    subs = []
    for jl in sorted(glob.glob(os.path.join(subagents_dir, "agent-*.jsonl"))):
        meta = {}
        meta_path = jl[: -len(".jsonl")] + ".meta.json"
        if os.path.exists(meta_path):
            try:
                with open(meta_path, encoding="utf-8") as mf:
                    meta = json.load(mf)
            except (OSError, json.JSONDecodeError):
                pass
        a = parse_one_transcript(jl)
        a["_meta"] = meta
        a["_name"] = os.path.basename(jl)[: -len(".jsonl")]
        subs.append(a)

    def toks(d):
        return d["input"] + d["output"] + d["cache_read"] + d["cache_creation"]

    main_tokens = toks(main)
    sub_tokens = sum(toks(a) for a in subs)

    # per-model rollup across the whole tree (for S-TIER visibility)
    per_model = {}
    for src in [main] + subs:
        for model, pm in src["per_model"].items():
            agg = per_model.setdefault(
                model, {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}
            )
            for k, v in pm.items():
                agg[k] += v

    # latency
    all_ts = [main["first_ts"]] + [a["first_ts"] for a in subs]
    all_ts_end = [main["last_ts"]] + [a["last_ts"] for a in subs]
    tree_start = min([t for t in all_ts if t], default=None)
    tree_end = max([t for t in all_ts_end if t], default=None)
    wall_clock_s = (
        (tree_end - tree_start).total_seconds() if (tree_start and tree_end) else None
    )
    ttfu_s = None
    if main["first_user_ts"] and main["first_assistant_output_ts"]:
        ttfu_s = (
            main["first_assistant_output_ts"] - main["first_user_ts"]
        ).total_seconds()
    elif main["first_ts"] and main["first_assistant_output_ts"]:
        ttfu_s = (
            main["first_assistant_output_ts"] - main["first_ts"]
        ).total_seconds()

    max_depth = 0
    for a in subs:
        d = a.get("_meta", {}).get("spawnDepth", 1)
        if isinstance(d, int):
            max_depth = max(max_depth, d)

    return {
        "main_path": main_path,
        "subagent_count": len(subs),
        "max_spawn_depth": max_depth,
        "tokens_total": main_tokens + sub_tokens,
        "tokens_main": main_tokens,
        "tokens_subagents": sub_tokens,
        "input_total": main["input"] + sum(a["input"] for a in subs),
        "output_total": main["output"] + sum(a["output"] for a in subs),
        "cache_read_total": main["cache_read"] + sum(a["cache_read"] for a in subs),
        "cache_creation_total": main["cache_creation"]
        + sum(a["cache_creation"] for a in subs),
        "wall_clock_s": wall_clock_s,
        "ttfu_s": ttfu_s,
        "per_model": per_model,
        "subs": subs,
    }


def print_summary(r, label):
    def fmt(n):
        return f"{n:,}"

    print(f"=== tournament transcript rollup ===")
    if label:
        print(f"label            : {label}")
    print(f"main transcript  : {r['main_path']}")
    print(f"sub-agents       : {r['subagent_count']}  (max spawn depth {r['max_spawn_depth']})")
    print(f"tokens TOTAL     : {fmt(r['tokens_total'])}")
    print(f"  main / subs    : {fmt(r['tokens_main'])} / {fmt(r['tokens_subagents'])}")
    print(f"  input          : {fmt(r['input_total'])}")
    print(f"  output         : {fmt(r['output_total'])}")
    print(f"  cache_read     : {fmt(r['cache_read_total'])}")
    print(f"  cache_creation : {fmt(r['cache_creation_total'])}")
    wc = r["wall_clock_s"]
    tt = r["ttfu_s"]
    print(f"wall-clock (s)   : {wc:.1f}" if wc is not None else "wall-clock (s)   : n/a")
    print(f"ttfu (s)         : {tt:.1f}" if tt is not None else "ttfu (s)         : n/a")
    print("per-model tokens :")
    for model, pm in sorted(r["per_model"].items()):
        tot = pm["input"] + pm["output"] + pm["cache_read"] + pm["cache_creation"]
        print(f"  {model:22s} {fmt(tot):>12}  (out {fmt(pm['output'])})")


CSV_FIELDS = [
    "label",
    "subagent_count",
    "max_spawn_depth",
    "tokens_total",
    "tokens_main",
    "tokens_subagents",
    "input_total",
    "output_total",
    "cache_read_total",
    "cache_creation_total",
    "wall_clock_s",
    "ttfu_s",
]


def write_csv(r, label, csv_path):
    new = not os.path.exists(csv_path)
    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if new:
            w.writeheader()
        row = {k: r.get(k) for k in CSV_FIELDS if k != "label"}
        row["label"] = label or ""
        w.writerow(row)
    print(f"csv row appended -> {csv_path}", file=sys.stderr)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("session", help="session id or path to a session .jsonl")
    ap.add_argument("--projects-dir", default=DEFAULT_PROJECTS_DIR)
    ap.add_argument("--label", default="", help="free-form cell label, e.g. cell=T3,cfg=cheap")
    ap.add_argument("--csv", default=None, help="append one row to this CSV")
    args = ap.parse_args(argv)

    try:
        r = collect(args.session, args.projects_dir)
    except FileNotFoundError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print_summary(r, args.label)
    if args.csv:
        write_csv(r, args.label, args.csv)
    return 0


if __name__ == "__main__":
    sys.exit(main())
