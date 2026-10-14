// Machine-side sampler: every 2 s, one CSV row of the served host's RSS and CPU, the headless Chrome
// renderers' total RSS, system free memory, swap used, and a phase marker read from a file the driver writes.
// Usage: node sampler.cjs <out.csv> <phase-file> [servePidFile]
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const [out, phaseFile, pidFile] = process.argv.slice(2);
const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }); } catch { return ''; } };
fs.writeFileSync(out, 't,phase,serve_pid,serve_rss_mb,serve_cpu,chrome_headless_rss_mb,chrome_all_rss_mb,free_pct,swap_used_mb\n');
const findServe = () => {
  if (pidFile && fs.existsSync(pidFile)) return fs.readFileSync(pidFile, 'utf8').trim();
  const line = sh("ps -eo pid=,rss=,args= | awk '/node bin\\/serve.js/ && !/sh -c/ {print $2, $1}' | sort -rn | head -1 | awk '{print $2}' ").trim();
  return line;
};
setInterval(() => {
  const phase = fs.existsSync(phaseFile) ? fs.readFileSync(phaseFile, 'utf8').trim() : '';
  const pid = findServe();
  const ps = pid ? sh(`ps -o rss=,%cpu= -p ${pid}`).trim().split(/\s+/) : [];
  const rss = ps[0] ? (Number(ps[0]) / 1024).toFixed(0) : '';
  const cpu = ps[1] ?? '';
  // Headless Chrome launched by playwright carries --headless; the owner's own Chrome does not.
  const headless = sh("ps -eo rss=,args= | awk '/--headless/ && /Chrome|chrome/ {s+=$1} END {print s/1024}'").trim();
  const all = sh("ps -eo rss=,comm= | awk '/Chrome/ {s+=$1} END {print s/1024}'").trim();
  const free = sh('memory_pressure -Q').match(/free percentage: (\d+)%/)?.[1] ?? '';
  const swap = sh('sysctl -n vm.swapusage').match(/used = ([\d.]+)M/)?.[1] ?? '';
  fs.appendFileSync(out, `${new Date().toISOString()},${phase},${pid},${rss},${cpu},${Number(headless).toFixed(0)},${Number(all).toFixed(0)},${free},${swap}\n`);
}, 2000);
