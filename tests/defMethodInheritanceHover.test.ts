// def 方法父类链实现面(hover)测试。
//
// 用户问(2026-11-24):「对应的 hover 是不是提示由对应的父类实现呢」「hover 中
// 是不是实现对应的集成(继承)关系呢」。验收:悬停 def 方法声明 →
// ① 签名;② 实现落点(自身类已实现 / 继承自父类 + 行号);③ 继承链。
// 全链无实现 → 不接管(缺实现的脸归 def-method-missing-in-python 诊断);
// 非方法段 / 根级 Parent / 非 def 文档 → 不接管。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { getDefMethodInheritanceHover } from '../src/languageProviders';
import { makeTextDocument, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

const AVATAR_DEF = [
  '<root>',
  '  <Parent>CommonAvatar</Parent>',
  '  <Properties>',
  '    <energy>',
  '      <Type>INT32</Type>',
  '    </energy>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg>UINT32</Arg>',
  '    </reqPos>',
  '    <onBoom>',
  '      <Arg>UINT32</Arg>',
  '    </onBoom>',
  '    <missingImpl/>',
  '  </BaseMethods>',
  '</root>',
  ''
].join('\n');

/** 自身实现 reqPos;onBoom 实现在共享父类 Monster 里 */
const BASE_PY = [
  'from common.base_common import Monster',
  '',
  'class Avatar(Monster):',
  '    def reqPos(self, stamp):',
  '        pass',
  ''
].join('\n');

const BASE_COMMON_PY = [
  'class Monster(object):',
  '    def onBoom(self, victimId):',
  '        pass',
  ''
].join('\n');

interface Fixture {
  root: string;
  avatarDef: string;
}

const buildWorkspace = (): Fixture => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-inherithover-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  const avatarDef = put('a/scripts/entity_defs/Avatar.def', AVATAR_DEF);
  put('a/scripts/base/Avatar.py', BASE_PY);
  put('a/scripts/common/base_common.py', BASE_COMMON_PY);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return { root, avatarDef };
};

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  stubWorkspace.workspaceFolders = [];
});

describe('getDefMethodInheritanceHover(def 方法悬停的父类链实现面)', () => {
  it('父类已实现 → 继承自父类 + 落点行号 + 继承链', () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    const doc = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef, languageId: 'kbengine-def' });
    // def 第 11 行 <onBoom>
    const hover = getDefMethodInheritanceHover(doc, { line: 11, character: 6 });
    expect(hover).not.toBeNull();
    const text = (hover!.contents as { value: string }).value;
    expect(text).toContain('def onBoom(self, arg1: int)');
    expect(text).toContain('inherited from `Monster`');
    expect(text).toContain('base_common.py:2');
    expect(text).toContain('**Inheritance chain**: `Avatar` → `Monster`');
  });

  it('自身类已实现 → 自身落点(不谎称继承)', () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    const doc = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef, languageId: 'kbengine-def' });
    // def 第 8 行 <reqPos>
    const hover = getDefMethodInheritanceHover(doc, { line: 8, character: 6 });
    expect(hover).not.toBeNull();
    const text = (hover!.contents as { value: string }).value;
    expect(text).toContain('def reqPos(self, arg1: int)');
    expect(text).toContain('implemented in own class `Avatar`');
    expect(text).toContain('Avatar.py:4');
  });

  it('全链无实现 → 不接管(缺实现归诊断面)', () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    const doc = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef, languageId: 'kbengine-def' });
    // def 第 14 行 <missingImpl/>
    expect(getDefMethodInheritanceHover(doc, { line: 14, character: 5 })).toBeNull();
  });

  it('非方法段(属性)与根级 Parent → 不接管', () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    const doc = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef, languageId: 'kbengine-def' });
    // <energy> 在 <Properties> 下
    expect(getDefMethodInheritanceHover(doc, { line: 4, character: 6 })).toBeNull();
    // 根级 <Parent> 归 def 链面
    expect(getDefMethodInheritanceHover(doc, { line: 1, character: 8 })).toBeNull();
  });

  it('非 def 文档不接管', () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    const doc = makeTextDocument(AVATAR_DEF, {
      fileName: path.join(ws.root, 'a/scripts/base/Avatar.py'),
      languageId: 'python'
    });
    expect(getDefMethodInheritanceHover(doc, { line: 3, character: 6 })).toBeNull();
  });

  it('无父类可解析(纯自身)时不出继承链行', () => {
    const ws = buildWorkspace();
    roots.push(ws.root);
    // 覆盖为无 import 的自身实现形态
    fs.writeFileSync(
      path.join(ws.root, 'a/scripts/base/Avatar.py'),
      ['class Avatar(object):', '    def reqPos(self, stamp):', '        pass', ''].join('\n'),
      'utf8'
    );
    const doc = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef, languageId: 'kbengine-def' });
    const hover = getDefMethodInheritanceHover(doc, { line: 8, character: 6 });
    expect(hover).not.toBeNull();
    expect((hover!.contents as { value: string }).value).not.toContain('Inheritance chain');
  });
});

// 防「未接线」回归:helper 只锁函数,此处锁它在悬停派发里真实可达(同库内交付
// ≠ 用户可见判例)。
describe('getDefMethodInheritanceHover 已接入悬停派发', () => {
  it('provideKnownHover 的 def 链开关块调用本面', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'languageProviders', 'hover.ts'), 'utf8');
    expect(src).toContain('getDefMethodInheritanceHover(document, position)');
    expect(src).toContain('if (featureConfig.hoverDefChain)');
  });
});
