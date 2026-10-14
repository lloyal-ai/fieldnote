// How served sessions scale: open tabs one at a time, measuring the host's resident set as each session
// becomes resident; then run K briefs at once and measure per-session throughput, wall time, the host's CPU
// and memory, and each tab's own cost (JS heap, long tasks, frame gaps). A memory guard stops the ramp.
// Usage: node scale.cjs <outdir> <tabs> <workers> [url]
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const [outdir, tabsArg, workersArg, urlArg] = process.argv.slice(2);
const TABS = Number(tabsArg || 1), WORKERS = Number(workersArg || TABS);
const url = urlArg || 'http://localhost:5173/';
fs.mkdirSync(outdir, { recursive: true });
const phaseFile = path.join(outdir, 'phase.txt');
const setPhase = (p) => fs.writeFileSync(phaseFile, p);
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(outdir, 'drive.log'), line + '\n'); };
const QUERIES = [
  'Write a brief on how the safety bicycle displaced the penny-farthing, with sources.',
  'Write a brief on why the Antikythera mechanism matters to the history of computing, with sources.',
  'Write a brief on how container shipping changed port cities after 1960, with sources.',
  'Write a brief on the origins of the metric system in revolutionary France, with sources.',
];
const machine = () => {
  const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }); } catch { return ''; } };
  const free = Number(sh('memory_pressure -Q').match(/free percentage: (\d+)%/)?.[1] ?? NaN);
  const swap = Number(sh('sysctl -n vm.swapusage').match(/used = ([\d.]+)M/)?.[1] ?? NaN);
  const pid = sh("ps -eo pid=,rss=,args= | awk '/node bin\\/serve.js/ && !/sh -c/ {print $2, $1}' | sort -rn | head -1 | awk '{print $2}' ").trim();
  const rss = pid ? Number(sh(`ps -o rss= -p ${pid}`).trim()) / 1024 : NaN;
  return { freePct: free, swapMb: swap, serveRssMb: Math.round(rss) };
};
const PROBE = () => {
  if (window.__probe) return 'already installed';
  const p = { t0: performance.now(), frames: [], host: [], longTasks: [], frameGaps: [], heap: [] };
  window.__probe = p;
  const h = window.harness;
  if (!h || typeof h.onEvent !== 'function') return 'no bridge';
  h.onEvent((frame) => {
    const ev = frame.ev || {};
    if (ev.type === 'host:resources') { p.host.push([performance.now(), ev.cpuPct, ev.rssMb, ev.sysMemUsedMb ?? null]); return; }
    const detail = ev.type === 'agent:tick' ? [ev.cellsUsed ?? null, ev.nCtx ?? null] : ev.tool != null ? String(ev.tool) : ev.reason != null ? String(ev.reason) : null;
    p.frames.push([performance.now(), ev.type, ev.agentId ?? null, typeof ev.text === 'string' ? ev.text.length : 0, detail]);
  });
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) p.longTasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  let last = performance.now();
  const tick = (now) => { if (now - last > 50) p.frameGaps.push([last, now - last]); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => { const m = performance.memory; if (m) p.heap.push([performance.now(), m.usedJSHeapSize]); }, 2000);
  return 'installed';
};
const STATUS = (windowMs) => {
  const p = window.__probe; const now = performance.now();
  const types = {}; for (const f of p.frames) types[f[1]] = (types[f[1]] || 0) + 1;
  const recent = p.frames.filter((f) => f[1] === 'agent:produce' && f[0] > now - windowMs);
  const chars = recent.reduce((s, f) => s + f[3], 0);
  const host = p.host.at(-1);
  const tick = [...p.frames].reverse().find((f) => f[1] === 'agent:tick');
  return {
    frames: p.frames.length, produce: types['agent:produce'] || 0,
    producePerS: +(recent.length / (windowMs / 1000)).toFixed(1), charsPerS: +(chars / (windowMs / 1000)).toFixed(0),
    complete: types['complete'] || 0, synth: types['synthesize:start'] || 0, research: types['research:start'] || 0, failed: types['agent:failed'] || 0,
    hostCpu: host ? host[1] : null, hostRssMb: host ? host[2] : null, sysMemUsedMb: host ? host[3] : null,
    kv: tick ? tick[4] : null, heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    longTasks: p.longTasks.length, worstLongTask: Math.round(Math.max(0, ...p.longTasks.map((l) => l[1]))), frameGaps: p.frameGaps.length,
  };
};
const GUARD = { minFreePct: 10, maxSwapGrowthMb: 2500 };
(async () => {
  const summary = { tabs: [], runs: [], guard: GUARD, start: machine() };
  log('start', JSON.stringify(summary.start));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const pages = [];
  for (let i = 0; i < TABS; i++) {
    const m = machine();
    if (m.freePct < GUARD.minFreePct || m.swapMb - summary.start.swapMb > GUARD.maxSwapGrowthMb) { log(`guard stops the ramp before tab ${i}:`, JSON.stringify(m)); break; }
    setPhase(`idle-${i + 1}`);
    const t0 = Date.now();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log(`tab${i} pageerror`, e.message));
    await page.goto(url);
    await page.waitForSelector('input[placeholder^="Ask a question"]', { timeout: 600000 });
    await page.click('button:has-text("Survey")');
    const probe = await page.evaluate(PROBE);
    await page.waitForTimeout(6000);   // two host samples at idle
    const after = machine();
    const s = await page.evaluate(STATUS, 10000);
    const row = { tab: i, readyMs: Date.now() - t0, probe, before: m, after, hostRssMb: s.hostRssMb, heapMb: s.heapMb };
    summary.tabs.push(row);
    log(`tab${i} resident`, JSON.stringify(row));
    pages.push(page);
  }
  const K = Math.min(WORKERS, pages.length);
  setPhase(`work-${K}`);
  const runStart = Date.now();
  await Promise.all(pages.slice(0, K).map(async (page, i) => {
    await page.fill('input[placeholder^="Ask a question"]', QUERIES[i % QUERIES.length]);
    await page.click('button.cmp-send');
  }));
  log(`${K} briefs submitted together; ${pages.length - K} idle tabs resident`);
  const done = new Array(K).fill(null);
  const series = Array.from({ length: K }, () => []);
  let aborted = null;
  while (Date.now() - runStart < 40 * 60 * 1000 && done.some((d) => d === null)) {
    await new Promise((r) => setTimeout(r, 10000));
    const m = machine();
    if (m.freePct < GUARD.minFreePct - 3 || m.swapMb - summary.start.swapMb > GUARD.maxSwapGrowthMb) { aborted = m; log('guard aborts the run:', JSON.stringify(m)); break; }
    for (let i = 0; i < K; i++) {
      if (done[i] !== null) continue;
      const s = await pages[i].evaluate(STATUS, 10000);
      series[i].push({ t: Date.now() - runStart, ...s });
      log(`tab${i}`, JSON.stringify(s), 'machine', JSON.stringify(m));
      if (s.complete > 0) done[i] = Date.now() - runStart;
    }
  }
  for (let i = 0; i < pages.length; i++) {
    const data = await pages[i].evaluate(() => window.__probe);
    fs.writeFileSync(path.join(outdir, `tab${i}-probe.json`), JSON.stringify(data));
  }
  summary.runs.push({ workers: K, residentTabs: pages.length, wallMs: done, aborted, series });
  summary.end = machine();
  fs.writeFileSync(path.join(outdir, 'summary.json'), JSON.stringify(summary, null, 1));
  setPhase('done');
  log('end', JSON.stringify(summary.end), 'wallMs', JSON.stringify(done));
  await browser.close();
  process.exitCode = aborted ? 2 : done.every((d) => d !== null) ? 0 : 1;
})().catch((e) => { log('FAILED', e.message); process.exit(1); });
