import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KBEngineDatabaseSchemaProvider,
  createDatabaseSchemaUri
} from '../src/databaseSchemaPresentation';
import { workspaceEvents } from './fake-vscode/workspaceState';

// IDE-AUD-056 验收:关闭 schema 文档释放该 URI 的已发布代(第二层强引用
// 缓存不无界持有)。R3-F02 复现:顺次提供 46 个实体视图,底层 schema LRU
// 只有 32,展示面仍持有 46 个快照/行数组。验收=关闭事件删除对应
// publishedRenders;连续打开关闭超 32 个实体后关闭文档不保留快照,
// 仍打开文档保持同代定位。

let rootA = '';

beforeAll(() => {
  rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-schema-close-'));
  fs.mkdirSync(path.join(rootA, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(
    path.join(rootA, 'scripts', 'entities.xml'),
    '<root>\n  <Hero hasBase="true"/>\n</root>\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(rootA, 'scripts', 'entity_defs', 'Hero.def'),
    [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '      <Persistent>true</Persistent>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'),
    'utf8'
  );
});

afterAll(() => {
  fs.rmSync(rootA, { recursive: true, force: true });
});

describe('IDE-AUD-056 关闭文档释放已发布快照', () => {
  it('顺次提供 46 个实体视图后关闭 45 个,只余仍打开 1 个(不无界持有)', () => {
    const provider = new KBEngineDatabaseSchemaProvider();
    const uris = Array.from({ length: 46 }, (_, index) => createDatabaseSchemaUri(`E${index}`));

    for (const uri of uris) {
      provider.provideTextDocumentContent(uri);
    }
    // 46 个都持有(泄漏复现面),尽管底层 schema LRU 只有 32
    for (const uri of uris) {
      expect(provider.getPublishedSnapshot(uri)).toBeDefined();
    }

    // 关闭 45 个:各自释放,仍打开的最后一个保持
    for (const uri of uris.slice(0, 45)) {
      provider.closeDocument(uri);
      expect(provider.getPublishedSnapshot(uri)).toBeUndefined();
    }
    expect(provider.getPublishedSnapshot(uris[45])).toBeDefined();
    provider.dispose();
  });

  it('仍打开文档保持同代定位,关闭后定位退回独立快照口径', () => {
    const provider = new KBEngineDatabaseSchemaProvider();
    const uri = createDatabaseSchemaUri('Hero', rootA);
    provider.provideTextDocumentContent(uri);

    const openLine = provider.locateInPublishedContent(uri, 'tbl_Hero', 'sm_hp');
    expect(openLine).not.toBeNull();

    provider.closeDocument(uri);
    expect(provider.getPublishedSnapshot(uri)).toBeUndefined();
    // 已发布代删除后,同代定位落空(调用侧退独立快照口径)
    expect(provider.locateInPublishedContent(uri, 'tbl_Hero', 'sm_hp')).toBeNull();
    provider.dispose();
  });

  it('真实关闭事件经 workspace.onDidCloseTextDocument 触发释放', () => {
    const provider = new KBEngineDatabaseSchemaProvider();
    const uri = createDatabaseSchemaUri('Hero', rootA);
    provider.provideTextDocumentContent(uri);
    expect(provider.getPublishedSnapshot(uri)).toBeDefined();

    // onDidCloseTextDocument 直接以 TextDocument 分发(非 {document} 包装)
    workspaceEvents.documentClosed.fire({ uri } as never);
    expect(provider.getPublishedSnapshot(uri)).toBeUndefined();
    provider.dispose();
  });
});
