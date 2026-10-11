import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dataRoot, endpointPath, appPath } from './paths.mjs';
const token = randomBytes(32).toString('hex');
const instance = randomUUID();
const queue = [];
const pending = new Map();
let polling;
let lastPoll = 0;
let launch;
let lastRecordingStatus;
function json(res, status, value) { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); } }
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Request exceeds 1 MiB');
  }
  return JSON.parse(text);
}
function dispatch() {
  if (polling && queue.length) {
    const response = polling;
    polling = null;
    json(response, 200, queue.shift());
  }
}
async function launchApp() {
  if (launch) return launch;
  launch = (async () => {
    await access(appPath);
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/open', ['-g', '-a', appPath, '--args', '--endpoint-file', endpointPath], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Native recorder launch failed (${code})`)));
    });
  })().finally(() => { launch = null; });
  return launch;
}
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'Unauthenticated local request' });
  try {
    if (req.url === '/health') return json(res, 200, { instance, nativeConnected: Date.now() - lastPoll < 30000 });
    if (req.url === '/shutdown' && req.method === 'POST') {
      if (lastRecordingStatus !== false || pending.size) throw new Error('Verify the recorder is idle and has no pending operations before shutting down the broker');
      json(res, 200, { shuttingDown: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    if (req.url?.startsWith('/request-live?') && req.method === 'GET') {
      const id = new URL(req.url, 'http://localhost').searchParams.get('id');
      return json(res, 200, { alive: pending.has(id) });
    }
    if (req.url === '/command' && req.method === 'GET') {
      lastPoll = Date.now();
      if (polling) json(polling, 200, { method: 'idle' });
      polling = res;
      const timer = setTimeout(() => { if (polling === res) { polling = null; json(res, 200, { method: 'idle' }); } }, 20000);
      res.on('close', () => { clearTimeout(timer); if (polling === res) polling = null; });
      return dispatch();
    }
    if (req.url === '/reply' && req.method === 'POST') {
      const result = await body(req);
      const request = pending.get(result.id);
      if (request) {
        pending.delete(result.id);
        clearTimeout(request.timer);
        if (typeof result.result?.isRecording === 'boolean') lastRecordingStatus = result.result.isRecording;
        json(request.res, result.error ? 422 : 200, result.error ? { error: result.error } : result.result);
      }
      return json(res, 200, { accepted: true });
    }
    if (req.url === '/api' && req.method === 'POST') {
      const command = await body(req);
      if (!['status', 'permissions', 'start', 'stop', 'cancel', 'quit'].includes(command.method)) throw new Error('Unknown recording operation');
      await launchApp();
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        const index = queue.findIndex(x => x.id === id);
        if (index >= 0) queue.splice(index, 1);
        json(res, 504, { error: 'Native recorder did not reply; check its confirmation dialog or restart the idle helper.' });
      }, command.method === 'start' ? 120000 : 12000);
      pending.set(id, { res, timer });
      res.on('close', () => {
        pending.delete(id);
        clearTimeout(timer);
        const index = queue.findIndex(x => x.id === id);
        if (index >= 0) queue.splice(index, 1);
      });
      queue.push({ ...command, id, expiresAt: Date.now() + (command.method === 'start' ? 120000 : 12000) });
      return dispatch();
    }
    json(res, 404, { error: 'Unknown endpoint' });
  } catch (error) { json(res, 422, { error: error.message }); }
});
await mkdir(dataRoot, { recursive: true, mode: 0o700 });
server.listen(0, '127.0.0.1', async () => {
  const temporary = `${endpointPath}.${instance}`;
  await writeFile(temporary, JSON.stringify({ port: server.address().port, token, instance, pid: process.pid }), { mode: 0o600 });
  await rename(temporary, endpointPath);
});
