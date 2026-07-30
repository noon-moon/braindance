#!/usr/bin/env python3
"""
tournament-score.py — scoring for the braindance optimization tournament (part of
artifact #2). Generic tooling — canonical home core template ctx/tools/.

Consumes:
  --tokens-csv  : the accumulated output of tournament-parse-transcript.py
                  (one row per run; label carries task=..,config=..,run=..)
  --quality-csv : per-run gate results the runner writes
                  (columns: label, passed[0/1], graded[0..1])
  --spec        : tournament-spec.json (cost_weights, quality_floor, modes)

Produces, per (task, config) cell: cost-weighted 4-tier token total, latency,
ttfu, pass-rate, mean graded; applies the STRICT quality floor; then ranks
configs for each operating mode (cheap / fast / balanced) per the spec. NO model
calls — pure arithmetic over CSVs.

The cost-weighted token total is the point: cache_read dominates the raw sum
(validated: ~475M of ~498M in a real session), so a naive tokens_total would
mis-rank. We weight the four tiers by relative $/token (spec.cost_weights).
"""

import argparse
import csv
import json
import statistics as st
from collections import defaultdict


def parse_label(label):
    """`task=T3,config=cheap,run=2` -> {'task':'T3','config':'cheap','run':'2'}."""
    d = {}
    for part in (label or "").split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            d[k.strip()] = v.strip()
    return d


def load_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def weighted_tokens(row, w):
    def g(k):
        try:
            return float(row.get(k) or 0)
        except ValueError:
            return 0.0

    return (
        g("output_total") * w["output"]
        + g("input_total") * w["input"]
        + g("cache_creation_total") * w["cache_creation"]
        + g("cache_read_total") * w["cache_read"]
    )


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tokens-csv", required=True)
    ap.add_argument("--quality-csv", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--json-out", default=None, help="write the cell table + rankings as JSON")
    args = ap.parse_args(argv)

    with open(args.spec, encoding="utf-8") as f:
        spec = json.load(f)
    w = spec["cost_weights"]
    floor = spec["quality_floor"]

    tokens = load_csv(args.tokens_csv)
    quality = {r["label"]: r for r in load_csv(args.quality_csv)}

    # group runs by (task, config)
    cells = defaultdict(lambda: {"wtok": [], "latency": [], "ttfu": [], "passed": [], "graded": []})
    for row in tokens:
        lab = parse_label(row.get("label", ""))
        task, config = lab.get("task", "?"), lab.get("config", "?")
        c = cells[(task, config)]
        c["wtok"].append(weighted_tokens(row, w))
        wc = fnum(row.get("wall_clock_s"))
        tt = fnum(row.get("ttfu_s"))
        if wc is not None:
            c["latency"].append(wc)
        if tt is not None:
            c["ttfu"].append(tt)
        q = quality.get(row.get("label", ""))
        if q:
            c["passed"].append(int(fnum(q.get("passed")) or 0))
            g = fnum(q.get("graded"))
            if g is not None:
                c["graded"].append(g)

    def med(xs):
        return st.median(xs) if xs else None

    # build the cell table
    table = []
    for (task, config), c in sorted(cells.items()):
        n = len(c["wtok"])
        passes = sum(c["passed"])
        repeatable = task in floor["repeatable_tasks"]
        # strict floor: repeatable must be all-pass (5/5 == n_pass==n and n>=5-ish);
        # expensive is directional (>=1 pass of its 1-2 runs)
        if repeatable:
            floor_ok = n > 0 and passes == n and n >= min(5, spec["runs_per_cell"].get(task, 5))
        else:
            floor_ok = passes >= 1
        table.append({
            "task": task, "config": config, "n": n,
            "pass_rate": f"{passes}/{n}",
            "floor_ok": floor_ok,
            "weighted_tokens_med": med(c["wtok"]),
            "latency_s_med": med(c["latency"]),
            "ttfu_s_med": med(c["ttfu"]),
            "graded_mean": (sum(c["graded"]) / len(c["graded"])) if c["graded"] else None,
        })

    # aggregate per config across tasks (only floor-passing cells count)
    per_config = defaultdict(lambda: {"wtok": 0.0, "latency": 0.0, "ttfu": [], "ok": True, "cells": 0})
    for cell in table:
        pc = per_config[cell["config"]]
        if not cell["floor_ok"]:
            pc["ok"] = False
        if cell["weighted_tokens_med"] is not None:
            pc["wtok"] += cell["weighted_tokens_med"]
        if cell["latency_s_med"] is not None:
            pc["latency"] += cell["latency_s_med"]
        if cell["ttfu_s_med"] is not None:
            pc["ttfu"].append(cell["ttfu_s_med"])
        pc["cells"] += 1

    survivors = {k: v for k, v in per_config.items() if v["ok"]}

    def rank(metric):
        # lower is better; returns [(config, value), ...]
        vals = []
        for cfg, v in survivors.items():
            if metric == "wtok":
                vals.append((cfg, v["wtok"]))
            elif metric == "ttfu":
                vals.append((cfg, med(v["ttfu"]) if v["ttfu"] else float("inf")))
            elif metric == "latency":
                vals.append((cfg, v["latency"]))
        return sorted(vals, key=lambda x: x[1])

    cheap = rank("wtok")     # cheap mode: min weighted tokens
    fast = rank("ttfu")      # fast mode: min ttfu
    # balanced = pareto knee proxy: min normalized (tokens+latency)
    balanced = []
    if survivors:
        tmax = max(v["wtok"] for v in survivors.values()) or 1
        lmax = max(v["latency"] for v in survivors.values()) or 1
        balanced = sorted(
            ((cfg, v["wtok"] / tmax + v["latency"] / lmax) for cfg, v in survivors.items()),
            key=lambda x: x[1],
        )

    # report
    print("=== cell table (per task x config) ===")
    hdr = f"{'task':4} {'config':16} {'n':>2} {'pass':>6} {'floor':>5} {'wtok':>14} {'lat_s':>8} {'ttfu_s':>7}"
    print(hdr)
    for c in table:
        wt = f"{c['weighted_tokens_med']:,.0f}" if c["weighted_tokens_med"] is not None else "-"
        la = f"{c['latency_s_med']:.1f}" if c["latency_s_med"] is not None else "-"
        tt = f"{c['ttfu_s_med']:.1f}" if c["ttfu_s_med"] is not None else "-"
        print(f"{c['task']:4} {c['config']:16} {c['n']:>2} {c['pass_rate']:>6} {'OK' if c['floor_ok'] else 'FAIL':>5} {wt:>14} {la:>8} {tt:>7}")

    def show(name, ranking):
        print(f"\n=== {name} ===")
        if not ranking:
            print("  (no floor-passing configs)")
        for i, (cfg, val) in enumerate(ranking):
            tag = "  <-- champion" if i == 0 else ""
            print(f"  {cfg:20} {val:,.1f}{tag}")

    print(f"\nfloor-passing configs: {sorted(survivors) or '(none)'}")
    show("cheap mode (min cost-weighted tokens)", cheap)
    show("fast mode (min ttfu)", fast)
    show("balanced (pareto-knee proxy)", balanced)

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump({"table": table, "cheap": cheap, "fast": fast, "balanced": balanced}, f, indent=2, default=str)
        print(f"\njson written -> {args.json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
