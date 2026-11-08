import fs from 'node:fs';
import path from 'node:path';
import { targets, sha256 } from './platform-vsix.mjs';

const [directory, remoteAssetsFile] = process.argv.slice(2);
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const expected = [...Object.keys(targets), 'pure-ts'].map(target => `kode-${version}-${target}.vsix`).sort();
const actual = fs.readdirSync(directory).filter(name => name.endsWith('.vsix')).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`Incomplete platform set: expected ${expected.join(', ')}, got ${actual.join(', ')}`);
}
const sums = expected.map(name => `${sha256(fs.readFileSync(path.join(directory, name)))}  ${name}`).join('\n') + '\n';
if (remoteAssetsFile) {
  const remote = JSON.parse(fs.readFileSync(remoteAssetsFile, 'utf8')).assets;
  for (const name of [...expected, 'SHA256SUMS']) {
    const asset = remote.find(item => item.name === name);
    const bytes = fs.readFileSync(path.join(directory, name));
    if (!asset || asset.size !== bytes.length
        || (asset.digest && asset.digest !== `sha256:${sha256(bytes)}`)) {
      throw new Error(`Missing or mismatched nightly asset: ${name}`);
    }
  }
} else {
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), sums);
}
console.log('Complete six-platform plus pure TS package set verified');
