import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearDatabaseSchemaCacheForTests,
  getDatabaseSchemaSnapshot
} from '../src/databaseSchema';

// 2026-10-28 审核整改(SCH-002):databaseSchema 的 normalizePath 一律
// toLowerCase,POSIX 上 /X/Proj 与 /X/proj 是两个不同根却共用同一缓存键
// (键 = normalizePath(root) + 实体名)→ 先构建的根快照喂给后构建的根,
// 同名实体跨根串缓存。POSIX 大小写必须保留(项目标准=pathIdentity:
// Windows 盘符/UNC 折叠,POSIX 不折叠)。

const temporaryDirectories: string[] = [];

afterEach(() => {
  clearDatabaseSchemaCacheForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

const heroDef = (properties: string[]): string => [
  '<root>',
  '  <Properties>',
  ...properties.map(name => [
    `    <${name}>`,
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    `    </${name}>`
  ].join('\n')),
  '  </Properties>',
  '</root>'
].join('\n');

const makeRoot = (base: string, dirName: string, defProperties: string[]): string => {
  const root = path.join(base, dirName);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'),
    '<root>\n  <Hero/>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'),
    '<root>\n  <ITEM_ID> UINT16 </ITEM_ID>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Hero.def'), heroDef(defProperties), 'utf8');
  return root;
};

const fieldNames = (root: string): string[] =>
  getDatabaseSchemaSnapshot('Hero', root)!.tables[0].fields.map(field => field.name);

describe('2026-10-28 审核整改:SCH-002 缓存根键保留 POSIX 大小写', () => {
  it('仅大小写不同的两个根各自缓存,同名实体不跨根串缓存', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch002-'));
    temporaryDirectories.push(base);
    // 同一父目录下仅大小写不同的两个根(POSIX 上是两个真实目录)
    const rootUpper = makeRoot(base, 'Proj', ['hp']);
    const rootLower = makeRoot(base, 'proj', ['hp', 'mana']);

    // 各自构建:upper 只有 hp,lower 有 hp+mana
    expect(fieldNames(rootUpper)).not.toContain('sm_mana');
    expect(fieldNames(rootLower)).toContain('sm_mana');

    // 再查一遍(应命中各自缓存):先建的根不得把快照喂给后建的根
    expect(fieldNames(rootUpper)).not.toContain('sm_mana');
    expect(fieldNames(rootLower)).toContain('sm_mana');
  });
});
