#!/usr/bin/env python3
"""Summarise scale runs: per run, idle cost per resident tab, per-worker throughput and wall time, host and machine peaks."""
import json, sys, csv, statistics as st, os
runs = sys.argv[1:]
rows = []
for r in runs:
    s = json.load(open(os.path.join(r, 'summary.json')))
    for t in s['tabs']:
        rows.append((r, f"tab{t['tab']} resident", f"ready {t['readyMs']/1000:.1f}s", f"host rss {t['before']['serveRssMb']}→{t['after']['serveRssMb']} MB", f"swap {t['before']['swapMb']:.0f}→{t['after']['swapMb']:.0f} MB", f"free {t['before']['freePct']}→{t['after']['freePct']}%"))
    for run in s['runs']:
        for i, ser in enumerate(run['series']):
            work = [x for x in ser if x['producePerS'] > 0]
            pps = st.median([x['producePerS'] for x in work]) if work else 0
            cps = st.median([x['charsPerS'] for x in work]) if work else 0
            cpu = max((x['hostCpu'] or 0) for x in ser) if ser else 0
            rss = max((x['hostRssMb'] or 0) for x in ser) if ser else 0
            mem = max((x['sysMemUsedMb'] or 0) for x in ser) if ser else 0
            heap = max((x['heapMb'] or 0) for x in ser) if ser else 0
            lt = ser[-1]['longTasks'] if ser else 0; worst = ser[-1]['worstLongTask'] if ser else 0; gaps = ser[-1]['frameGaps'] if ser else 0
            wall = run['wallMs'][i]
            rows.append((r, f"worker{i} of {run['workers']}", f"wall {wall/1000:.0f}s" if wall else "INCOMPLETE", f"median produce/s {pps} ({cps} chars/s)", f"host cpu max {cpu}% rss max {rss} MB sys used max {mem} MB", f"tab heap max {heap} MB, long tasks {lt} (worst {worst} ms), frame gaps {gaps}"))
        if run['aborted']: rows.append((r, 'ABORTED by the guard', json.dumps(run['aborted']), '', '', ''))
    rows.append((r, 'end', json.dumps(s['end']), '', '', ''))
for row in rows: print(' | '.join(str(x) for x in row))
# machine samples per phase
if os.path.exists('samples.csv'):
    by = {}
    for d in csv.DictReader(open('samples.csv')):
        by.setdefault(d['phase'], []).append(d)
    print('\nphase | samples | serve rss max MB | serve cpu max % | headless chrome rss max MB | free % min | swap used max MB')
    for ph, ds in by.items():
        if not ph: continue
        f = lambda k: [float(d[k]) for d in ds if d[k] not in ('', 'NaN')]
        print(f"{ph} | {len(ds)} | {max(f('serve_rss_mb') or [0]):.0f} | {max(f('serve_cpu') or [0]):.0f} | {max(f('chrome_headless_rss_mb') or [0]):.0f} | {min(f('free_pct') or [0]):.0f} | {max(f('swap_used_mb') or [0]):.0f}")
