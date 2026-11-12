// Check that the downloaded npm tarball set is complete: every platform package
// from scripts/platform-vsix.mjs plus the launcher, and nothing else.
//
// Usage: node scripts/verify-npm-set.mjs dist/npm
import fs from 'node:fs';
import path from 'node:path';
import { targets } from './platform-vsix.mjs';

const scope = '@cuihairu';
const directory = process.argv[2] ?? 'dist/npm';

if (!fs.existsSync(directory)) {
  console.error(`missing ${directory}`);
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
const tarball = name => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
const present = new Set(fs.readdirSync(directory).filter(name => name.endsWith('.tgz')));

const expected = [
  ...Object.keys(targets).map(target => tarball(`${scope}/mcp-${target}`)),
  tarball(`${scope}/kode-mcp`)
];

const problems = [];
for (const wanted of expected) {
  if (!present.has(wanted)) problems.push(`missing ${wanted}`);
}
for (const found of present) {
  if (!expected.includes(found)) problems.push(`unexpected ${found}`);
}
const empty = expected.filter(name => present.has(name) && fs.statSync(path.join(directory, name)).size === 0);
for (const name of empty) problems.push(`empty tarball ${name}`);

if (problems.length > 0) {
  console.error(`npm package set is incomplete:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

console.log(`${present.size} npm tarballs verified (${expected.length - 1} platform + launcher) at ${version}`);
