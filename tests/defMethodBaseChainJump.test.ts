// def→Python 跳转的**父类链**臂测试。
//
// 背景(2026-11-24 用户报「提了无数次」):def 方法在 py 实体类的父类里实现时,
// F12 跳不过去——既有臂(约定链只读属主文件 / 全项目唯一名在方法名多处出现时
// 静默)都不看真实继承。本文件锁「import 解析出的父类链」臂:方法名在项目里
// 不唯一(全项目唯一名臂必失败),只有父类链能给出落点。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineDefinitionProvider } from '../src/languageProviders';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import { patternGlob } from './helpers/findPattern';

const AVATAR_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <onBoom/>',
  '  </BaseMethods>',
  '</root>',
  ''
].join('\n');

/** 自身类不实现 onBoom;只经 import 声明继承共享父类 Monster */
const BASE_PY = [
  'import kbe',
  'from common.base_common import Monster',
  '',
  'class Avatar(Monster):',
  '    pass',
  ''
].join('\n');

/** 真实实现所在:scripts/common/base_common.py:1(0-based)→ 展示 2 */
const BASE_COMMON_PY = [
  'class Monster(object):',
  '    def onBoom(self, victimId):',
  '        pass',
  ''
].join('\n');

/** 干扰项:同名方法出现在另一个类里 → 全项目唯一名臂必须失败 */
const OTHER_PY = [
  'class Other(object):',
  '    def onBoom(self, victimId):',
  '        pass',
  ''
].join('\n');

interface Fixture {
  root: string;
  avatarDef: string;
  baseCommonPy: string;
}

const buildWorkspace = (): Fixture => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-basechain-jump-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  const avatarDef = put('a/scripts/entity_defs/Avatar.def', AVATAR_DEF);
  put('a/scripts/base/Avatar.py', BASE_PY);
  const baseCommonPy = put('a/scripts/common/base_common.py', BASE_COMMON_PY);
  put('a/scripts/base/Other.py', OTHER_PY);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return { root, avatarDef, baseCommonPy };
};

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  stubWorkspace.workspaceFolders = [];
});

describe('def→python 跳转:父类链臂(import 解析的真实继承)', () => {
  it('方法名不唯一时,仍落到父类实现行', async () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (raw?: unknown) => {
      const glob = patternGlob(raw);
      return glob?.endsWith('.def') ? [Uri.file(ws.avatarDef)] : [];
    }) as typeof stubWorkspace.findFiles;

    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    try {
      await (manager as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
      const provider = new KBEngineDefinitionProvider(manager);
      const document = makeTextDocument(AVATAR_DEF, {
        fileName: ws.avatarDef,
        languageId: 'kbengine-def'
      });
      // <onBoom/> 在第 2 行(0-based)
      const location = await provider.provideDefinition(
        document as never,
        new Position(2, 6) as never
      );
      expect(location).not.toBeNull();
      expect((location as unknown as { uri: { fsPath: string } }).uri.fsPath).toBe(ws.baseCommonPy);
      expect((location as unknown as { range: { start: { line: number } } }).range.start.line).toBe(1);
    } finally {
      manager.dispose();
      stubWorkspace.findFiles = originalFindFiles;
    }
  }, 20000);
});
