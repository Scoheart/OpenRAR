import { nativeCall, shutdownBroker } from './transport.mjs';
import { readRecording, createWorkflow } from './workflows.mjs';
import { readFile } from 'node:fs/promises';
const [command = 'doctor', argument] = process.argv.slice(2);
try {
  let value;
  if (command === 'doctor') value = await nativeCall('permissions');
  else if (['status', 'stop', 'cancel', 'quit'].includes(command)) value = await nativeCall(command);
  else if (command === 'start') value = await nativeCall('start', argument ? JSON.parse(argument) : {}, 125000);
  else if (command === 'read') value = await readRecording({ sessionId: argument });
  else if (command === 'create') value = await createWorkflow(JSON.parse(await readFile(argument, 'utf8')));
  else if (command === 'shutdown-broker') value = await shutdownBroker();
  else throw new Error('Commands: doctor, status, start [JSON], stop, cancel, read SESSION_ID, create INPUT_JSON, quit');
  console.log(JSON.stringify(value, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
