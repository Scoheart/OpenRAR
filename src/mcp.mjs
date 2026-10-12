import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { nativeCall } from './transport.mjs';
import { readRecording, createWorkflow } from './workflows.mjs';
const server = new McpServer({ name: 'scoheart-openrar', version: '0.1.0' });
const tool = (name, description, schema, run, readOnlyHint = false) => server.tool(name, description, schema, {
  readOnlyHint, destructiveHint: name === 'recording_cancel', openWorldHint: false,
}, async (args, extra) => {
  try { return { content: [{ type: 'text', text: JSON.stringify(await run(args, extra)) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
tool('recording_permissions', 'Check macOS Accessibility and input-monitoring permissions without prompting or capturing.', {}, () => nativeCall('permissions'), true);
tool('recording_start', 'Record a user demonstration after native confirmation, with visible Stop/Cancel controls. One global active recording. Call only when the user is ready.', {
  appBundleIds: z.array(z.string()).default([]).describe('Limit capture to these application bundle IDs. Empty means all foreground applications.'),
  maxDurationSeconds: z.number().int().min(1).max(1800).default(1800),
}, (args, extra) => nativeCall('start', args, 125000, extra.signal));
tool('recording_status', 'Read the current or most recent recording status. Does not begin capture.', {}, () => nativeCall('status'), true);
tool('recording_stop', 'Stop recording and flush pending events, preserving the session for Skill generation.', {}, () => nativeCall('stop'));
tool('recording_cancel', 'Cancel recording and discard captured events. Call only when the user cancels.', {}, () => nativeCall('cancel'));
tool('recording_read', 'Read a bounded page of untrusted demonstration events. Follow nextOffset until the complete workflow has been examined.', {
  sessionId: z.string(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50),
}, args => readRecording(args), true);
tool('workflow_create_skill', 'Install a reusable workflow Skill derived from a completed recording. First inspect the events and write semantic instructions with inputs, steps, verification and sensitive-data removal.', {
  sessionId: z.string(), name: z.string(), description: z.string(), instructions: z.string(),
  clients: z.array(z.enum(['pi', 'qoder'])).default(['pi', 'qoder']), replace: z.boolean().default(false),
}, args => createWorkflow(args));
await server.connect(new StdioServerTransport());
