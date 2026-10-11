import { readFile, mkdir, open, unlink, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { dataRoot, endpointPath } from './paths.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readEndpoint() {
  const endpoint = JSON.parse(await readFile(endpointPath, 'utf8'));
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token)) throw new Error('Invalid local recorder endpoint');
  return endpoint;
}
async function request(endpoint, route, body, timeout = 15000, signal) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  });
  const value = await response.json();
  if (!response.ok || value.error) throw new Error(value.error || `Recorder HTTP ${response.status}`);
  return value;
}
async function connected() {
  try {
    const endpoint = await readEndpoint();
    const health = await request(endpoint, '/health', undefined, 1000);
    return health.instance === endpoint.instance ? endpoint : null;
  } catch { return null; }
}
let starting;
export async function ensureDaemon() {
  const existing = await connected();
  if (existing) return existing;
  if (starting) return starting;
  starting = (async () => {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const lock = path.join(dataRoot, 'startup.lock');
    let handle;
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      for (let i = 0; i < 50; i++) {
        const ready = await connected();
        if (ready) return ready;
        await delay(100);
      }
      const owner = Number((await readFile(lock, 'utf8')).trim());
      let alive = true;
      try { process.kill(owner, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (!alive) { await unlink(lock); return ensureDaemonAfterStaleLock(); }
      throw new Error('Recorder startup is in progress or failed in a live process; retry after it exits.');
    }
    try {
      await handle.writeFile(String(process.pid));
      const daemonFile = new URL('./daemon.mjs', import.meta.url);
      await access(daemonFile);
      const child = spawn(process.execPath, [daemonFile.pathname], { detached: true, stdio: 'ignore', env: process.env });
      child.unref();
      for (let i = 0; i < 100; i++) {
        const ready = await connected();
        if (ready) return ready;
        await delay(100);
      }
      throw new Error('Recorder service did not start within 10 seconds');
    } finally { await handle.close(); await unlink(lock).catch(() => {}); }
  })().finally(() => { starting = null; });
  return starting;
}
async function ensureDaemonAfterStaleLock() {
  starting = null;
  return ensureDaemon();
}
export async function nativeCall(method, args = {}, timeout = 15000, signal) {
  return request(await ensureDaemon(), '/api', { method, args }, timeout, signal);
}
export async function shutdownBroker() {
  const endpoint = await ensureDaemon();
  return request(endpoint, '/shutdown', {});
}
