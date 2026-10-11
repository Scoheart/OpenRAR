import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { project } from '../src/paths.mjs';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
test('the actual stdio server advertises all recording and Skill generation tools', async () => {
  const client = new Client({ name: 'record-replay-protocol-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${project}/src/mcp.mjs`], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['recording_cancel', 'recording_permissions', 'recording_read', 'recording_start', 'recording_status', 'recording_stop', 'workflow_create_skill']);
    const result = await client.callTool({ name: 'recording_read', arguments: { sessionId: '../../secret' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid session/);
  } finally { await client.close(); }
});
test('actual MCP event reading and Skill generation work together in isolated client homes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'record-replay-mcp-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const directory = path.join(root, 'sessions', sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'session.json'), JSON.stringify({sessionId, eventCount:1, endedAt:'2026-10-12T00:00:00Z', endReason:'stopped', producer:'synthetic-fixture'}));
  await writeFile(path.join(directory, 'events.jsonl'), JSON.stringify({id:1,kind:'synthetic_fixture',selection:{selectedText:'example folder'}})+'\n');
  const client = new Client({name:'record-replay-workflow-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[`${project}/src/mcp.mjs`],stderr:'pipe',env:{...process.env,RECORD_REPLAY_HOME:root,RECORD_REPLAY_CLIENT_HOME:path.join(root,'client-home')}}));
  try {
    const read = await client.callTool({name:'recording_read',arguments:{sessionId}});
    assert.notEqual(read.isError,true);
    assert.equal(JSON.parse(read.content[0].text).events[0].id,1);
    const created = await client.callTool({name:'workflow_create_skill',arguments:{sessionId,name:'fixture-folder',description:'Create a supplied example folder',instructions:'## Inputs\nFolder name.\n\n## Steps\nObserve the destination, create the supplied folder, and verify its name.'}});
    assert.notEqual(created.isError,true);
    const result=JSON.parse(created.content[0].text);
    assert.equal(result.installedAt.length,2);
    for(const link of result.installedAt)assert.equal(await realpath(link),await realpath(path.dirname(result.path)));
    assert.match(await readFile(result.path,'utf8'),/name: fixture-folder/);
  } finally {await client.close();}
});
