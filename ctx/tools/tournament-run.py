#!/usr/bin/env python3
"""
tournament-run.py — sequential driver for the braindance optimization tournament
(artifact #3). Generic tooling — canonical home core template ctx/tools/.

Ties the harness together:
  spec (#2)  ->  serial cell schedule (Block 0-3)
             ->  per cell: [loadguard R3] dispatch a run -> parse transcript (#1)
                 -> append tokens CSV -> record gate result -> append quality CSV
             ->  score everything (tournament-score.py) -> cheap/fast/balanced

SAFETY: default mode is --dry-run (prints the full ready-to-run plan + budget
check and does NOTHING else). The expensive Loon run only happens with --go AND a
--dispatch-cmd, AND only while loadguard reports a quiet box (R3). This script
never itself calls a model.

The dispatch seam (--dispatch-cmd) keeps it harness-agnostic. Your command is
invoked once per run as:
    <dispatch-cmd> <task_id> <config> <run_idx> <prompt_file>
and must (1) execute exactly one agent run for that task/config, (2) print the
resulting Claude Code SESSION ID on the last stdout line, and (3) exit 0 iff the
task's hard success gate passed (nonzero = gate fail). Optionally print
`graded=<0..1>` on any stdout line for the graded quality score. The runner reads
that session with tournament-parse-transcript.py — nothing else is assumed about
your harness.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PARSER = os.path.join(HERE, "tournament-parse-transcript.py")
SCORER = os.path.join(HERE, "tournament-score.py")


def load_spec(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_schedule(spec):
    """Flatten the Block 1-3 plan into an ordered list of cells.

    Each cell: {block, task, config, n}. Config names encode the toggle set so
    the scorer can group by config. This is the SERIAL order runs execute in.
    """
    cells = []
    rpc = spec["runs_per_cell"]

    # Block 1 — hygiene bundle vs baseline, cheap tasks only
    b1 = spec["schedule"]["block1_hygiene_bundle"]
    for task in b1["tasks"]:
        for config in ["baseline", "hygiene"]:
            cells.append({"block": 1, "task": task, "config": config, "n": b1["n"]})

    # Block 2 — one toggle at a time on top of hygiene, on its screening tasks
    for tg, meta in spec["tested_toggles"].items():
        if tg.startswith("_") or not isinstance(meta, dict):
            continue
        cfg = f"hygiene+{tg}"
        for task in meta["screens_on"]:
            cells.append({"block": 2, "task": task, "config": cfg, "n": min(2, rpc.get(task, 2))})

    # Block 3 — finalist champion configs across the expensive suite
    b3 = spec["schedule"]["block3_finalists"]
    for config in b3["configs"]:
        for task in b3["tasks"]:
            cells.append({"block": 3, "task": task, "config": config, "n": rpc.get(task, 1)})

    return cells


def est_minutes(spec, cells):
    est = {t["id"]: t.get("est_wall_clock_min", 5) for t in spec["tasks"]}
    return sum(est.get(c["task"], 5) * c["n"] for c in cells)


def task_prompt(spec, task_id):
    for t in spec["tasks"]:
        if t["id"] == task_id:
            return t["prompt"]
    return ""


def loadguard_ok(spec):
    lg = spec.get("budget", {}).get("loadguard")
    if not lg:
        return True
    # spec path is repo-relative to ctx/tools/orchestration/loadguard.sh
    candidate = os.path.join(HERE, "orchestration", "loadguard.sh")
    lg_path = candidate if os.path.exists(candidate) else lg
    try:
        return subprocess.run([lg_path], capture_output=True).returncode == 0
    except OSError:
        print(f"warn: loadguard not runnable ({lg_path}); assuming loaded, refusing to run", file=sys.stderr)
        return False


def run_cell(cell, spec, dispatch_cmd, tokens_csv, quality_csv):
    prompt = task_prompt(spec, cell["task"])
    for run_idx in range(cell["n"]):
        if not loadguard_ok(spec):
            print(f"  R3: box loaded — pausing before {cell['task']}/{cell['config']} run {run_idx}", file=sys.stderr)
            return False
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as pf:
            pf.write(prompt)
            prompt_file = pf.name
        label = f"task={cell['task']},config={cell['config']},run={run_idx}"
        proc = subprocess.run(
            [dispatch_cmd, cell["task"], cell["config"], str(run_idx), prompt_file],
            capture_output=True, text=True,
        )
        os.unlink(prompt_file)
        passed = 1 if proc.returncode == 0 else 0
        session = ""
        graded = ""
        for line in proc.stdout.splitlines():
            if line.strip():
                session = line.strip()
            if line.startswith("graded="):
                graded = line.split("=", 1)[1].strip()
        if not session:
            print(f"  warn: no session id from dispatch for {label}", file=sys.stderr)
            continue
        # parse -> tokens CSV
        subprocess.run([sys.executable, PARSER, session, "--label", label, "--csv", tokens_csv])
        # quality CSV
        newq = not os.path.exists(quality_csv)
        with open(quality_csv, "a", encoding="utf-8") as qf:
            if newq:
                qf.write("label,passed,graded\n")
            qf.write(f'"{label}",{passed},{graded}\n')
        print(f"  ran {label}: gate {'PASS' if passed else 'FAIL'} session={session[:12]}")
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--spec", default=os.path.join(HERE, "tournament-spec.json"))
    ap.add_argument("--go", action="store_true", help="actually execute (default is dry-run)")
    ap.add_argument("--dispatch-cmd", help="per-run dispatch command (see module docstring)")
    ap.add_argument("--out-dir", default="ctx/vault/_ephemeral/tournament-results")
    args = ap.parse_args(argv)

    spec = load_spec(args.spec)
    cells = build_schedule(spec)
    total = est_minutes(spec, cells)
    budget = spec["budget"]["total_wall_clock_minutes"]

    print("=== tournament schedule (serial / R3) ===")
    for c in cells:
        print(f"  B{c['block']}  {c['task']:4} {c['config']:22} x{c['n']}")
    print(f"\ncells: {len(cells)}   est on-clock: ~{total} min   budget: {budget} min "
          f"({'WITHIN' if total <= budget else 'OVER — prune Block 3'} budget)")
    print(f"off-clock warm-up (Block 0): {spec['schedule']['block0_warmup_offclock']}")

    if not args.go:
        print("\n[dry-run] nothing executed. Re-run with --go --dispatch-cmd <cmd> on a QUIET box to run.")
        return 0

    if not args.dispatch_cmd:
        print("error: --go requires --dispatch-cmd", file=sys.stderr)
        return 2
    if not loadguard_ok(spec):
        print("error: R3 — box is loaded; refusing to start a perf run", file=sys.stderr)
        return 3

    os.makedirs(args.out_dir, exist_ok=True)
    tokens_csv = os.path.join(args.out_dir, "tokens.csv")
    quality_csv = os.path.join(args.out_dir, "quality.csv")
    for c in cells:
        if not run_cell(c, spec, args.dispatch_cmd, tokens_csv, quality_csv):
            print("halted (loadguard). Resume later.", file=sys.stderr)
            break
    print("\n=== scoring ===")
    subprocess.run([sys.executable, SCORER, "--tokens-csv", tokens_csv,
                    "--quality-csv", quality_csv, "--spec", args.spec,
                    "--json-out", os.path.join(args.out_dir, "results.json")])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
