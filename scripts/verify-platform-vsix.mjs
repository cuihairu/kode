// Check the actual ZIP, then execute the extracted binaries on their native runner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { binaries, targets, sha256, smokeBinaries } from './platform-vsix.mjs';
import { assertRuntimeAssets } from './vsix-assets.mjs';

const [file, target] = process.argv.slice(2);
if (!targets[target]) { throw new Error(`Unknown platform ${target}`); }
const require = createRequire(import.meta.url);
// Resolve the ZIP reader already used and pinned by vsce.
const vsceRequire = createRequire(require.resolve('@vscode/vsce'));
const yauzl = vsceRequire('yauzl');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-vsix-'));
const entries = new Map();
const allEntries = new Set();
const modes = new Map();
try {
  await new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) { reject(error); return; }
      const fail = reason => { zip.close(); reject(reason); };
      zip.on('error', fail);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        const name = entry.fileName;
        allEntries.add(name);
        if (/^extension\/(target|crates|plugins)\//.test(name)) {
          fail(new Error(`Build/source directory leaked into VSIX: ${name}`)); return;
        }
        if (name.startsWith('extension/bin/') || name === 'extension.vsixmanifest' || name === 'extension/package.json'
            || name === 'extension/out/buildCommit.json') {
          if (entries.has(name) || entry.uncompressedSize > 256 * 1024 * 1024) {
            fail(new Error(`Duplicate or oversized entry: ${name}`)); return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) { fail(streamError); return; }
            const chunks = [];
            stream.on('error', fail);
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => {
              entries.set(name, Buffer.concat(chunks));
              modes.set(name, entry.externalFileAttributes >>> 16);
              zip.readEntry();
            });
          });
        } else { zip.readEntry(); }
      });
      zip.readEntry();
    });
  });
  const manifest = JSON.parse(entries.get('extension/bin/manifest.json')?.toString() ?? 'null');
  const pkg = JSON.parse(entries.get('extension/package.json')?.toString() ?? 'null');
  assertRuntimeAssets(pkg, allEntries);
  const build = JSON.parse(entries.get('extension/out/buildCommit.json')?.toString() ?? 'null');
  const xml = entries.get('extension.vsixmanifest')?.toString() ?? '';
  if (manifest?.target !== target || manifest?.rustTarget !== targets[target].rust
      || manifest?.version !== pkg?.version || !/^[a-f0-9]{40}$/.test(manifest?.commit ?? '')
      || manifest?.commit !== build?.commit
      || !xml.includes(`TargetPlatform="${target}"`)) {
    throw new Error('VSIX platform/version/build identity mismatch');
  }
  const names = binaries.map(binary => `${binary}${targets[target].os === 'win32' ? '.exe' : ''}`);
  const allowed = new Set(['extension/bin/manifest.json', ...names.map(name => `extension/bin/${name}`)]);
  for (const name of entries.keys()) {
    if (name.startsWith('extension/bin/') && !allowed.has(name)) { throw new Error(`Unexpected binary entry ${name}`); }
  }
  if (Object.keys(manifest.files).sort().join() !== [...names].sort().join()) { throw new Error('Unexpected binary manifest'); }
  for (const name of names) {
    const bytes = entries.get(`extension/bin/${name}`);
    if (!bytes?.length || sha256(bytes) !== manifest.files[name]) { throw new Error(`Missing/corrupt ${name}`); }
    if (targets[target].os !== 'win32' && !(modes.get(`extension/bin/${name}`) & 0o111)) {
      throw new Error(`Executable mode missing in VSIX: ${name}`);
    }
    const entry = path.join(directory, name);
    fs.writeFileSync(entry, bytes, { mode: 0o755 });
  }
  smokeBinaries(directory, target);
  console.log(`Verified platform VSIX: ${file}`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
