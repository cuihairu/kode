// 父类链直读解析(pythonBaseChain)测试。
//
// 背景(2026-11-24 用户报「提了无数次」):def 里声明的方法,py 实体类靠继承
// 拿到实现——自身类没有该方法名,def-method-missing-in-python 仍报警、F12 也
// 跳不过去。本模块是三条判定面(parity 采集/缺口判定/跳转 mro 臂)共用的链。
//
// 覆盖:同文件直连、跨文件 import(绝对/相对/包 __init__/别名)、祖父链、
// 引擎内建基类(解析不到即跳过,不贡献方法)、环守卫、护栏、落点最近优先与
// 0-based 行口径、缺文件零崩溃。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  PYTHON_BASE_CHAIN_MAX_CLASSES,
  collectPythonBaseChainMethodNames,
  findMethodLocationsInPythonBaseChain,
  hasMethodImplementationInBaseChain,
  walkPythonBaseChain
} from '../src/backend/pythonBaseChain';

interface Fixture {
  root: string;
  baseAvatar: string;
  baseTwin: string;
  baseCommon: string;
  cellAvatar: string;
  cellGrand: string;
  cellBaseGrand: string;
  cellCycleA: string;
  clientAvatar: string;
  clientPackageInit: string;
}

/** KBEngine 标准布局(scripts/{base,cell,client} + scripts/common)的最小工程 */
const buildWorkspace = (): Fixture => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-basechain-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };

  // base:绝对 import 跨角色目录(scripts/common),链 2 层
  const baseAvatar = put(
    'a/scripts/base/Avatar.py',
    [
      'import kbe',
      'from common.base_common import Monster',
      '',
      'class Avatar(Monster):',
      '    def reqPos(self, stamp, pos):',
      '        pass',
      ''
    ].join('\n')
  );
  // 同文件直连父类(嵌套/别名父类常见形)
  const baseTwin = put(
    'a/scripts/base/Twin.py',
    [
      'class Inner(object):',
      '    def onInner(self):',
      '        pass',
      '',
      'class Outer(Inner):',
      '    def onOuter(self):',
      '        pass',
      ''
    ].join('\n')
  );
  const baseCommon = put(
    'a/scripts/common/base_common.py',
    [
      'class Monster(object):',
      '    def onBoom(self, victimId):',
      '        pass',
      ''
    ].join('\n')
  );

  // cell:相对导入的 3 层链(Avatar → Grand → BaseGrand)
  const cellBaseGrand = put(
    'a/scripts/cell/basegrand.py',
    ['class BaseGrand(object):', '    def onDeep(self):', '        pass', ''].join('\n')
  );
  const cellGrand = put(
    'a/scripts/cell/grand.py',
    [
      'from .basegrand import BaseGrand',
      '',
      'class Grand(BaseGrand):',
      '    def onParentCell(self):',
      '        pass',
      ''
    ].join('\n')
  );
  // 自身也实现 onDeep → 落点必须最近优先(自身在前)
  const cellAvatar = put(
    'a/scripts/cell/Avatar.py',
    [
      'from .grand import Grand',
      '',
      'class Avatar(Grand):',
      '    def onCellTick(self):',
      '        pass',
      '',
      '    def onDeep(self):',
      '        pass',
      ''
    ].join('\n')
  );

  // 互引环:必须被 seen 守卫截断,不得无限遍历
  const cellCycleA = put(
    'a/scripts/cell/cycle_a.py',
    [
      'from .cycle_b import B',
      '',
      'class A(B):',
      '    def onA(self):',
      '        pass',
      ''
    ].join('\n')
  );
  put(
    'a/scripts/cell/cycle_b.py',
    [
      'from .cycle_a import A',
      '',
      'class B(A):',
      '    def onB(self):',
      '        pass',
      ''
    ].join('\n')
  );

  // client:import 别名 + 包 __init__.py 解析
  const clientAvatar = put(
    'a/scripts/client/Avatar.py',
    [
      'from common.clientpkg import Hero as ParentClient',
      '',
      'class Avatar(ParentClient):',
      '    def onClientMove(self):',
      '        pass',
      ''
    ].join('\n')
  );
  const clientPackageInit = put(
    'a/scripts/common/clientpkg/__init__.py',
    ['class Hero(object):', '    def onClientInit(self):', '        pass', ''].join('\n')
  );

  return { root, baseAvatar, baseTwin, baseCommon, cellAvatar, cellGrand, cellBaseGrand, cellCycleA, clientAvatar, clientPackageInit };
};

const roots: string[] = [];
let ws: Fixture;

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('walkPythonBaseChain(声明序 BFS,父先于祖)', () => {
  it('同文件同名父类直连', () => {
    ws = buildWorkspace();
    roots.push(ws.root);
    const links = walkPythonBaseChain(ws.baseTwin, 'Outer');
    expect(links.map(link => link.className)).toEqual(['Outer', 'Inner']);
    expect(links[1].filePath).toBe(ws.baseTwin);
  });

  it('跨文件绝对 import(跨角色 scripts/common)', () => {
    const links = walkPythonBaseChain(ws.baseAvatar, 'Avatar');
    expect(links.map(link => link.className)).toEqual(['Avatar', 'Monster']);
    expect(links[1].filePath).toBe(ws.baseCommon);
  });

  it('跨文件相对 import 的 3 层链(祖父链)', () => {
    const links = walkPythonBaseChain(ws.cellAvatar, 'Avatar');
    expect(links.map(link => link.className)).toEqual(['Avatar', 'Grand', 'BaseGrand']);
    expect(links[1].filePath).toBe(ws.cellGrand);
    expect(links[2].filePath).toBe(ws.cellBaseGrand);
  });

  it('import 别名 + 包 __init__.py 落点', () => {
    const links = walkPythonBaseChain(ws.clientAvatar, 'Avatar');
    expect(links.map(link => link.className)).toEqual(['Avatar', 'Hero']);
    expect(links[1].filePath).toBe(ws.clientPackageInit);
  });

  it('引擎内建基类解析不到即跳过,只留自身(不贡献方法)', () => {
    const links = walkPythonBaseChain(ws.baseCommon, 'Monster');
    expect(links.map(link => link.className)).toEqual(['Monster']);
    expect(hasMethodImplementationInBaseChain(ws.baseCommon, 'Monster', 'onBoom')).toBe(false);
  });

  it('互引环被守卫截断(如实返回已收环节,不死循环)', () => {
    const links = walkPythonBaseChain(ws.cellCycleA, 'A');
    expect(links.map(link => link.className)).toEqual(['A', 'B']);
  });

  it('文件缺失/类不存在 → 空链,零崩溃', () => {
    expect(walkPythonBaseChain(path.join(ws.root, 'no/such.py'), 'X')).toEqual([]);
    expect(walkPythonBaseChain(ws.baseTwin, 'NoSuchClass')).toEqual([]);
  });

  it('类数护栏:超长同文件链截断在预算内', () => {
    const many = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-basechain-cap-'));
    roots.push(many);
    const file = path.join(many, 'scripts', 'base', 'Deep.py');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 70; i += 1) {
      const base = i === 0 ? 'object' : `C${i - 1}`;
      lines.push(`class C${i}(${base}):`, '    pass', '');
    }
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    const links = walkPythonBaseChain(file, 'C69');
    expect(links.length).toBeLessThanOrEqual(PYTHON_BASE_CHAIN_MAX_CLASSES);
  });
});

describe('hasMethodImplementationInBaseChain / collectPythonBaseChainMethodNames', () => {
  it('祖先已实现 = 已实现(误报修复的判定面)', () => {
    expect(hasMethodImplementationInBaseChain(ws.baseAvatar, 'Avatar', 'onBoom')).toBe(true);
    // 自身有、祖先没有 → 不算祖先实现
    expect(hasMethodImplementationInBaseChain(ws.baseAvatar, 'Avatar', 'reqPos')).toBe(false);
    // 全链都没有 → 真缺
    expect(hasMethodImplementationInBaseChain(ws.baseAvatar, 'Avatar', 'neverDefined')).toBe(false);
  });

  it('3 层链的祖父方法也算已实现', () => {
    expect(hasMethodImplementationInBaseChain(ws.cellAvatar, 'Avatar', 'onDeep')).toBe(true);
    expect(hasMethodImplementationInBaseChain(ws.cellAvatar, 'Avatar', 'onParentCell')).toBe(true);
  });

  it('已实现集 = 自身 ∪ 祖先(含跨角色 import 的父类)', () => {
    const names = collectPythonBaseChainMethodNames(ws.baseAvatar, 'Avatar');
    expect(names).toEqual(new Set(['reqPos', 'onBoom']));
  });

  it('环上的祖先方法并入(守卫后仍有产出)', () => {
    const names = collectPythonBaseChainMethodNames(ws.cellCycleA, 'A');
    expect(names).toEqual(new Set(['onA', 'onB']));
  });
});

describe('findMethodLocationsInPythonBaseChain(跳转落点)', () => {
  it('最近声明优先:自身实现在前,祖父实现在后', () => {
    const hits = findMethodLocationsInPythonBaseChain(ws.cellAvatar, 'Avatar', 'onDeep');
    expect(hits).toHaveLength(2);
    expect(hits[0].filePath).toBe(ws.cellAvatar);
    expect(hits[0].className).toBe('Avatar');
    expect(hits[1].filePath).toBe(ws.cellBaseGrand);
    expect(hits[1].className).toBe('BaseGrand');
  });

  it('行号保持解析器 0-based 口径(调用方负责 +1)', () => {
    // base_common.py:0=class Monster, 1=def onBoom
    const hits = findMethodLocationsInPythonBaseChain(ws.baseAvatar, 'Avatar', 'onBoom');
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    // cellAvatar:0=import,1='',2=class,3=def onCellTick
    const own = findMethodLocationsInPythonBaseChain(ws.cellAvatar, 'Avatar', 'onCellTick');
    expect(own[0].line).toBe(3);
  });

  it('全链无实现 → 空(缺实现归诊断面)', () => {
    expect(findMethodLocationsInPythonBaseChain(ws.cellAvatar, 'Avatar', 'neverDefined')).toEqual([]);
  });
});
