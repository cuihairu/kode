import { createRequire } from 'node:module';
import { assertRuntimeAssets } from './vsix-assets.mjs';
const require = createRequire(import.meta.url);
const yauzl = createRequire(require.resolve('@vscode/vsce'))('yauzl');
const seen = new Map();
const allEntries = new Set();
await new Promise((resolve, reject) => {
  yauzl.open(process.argv[2], { lazyEntries: true }, (error, zip) => {
    if (error) { reject(error); return; }
    const fail = reason => { zip.close(); reject(reason); };
    zip.on('error', fail);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      allEntries.add(entry.fileName);
      if (/^extension\/(bin|target|crates|plugins)\//.test(entry.fileName)
          || /\.(exe|dll|so|dylib|node)$/i.test(entry.fileName)) {
        fail(new Error(`Native content in pure TS edition: ${entry.fileName}`)); return;
      }
      if (['extension/package.json', 'extension.vsixmanifest'].includes(entry.fileName)) {
        if (seen.has(entry.fileName) || entry.uncompressedSize > 4 * 1024 * 1024) {
          fail(new Error(`Invalid entry ${entry.fileName}`)); return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { fail(streamError); return; }
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', data => chunks.push(data));
          stream.on('end', () => { seen.set(entry.fileName, Buffer.concat(chunks).toString()); zip.readEntry(); });
        });
      } else {
        if (/^extension\/out\/(extension|pythonParserWorker|defParserWorker)\.js$/.test(entry.fileName)) {
          seen.set(entry.fileName, true);
        }
        zip.readEntry();
      }
    });
    zip.readEntry();
  });
});
const pkg = JSON.parse(seen.get('extension/package.json') ?? 'null');
assertRuntimeAssets(pkg, allEntries);
if (pkg?.contributes?.configuration?.properties?.['kbengine.core.backend']?.default !== 'ts'
    || !seen.has('extension/out/extension.js')
    || !seen.has('extension/out/pythonParserWorker.js')
    || !seen.has('extension/out/defParserWorker.js')
    || !seen.has('extension.vsixmanifest')
    || /TargetPlatform=/.test(seen.get('extension.vsixmanifest'))) {
  throw new Error('Pure TS edition must contain the extension bundle and default to TS on all platforms');
}
console.log('Verified universal pure TS VSIX (no native binaries, backend=ts)');
