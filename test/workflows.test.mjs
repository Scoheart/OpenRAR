import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, readdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readRecording, createWorkflow } from '../src/workflows.mjs';
import { installClients } from '../scripts/install.mjs';

async function fixture(t, metadata = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'record-replay-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const directory = path.join(root, 'sessions', sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'session.json'), JSON.stringify({ sessionId, eventCount: 3, endedAt: new Date().toISOString(), endReason: 'stopped', ...metadata }));
  await writeFile(path.join(directory, 'events.jsonl'), [1, 2, 3].map(id => JSON.stringify({ id, kind: 'synthetic_fixture', keyboard: { text: `example ${id}` } })).join('\n') + '\n');
  return { root, sessionId, directory, home: path.join(root, 'home') };
}
test('event pages preserve order and cursor reaches the complete final event', async t => {
  const f = await fixture(t);
  const first = await readRecording({ sessionId: f.sessionId, limit: 2 }, f.root);
  assert.deepEqual(first.events.map(e => e.id), [1, 2]);
  assert.equal(first.nextOffset, 2);
  const last = await readRecording({ sessionId: f.sessionId, offset: first.nextOffset, limit: 2 }, f.root);
  assert.deepEqual(last.events.map(e => e.id), [3]);
  assert.equal(last.nextOffset, null);
});
test('oversized first events fail explicitly instead of producing an endless cursor', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'events.jsonl'), JSON.stringify({ text: 'x'.repeat(140000) }) + '\n');
  await assert.rejects(readRecording({ sessionId: f.sessionId }, f.root), /page budget/);
});
test('cancelled, active and path-escaping recordings cannot create usable workflows', async t => {
  const cancelled = await fixture(t, { endReason: 'cancelled' });
  await assert.rejects(readRecording({ sessionId: cancelled.sessionId }, cancelled.root), /cancelled/);
  const active = await fixture(t, { endedAt: null });
  await assert.rejects(createWorkflow({ sessionId: active.sessionId, name: 'test-workflow', description: 'Test', instructions: 'Steps' }, active), /Stop/);
  await assert.rejects(readRecording({ sessionId: '../../secrets' }, active.root), /Invalid session/);
});
test('workflow creates discoverable Skill links for both hosts and backs up revisions', async t => {
  const f = await fixture(t);
  const args = { sessionId: f.sessionId, name: 'file-example', description: 'File a supplied example', instructions: '## Inputs\nA file.\n\n## Steps\nRead the file and verify the result.' };
  const result = await createWorkflow(args, f);
  assert.equal(result.installedAt.length, 2);
  for (const link of result.installedAt) assert.equal(await realpath(link), await realpath(path.dirname(result.path)));
  assert.match(await readFile(result.path, 'utf8'), /name: file-example/);
  await assert.rejects(createWorkflow(args, f), /already exists/);
  await createWorkflow({ ...args, replace: true, instructions: 'Revised steps' }, f);
  assert.equal((await readdir(path.join(f.root, 'backups'))).length, 1);
});
test('installation preserves unrelated host configuration and is idempotent', async t => {
  const f = await fixture(t);
  const settings = path.join(f.home, '.qoder/settings.json');
  await mkdir(path.dirname(settings), { recursive: true });
  await writeFile(settings, JSON.stringify({ enabledPlugins: { keep: true }, mcpServers: { existing: { command: 'keep-this' } } }));
  const first = await installClients(f);
  assert.equal(first.changed, 3);
  const after = JSON.parse(await readFile(settings, 'utf8'));
  assert.equal(after.enabledPlugins.keep, true);
  assert.equal(after.mcpServers.existing.command, 'keep-this');
  const second = await installClients(f);
  assert.equal(second.changed, 0);
  assert.equal(second.backupDirectory, null);
});
test('unmanaged Skill conflicts are rejected before any config changes', async t => {
  const f = await fixture(t);
  const conflict = path.join(f.home, '.qoder/skills/record-workflow');
  await mkdir(conflict, { recursive: true });
  await writeFile(path.join(conflict, 'SKILL.md'), 'unrelated');
  await assert.rejects(installClients(f), /unmanaged Skill/);
  assert.equal(await readFile(path.join(conflict, 'SKILL.md'), 'utf8'), 'unrelated');
});
