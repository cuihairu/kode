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
// Wireshark 插件 zip 面(2026-11-28 审计 MED:校验器此前只认 vsix,插件腿
// 绿但打包零产物时静默放过)。zip 为条件资产(插件腿红=如实缺位,release
// 说明注明),故不无条件要求:目录存在即须**恰好**两平台 zip 齐且名对;
// 远端对拍模式下逐 zip 核 size/digest 与 release 资产一致。
const expectedZips = ['wireshark-kbengine-plugin-linux-x64.zip', 'wireshark-kbengine-plugin-windows-x64.zip'].sort();
const pluginZipDir = path.join(directory, 'plugin-zip');
if (fs.existsSync(pluginZipDir)) {
  const zips = fs.readdirSync(pluginZipDir).filter(name => name.endsWith('.zip')).sort();
  if (JSON.stringify(zips) !== JSON.stringify(expectedZips)) {
    throw new Error(`Incomplete plugin zip set: expected ${expectedZips.join(', ')}, got ${zips.join(', ') || '(none)'}`);
  }
  if (remoteAssetsFile) {
    const remote = JSON.parse(fs.readFileSync(remoteAssetsFile, 'utf8')).assets;
    for (const name of expectedZips) {
      const asset = remote.find(item => item.name === name);
      const bytes = fs.readFileSync(path.join(pluginZipDir, name));
      if (!asset || asset.size !== bytes.length
          || (asset.digest && asset.digest !== `sha256:${sha256(bytes)}`)) {
        throw new Error(`Missing or mismatched nightly asset: ${name}`);
      }
    }
  }
}
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
