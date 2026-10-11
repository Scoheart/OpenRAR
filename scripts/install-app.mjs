import { lstat, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { builtAppPath, appPath, dataRoot } from '../src/paths.mjs';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout + result.stderr;
}
function identity(bundle) {
  run('/usr/bin/codesign', ['--verify', '--strict', bundle]);
  const details = run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle]);
  if (!details.includes('Identifier=com.scoheart.record-replay\n')) throw new Error(`Unexpected app identity: ${bundle}`);
  return details.match(/^CDHash=(\w+)$/m)?.[1] || (() => { throw new Error('Missing signed app hash'); })();
}
// The caller must stop and quit the recorder before replacing the installed app.
const processCheck = spawnSync('/usr/bin/pgrep', ['-f', '/Record Replay.app/Contents/MacOS/RecordReplay'], { encoding: 'utf8' });
if (processCheck.status === 0) throw new Error('Quit the idle recorder before installing the app.');
const sourceHash = identity(builtAppPath);
const manifest = path.join(dataRoot, 'installed-app.json');
let previous;
try { previous = JSON.parse(await readFile(manifest, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
let existing = false;
try {
  const stat = await lstat(appPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing to replace unmanaged app: ${appPath}`);
  const current = identity(appPath);
  if (current !== sourceHash && (previous?.path !== appPath || previous?.cdhash !== current)) throw new Error(`Refusing to replace unmanaged app: ${appPath}`);
  existing = true;
  if (current === sourceHash) { console.log(`Installed app unchanged: ${appPath}`); process.exit(0); }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(dataRoot, { recursive: true, mode: 0o700 });
const stage = `/Applications/.Record Replay-${process.pid}.app`;
let backup;
try {
  run('/usr/bin/ditto', [builtAppPath, stage]);
  if (identity(stage) !== sourceHash) throw new Error('Copied app signature does not match build');
  if (existing) {
    const backupDirectory = path.join(dataRoot, 'backups', `app-${Date.now()}`);
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    backup = path.join(backupDirectory, 'Record Replay.app');
    await rename(appPath, backup);
  }
  await rename(stage, appPath);
  await writeFile(manifest, JSON.stringify({ path: appPath, cdhash: sourceHash }, null, 2) + '\n', { mode: 0o600 });
  console.log(`Installed ${appPath}`);
} catch (error) {
  if (backup) { try { await lstat(appPath); } catch (missing) { if (missing.code === 'ENOENT') await rename(backup, appPath); } }
  throw error;
} finally { await rm(stage, { recursive: true, force: true }); }
