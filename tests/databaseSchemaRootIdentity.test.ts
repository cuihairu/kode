import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KBEngineDatabaseSchemaProvider,
  createDatabaseSchemaUri,
  parseDatabaseSchemaRoot
} from '../src/databaseSchemaPresentation';

// IDE-AUD-055 验收:schema 虚拟文档的根身份贯穿 URI query。
// A/B 两个工作区根各有一份同名 Hero.def(属性不同:A 只有 hp、B 只有 onlyB),
// 断言两根同名实体产出两份不同 URI、展示/刷新各按各根解析不串根,
// 快照解析走「键=根+实体」的既有下层语义(数据库Schema 层)。

const writeScripts = (root: string, propertyName: string): void => {
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'entities.xml'),
    '<root>\n  <Hero hasBase="true"/>\n</root>\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'scripts', 'entity_defs', 'Hero.def'),
    [
      '<root>',
      '  <Properties>',
      `    <${propertyName}>`,
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '      <Persistent>true</Persistent>',
      `    </${propertyName}>`,
      '  </Properties>',
      '</root>'
    ].join('\n'),
    'utf8'
  );
};

let rootA = '';
let rootB = '';

beforeAll(() => {
  rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-schema-root-a-'));
  rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-schema-root-b-'));
  writeScripts(rootA, 'hp');
  writeScripts(rootB, 'onlyB');
});

afterAll(() => {
  fs.rmSync(rootA, { recursive: true, force: true });
  fs.rmSync(rootB, { recursive: true, force: true });
});

describe('IDE-AUD-055 schema 根身份贯穿 URI', () => {
  it('同名实体两个根产出两份不同 URI,且区别于无根形态', () => {
    const uriA = createDatabaseSchemaUri('Hero', rootA);
    const uriB = createDatabaseSchemaUri('Hero', rootB);
    const uriPlain = createDatabaseSchemaUri('Hero');

    expect(uriA.toString()).not.toBe(uriB.toString());
    expect(uriA.toString()).not.toBe(uriPlain.toString());
    expect(uriB.toString()).not.toBe(uriPlain.toString());
  });

  it('parseDatabaseSchemaRoot 从 URI query 还原根身份并 round-trip', () => {
    expect(parseDatabaseSchemaRoot(createDatabaseSchemaUri('Hero', rootA))).toBe(rootA);
    expect(parseDatabaseSchemaRoot(createDatabaseSchemaUri('Hero', rootB))).toBe(rootB);
    expect(parseDatabaseSchemaRoot(createDatabaseSchemaUri('Hero'))).toBeNull();
  });

  it('提供文本按各自根解析快照:A/B 同名实体各取各属性不串根', () => {
    const provider = new KBEngineDatabaseSchemaProvider();
    const contentA = provider.provideTextDocumentContent(createDatabaseSchemaUri('Hero', rootA));
    const contentB = provider.provideTextDocumentContent(createDatabaseSchemaUri('Hero', rootB));

    expect(contentA).toContain('hp');
    expect(contentA).not.toContain('onlyB');
    expect(contentB).toContain('onlyB');
    expect(contentB).not.toContain('hp');
  });

  it('refresh 带根只刷该根的 URI,不误刷另一根同类文档', () => {
    const provider = new KBEngineDatabaseSchemaProvider();
    const fired: string[] = [];
    provider.onDidChange(uri => {
      fired.push(uri.toString());
    });

    provider.refresh('Hero', rootA);
    expect(fired).toEqual([createDatabaseSchemaUri('Hero', rootA).toString()]);

    fired.length = 0;
    provider.refresh('Hero', rootB);
    expect(fired).toEqual([createDatabaseSchemaUri('Hero', rootB).toString()]);
  });
});
