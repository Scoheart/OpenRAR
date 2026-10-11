import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const project = fileURLToPath(new URL('../', import.meta.url));
export const dataRoot = process.env.RECORD_REPLAY_HOME || path.join(os.homedir(), '.local/share/record-replay');
export const endpointPath = path.join(dataRoot, 'endpoint.json');
export const builtAppPath = path.join(project, 'runtime/Record Replay.app');
export const appPath = '/Applications/Record Replay.app';
export const skillRoots = (home = os.homedir()) => ({
  pi: path.join(home, '.pi/agent/skills'),
  qoder: path.join(home, '.qoder/skills'),
});
