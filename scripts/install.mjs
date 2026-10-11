import { readFile, mkdir, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { project, dataRoot, skillRoots } from '../src/paths.mjs';
import { linkSkill } from '../src/workflows.mjs';

export async function installClients({ home = os.homedir(), root = dataRoot, node = process.execPath } = {}) {
  const skill = path.join(project, 'skills/record-workflow');
  const destinations = Object.values(skillRoots(home)).map(p => path.join(p, 'record-workflow'));
  const cliSource = path.join(project, 'bin/qodercli');
  const cliDestination = path.join(home, '.local/bin/qodercli');
  let installCli = true;
  try { await lstat(cliDestination); installCli = await realpath(cliDestination) === await realpath(cliSource); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const target of destinations) {
    try { await lstat(target); if (await realpath(target) !== await realpath(skill)) throw new Error(`Refusing to replace an unmanaged Skill: ${target}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const base = { command: node, args: [path.join(project, 'src/mcp.mjs')] };
  const entries = [
    { file: path.join(home, '.pi/agent/mcp.json'), entry: { ...base, exposure: 'direct', timeout: 130, description: 'Record Mac demonstrations and generate reusable workflow Skills.' } },
    { file: path.join(home, '.qoder/settings.json'), entry: base },
    { file: path.join(home, '.qoder/mcp.json'), entry: base },
  ];
  const changes = [];
  for (const { file, entry } of entries) {
    let existing = '{}\n';
    try { existing = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const config = JSON.parse(existing);
    const previous = config.mcpServers?.['record-replay'];
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry) && previous.args?.[0] !== base.args[0]) throw new Error(`Unmanaged record-replay server already configured: ${file}`);
    const updated = { ...config, mcpServers: { ...config.mcpServers, 'record-replay': { ...entry, ...previous, command: entry.command, args: entry.args } } };
    if (JSON.stringify(updated) !== JSON.stringify(config)) changes.push({ file, contents: JSON.stringify(updated, null, 2) + '\n', existing });
  }
  const backupRoot = path.join(root, 'backups', `install-${new Date().toISOString().replaceAll(':', '-')}`);
  if (changes.length) await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  for (const { file, contents, existing } of changes) {
    const relative = path.relative(home, file).replaceAll('/', '_');
    await writeFile(path.join(backupRoot, relative), existing, { mode: 0o600 });
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.record-replay-${process.pid}`;
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, file);
  }
  for (const destination of destinations) await linkSkill(skill, destination);
  if (installCli) await linkSkill(cliSource, cliDestination);
  return { configurations: entries.map(x => x.file), skillLinks: destinations, cliLauncher: installCli ? cliDestination : 'Existing qodercli preserved', changed: changes.length, backupDirectory: changes.length ? backupRoot : null };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await installClients(), null, 2));
}
