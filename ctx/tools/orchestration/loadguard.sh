#!/usr/bin/env bash
# loadguard.sh — is the machine quiet enough to trust a perf measurement?
#
# Multi-agent discipline R3 (see AGENTS.md). A perf/A-B/benchmark agent is
# EXCLUSIVE: it runs alone, and if the box is loaded it ABORTS + reports rather
# than quoting a meaningless number. (The classic failure: an A/B arm measures
# while sibling agents hammer the same machine, so it can't hold a baseline and
# the number is wasted.)
#
# A perf agent calls this before measuring (and may re-check between A and B):
#   loadguard.sh || { echo "machine loaded — abort measurement, retry later"; exit 1; }
#
# Exit 0 if 1-minute load average <= threshold, else 1. Threshold defaults to the
# CPU count (loadguard treats "load > #cores" as contended). Override:
#   loadguard.sh 4          # custom absolute threshold
#   LOADGUARD_FACTOR=0.75 loadguard.sh   # threshold = 0.75 * ncpu

set -uo pipefail
ncpu=$(sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 8)
factor="${LOADGUARD_FACTOR:-1.0}"
default_thr=$(awk -v n="$ncpu" -v f="$factor" 'BEGIN{printf "%.2f", n*f}')
thr="${1:-$default_thr}"

# 1-minute load average, portable across macOS/Linux `uptime` phrasings.
load1=$(uptime | sed -E 's/.*load averages?: *//; s/[, ].*$//' | tr -d ' ')
[ -n "$load1" ] || { echo "loadguard: could not read load average" >&2; exit 0; } # fail-open

awk -v l="$load1" -v t="$thr" -v n="$ncpu" 'BEGIN{
  if (l+0 <= t+0) { printf("loadguard: OK  load1=%.2f <= thr=%.2f (ncpu=%d)\n", l, t, n); exit 0 }
  else            { printf("loadguard: BUSY load1=%.2f >  thr=%.2f (ncpu=%d) — do not measure now\n", l, t, n); exit 1 }
}'
