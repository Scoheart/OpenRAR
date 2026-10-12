import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { builtAppPath as appPath, project } from '../src/paths.mjs';
const source = path.join(project, 'native/Recorder.swift');
const hash = createHash('sha256').update(await readFile(source)).update(await readFile(new URL(import.meta.url))).digest('hex');
const stamp = path.join(project, 'runtime/build-sha256');
let previous;
try { previous = (await readFile(stamp, 'utf8')).trim(); } catch {}
let exists = false;
try { await access(path.join(appPath, 'Contents/MacOS/RecordReplay')); exists = true; } catch {}
if (previous === hash && exists && !process.argv.includes('--force')) { console.log('Native recorder unchanged; preserving its signed identity.'); process.exit(0); }
await mkdir(path.join(appPath, 'Contents/MacOS'), { recursive: true });
const executable = path.join(appPath, 'Contents/MacOS/RecordReplay');
const target = `${os.arch() === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`;
const result = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-target', target, '-O', source, '-o', executable, '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
await writeFile(path.join(appPath, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.scoheart.record-replay</string>
<key>CFBundleExecutable</key><string>RecordReplay</string>
<key>CFBundleName</key><string>OpenRAR</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>\n`);
const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.scoheart.record-replay', appPath], { stdio: 'inherit' });
if (signed.status !== 0) process.exit(signed.status || 1);
await writeFile(stamp, hash + '\n');
console.log(`Built ${appPath}`);
