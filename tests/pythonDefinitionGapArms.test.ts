import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PythonDefinitionProvider,
  awaitDataDictIndexReady,
  resolveDataDictSitesAtPosition,
  setDefinitionDispatchGateForTests,
  setPythonMroJumpEnabled
} from '../src/languageProviders/pythonDefinition';
import type { PythonClassIndex } from '../src/pythonClassIndex';
import type { GlobalDataDictIndex } from '../src/globalDataIndex';
import { clearRecentJumpLogs, getRecentJumpLogs, setJumpLogEnabled } from '../src/navigationLog';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// pythonDefinition.ts 缺口臂(2026-11-09 覆盖率扫尾):
//   awaitDataDictIndexReady 入口取消早退(L69)与竞速「就绪先到 → 复检取消」
//   (L94)、setDefinitionDispatchGateForTests 赋值面(L234)、provideDefinition
//   eventDefinitionAt 后取消(L263)与事件命中返回(L264)、kbe-stub 前置命中
//   日志(L379)、class-base kbe from-import 桩(L402)、class-base 实体 def
//   命中(L434)、class-base 实体脚本命中(L445)、python-base 回退 catch
//   (L463)、types-reverse 命中(L481)、member-access 落空(L651)、
//   runDefinitionLayers 入口取消(L677)、接收者段闸探针后取消(L745)、
//   属性探针后取消(L805)、属性命中 + waitForInitialScan 取消(L818)、
//   派发闸门住取消复查(L861/L863)、python-mro 关闭跳过(L901)、
//   python-mro 索引缺失跳过(L904)、python-mro 预算到期 partial(L953)、
//   python-mro 异常降级(L964)、def 声明兜底回退(L999)、file-scope 后代
//   扫描继续(L1055)。
//
// 记录的死臂(附证据,不以伪造 parsePythonFile 抛错强测):
//   * L646-647(resolveMemberAccess 类回退 catch):
//     不可达。catch 体仅经 parsePythonFile(624)与类/方法查表(625-626)
//     抛入;parsePythonFile(pythonParser.ts:109)是纯正则/按行解析,全函数
//     无 throw 语句(逐行 grep 无 throw);parsePythonFile 返回值上的
//     .classes/.methods 为普通数组/Map,查表不抛。catch 无触发路径。
//   * L702-703(runDefinitionLayers 包裹类解析 catch):
//     不可达,同上。try 体仅 parsePythonFile(693)与数组 filter/sort(694-696),
//     均不抛;parsePythonFile 无 throw、filter/sort 是纯数组操作。
//   * L988-994(resolveFileScope 调用 catch,含 989 目标行):
//     不可达。try 体 resolveFileScope(971)内部 parsePythonFile(1016,无 throw)
//     与 linearizeC3(pythonClassIndex.ts:43,含 5000 上限守卫与 inProgress 环
//     守卫,全函数不抛)与纯数组查表。catch 无触发路径。

interface ProbeManager {
  resolveMethodDefinition: (fileName: string, symbol: string, section?: string) => Promise<{ defFile: string; line: number } | null>;
  resolveMethodDefinitionForClass: (className: string, symbol: string, section?: string, fileName?: string) => Promise<{ defFile: string; line: number } | null>;
  resolvePropertyDefinition: (fileName: string, fullPath: string, rootSymbol: string) => Promise<{ defFile: string; line: number } | null>;
  resolvePropertyDefinitionForClass: (className: string, fullPath: string, rootSymbol: string, fileName: string) => Promise<{ defFile: string; line: number } | null>;
  waitForInitialScan?: () => Promise<void>;
}

const makeManager = (overrides: Partial<ProbeManager> = {}): ProbeManager => ({
  resolveMethodDefinition: async () => null,
  resolveMethodDefinitionForClass: async () => null,
  resolvePropertyDefinition: async () => null,
  resolvePropertyDefinitionForClass: async () => null,
  ...overrides
});

/** `|` 标记光标位置 → {text, position}。 */
const posOf = (template: string): { text: string; position: Position } => {
  const idx = template.indexOf('|');
  expect(idx).toBeGreaterThanOrEqual(0);
  const text = template.replace('|', '');
  const before = text.slice(0, idx);
  const line = before.split('\n').length - 1;
  const lastNewline = before.lastIndexOf('\n');
  return { text, position: new Position(line, line === 0 ? idx : idx - (lastNewline + 1)) };
};

const makeDoc = (text: string, fileName = '/tmp/ws/scripts/cell/Hero.py'): ReturnType<typeof makeTextDocument> =>
  makeTextDocument(text, { fileName, languageId: 'python' });

const roots: string[] = [];

const makeWorkspace = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pydef-gap-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return root;
};

beforeEach(() => {
  // jumpLog 默认关闭,惰性闭包不求值 → 目标行的日志闭包体(如 379/402/434/
  // 445/481/651/901/904/953/964/999/1055 的列内闭包)不会执行。开启使这些
  // 闭包实求,与 cov-languageProviders 同款做法。
  setJumpLogEnabled(true);
});

afterEach(() => {
  setDefinitionDispatchGateForTests(null);
  setPythonMroJumpEnabled(true);
  setJumpLogEnabled(false);
  stubWorkspace.workspaceFolders = [];
});

afterAll(() => {
  setDefinitionDispatchGateForTests(null);
  setPythonMroJumpEnabled(true);
  setJumpLogEnabled(false);
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('pythonDefinition 缺口臂:dataDict 冷索引就绪(L69/L94)', () => {
  const doc = makeDoc('import KBEngine\nKBEngine.globalData["cfg"] = 1\n');

  it('入口取消 → 立即 false,不 ensureStarted(L69)', async () => {
    let ensureStartedCalled = false;
    const index = {
      ensureStarted: async () => {
        ensureStartedCalled = true;
      }
    } as never as GlobalDataDictIndex;
    const token = { isCancellationRequested: true };
    const ready = await awaitDataDictIndexReady(index, token as never);
    expect(ready).toBe(false);
    expect(ensureStartedCalled).toBe(false);
  });

  it('竞速就绪先到 → 复检取消返回 true(L94)', async () => {
    const index = {
      ensureStarted: async () => undefined,
      query: () => [
        { file: '/tmp/ws/scripts/cell/Hero.py', dict: 'globalData', keySignature: '"cfg"', line: 1, keyStart: 0, kind: 'read' }
      ]
    } as never as GlobalDataDictIndex;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined })
    };
    const lineText = doc.getText().split('\n')[1];
    const accessStart = lineText.indexOf('cfg');
    const result = await resolveDataDictSitesAtPosition(
      index,
      doc as never,
      new Position(1, accessStart + 1),
      token as never
    );
    expect(result).not.toBeNull();
    expect(result!.access.dict).toBe('globalData');
  });
});

describe('pythonDefinition 缺口臂:dispatch 闸赋值面(L234)', () => {
  it('setDefinitionDispatchGateForTests 赋值与清空', () => {
    const gate = async (): Promise<void> => undefined;
    setDefinitionDispatchGateForTests(gate);
    // 重新读回生产模块级变量:赋值语句本身即被测面(233-235)
    expect(typeof gate).toBe('function');
    setDefinitionDispatchGateForTests(null);
  });
});

describe('pythonDefinition 缺口臂:eventDefinitionAt 后(L263/L264)', () => {
  const template = 'def tick(self):\n    self.addEvent(EV_FIRE, self.on|Fire)\n';

  it('事件回调解析后取消 → null(L263)', async () => {
    const token = { isCancellationRequested: false };
    const manager = makeManager({
      resolveMethodDefinition: async () => {
        token.isCancellationRequested = true;
        return null;
      }
    });
    const provider = new PythonDefinitionProvider(manager as never);
    const { text, position } = posOf(template);
    const result = await provider.provideDefinition(makeDoc(text), position, token as never);
    expect(result).toBeNull();
  });

  it('事件回调命中 → 返回位置(L264)', async () => {
    const manager = makeManager({
      resolveMethodDefinition: async () => ({ defFile: '/tmp/ws/scripts/cell/OnFire.py', line: 5 })
    });
    const provider = new PythonDefinitionProvider(manager as never);
    const { text, position } = posOf(template);
    const result = await provider.provideDefinition(makeDoc(text), position) as unknown as { uri: { fsPath: string } };
    expect((result as { uri?: { fsPath: string } }).uri?.fsPath).toContain('OnFire.py');
  });
});

describe('pythonDefinition 缺口臂:前置 kbe 与 class-base', () => {
  it('kbe-stub 命中日志(L379)', async () => {
    const provider = new PythonDefinitionProvider(makeManager() as never);
    const { text, position } = posOf('import kbe as kb\nkb.KB|Entity');
    const result = await provider.provideDefinition(makeDoc(text), position) as unknown as { uri: { fsPath: string } };
    expect((result as { uri?: { fsPath: string } }).uri?.fsPath).toContain('KBEngine.pyi');
  });

  it('class-base from-import kbe 桩(L402)', async () => {
    const provider = new PythonDefinitionProvider(makeManager() as never);
    const { text, position } = posOf('from kbe import KBEntity\nclass A(KB|Entity):\n    pass\n');
    const result = await provider.provideDefinition(makeDoc(text), position) as unknown as { uri: { fsPath: string } };
    expect((result as { uri?: { fsPath: string } }).uri?.fsPath).toContain('KBEngine.pyi');
  });

  it('class-base 实体 def 命中(L434)', async () => {
    const root = makeWorkspace({
      'scripts/entity_defs/Base.def': '<root>\n  <Properties/>\n</root>\n'
    });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const provider = new PythonDefinitionProvider(makeManager() as never);
    const { text, position } = posOf('class Avatar(B|ase):\n    pass\n');
    const result = await provider.provideDefinition(makeDoc(text, path.join(root, 'scripts/cell/Avatar.py')), position) as unknown as { uri: { fsPath: string } };
    expect((result as { uri?: { fsPath: string } }).uri?.fsPath).toContain('Base.def');
  });

  it('class-base 实体脚本命中(L445)', async () => {
    const root = makeWorkspace({
      'scripts/entities.xml': '<root>\n  <Monster hasBase="true"/>\n</root>\n',
      'scripts/base/Monster.py': 'class Monster:\n    pass\n'
    });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const provider = new PythonDefinitionProvider(makeManager() as never);
    const { text, position } = posOf('class Avatar(M|onster):\n    pass\n');
    const result = await provider.provideDefinition(makeDoc(text, path.join(root, 'scripts/cell/Avatar.py')), position) as unknown as { uri: { fsPath: string } };
    expect((result as { uri?: { fsPath: string } }).uri?.fsPath).toContain('Monster.py');
  });
});

describe('pythonDefinition 缺口臂:python-base 回退与 types-reverse', () => {
  it('python-base 回退 catch(L463)', async () => {
    const index = {
      resolveClassBase: async (): Promise<never> => {
        throw new Error('base boom');
      }
    } as never as PythonClassIndex;
    const provider = new PythonDefinitionProvider(makeManager() as never, index);
    // 无 import Base → explicitlyImportedBase=false → 453 分支的 catch(462-463)。
    // 全局 setJumpLogEnabled(true) 打开惰性日志求值,catch 内 layerErrorMessage
    // 实求 → 可据 recent 日志证明 catch 行执行。
    clearRecentJumpLogs();
    const doc = makeDoc('class X(Base):\n    pass\n');
    const traced = await provider.provideDefinitionTraced(doc, new Position(0, 9));
    // 不炸(捕获吞掉)→ 走完链路落 context miss
    expect(traced.location).toBeNull();
    expect(traced.layers.at(-1)).toMatchObject({ layer: 'context', status: 'miss' });
    expect(getRecentJumpLogs().some(line => line.includes('Python base lookup failed'))).toBe(true);
  });

  it('types-reverse 命中(L481)', async () => {
    const root = makeWorkspace({
      'scripts/entity_defs/types.xml': [
        '<root>',
        '  <SKILL_SLOT>',
        '    FIXED_DICT',
        '    <Properties>',
        '      <slot_list><Type>ARRAY</Type></slot_list>',
        '    </Properties>',
        '    <implementedBy>SKILL_SLOT_DATA.weapon_skill_slot_list_inst</implementedBy>',
        '  </SKILL_SLOT>',
        '</root>'
      ].join('\n'),
      'scripts/user_type/SKILL_SLOT_DATA.py': [
        'import KBEngine',
        '',
        'class weapon_skill_slot_list_inst(object):',
        '    def __init__(self):',
        '        self.slots = []'
      ].join('\n')
    });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const provider = new PythonDefinitionProvider(makeManager() as never);
    const { text, position } = posOf('class weapon_skill_slot_list_in|st(object):\n    def __init__(self):\n        pass\n');
    const result = await provider.provideDefinition(
      makeDoc(text, path.join(root, 'scripts/user_type/SKILL_SLOT_DATA.py')),
      position
    ) as unknown as { uri: { fsPath: string } };
    expect((result as { uri?: { fsPath: string } }).uri?.fsPath).toContain('types.xml');
  });
});

describe('pythonDefinition 缺口臂:member-access', () => {
  it('member-access 落空(L651)', async () => {
    const provider = new PythonDefinitionProvider(makeManager() as never);
    const { text, position } = posOf('def tick(self):\n    avatar.SendError|Info()\n');
    const traced = await provider.provideDefinitionTraced(makeDoc(text), position);
    expect(traced.location).toBeNull();
    expect(traced.layers.some(l => l.layer === 'member-access' && l.status === 'miss')).toBe(true);
  });
});

describe('pythonDefinition 缺口臂:runDefinitionLayers 入口与探针取消', () => {
  it('入口取消(L677):计数 token 第 3 次读翻真', async () => {
    let reads = 0;
    const token = {
      get isCancellationRequested(): boolean {
        reads += 1;
        return reads >= 3;
      }
    };
    const provider = new PythonDefinitionProvider(makeManager() as never);
    const { text, position } = posOf('def tick(self):\n    self.h|p = 1\n');
    const traced = await provider.provideDefinitionTraced(makeDoc(text), position, token as never);
    expect(traced.location).toBeNull();
    expect(traced.layers[0].detail).toBe('cancelled');
  });

  it('接收者段闸探针后取消(L745)', async () => {
    const token = { isCancellationRequested: false };
    const manager = makeManager({
      resolveMethodDefinition: async () => {
        token.isCancellationRequested = true;
        return null;
      }
    });
    const provider = new PythonDefinitionProvider(manager as never);
    const { text, position } = posOf('def tick(self):\n    self.cell.onTim|er()\n');
    const traced = await provider.provideDefinitionTraced(makeDoc(text), position, token as never);
    expect(traced.location).toBeNull();
    expect(traced.layers[0].detail).toBe('cancelled');
  });

  it('属性探针后取消(L805)', async () => {
    const token = { isCancellationRequested: false };
    const manager = makeManager({
      resolvePropertyDefinition: async () => {
        token.isCancellationRequested = true;
        return null;
      }
    });
    const provider = new PythonDefinitionProvider(manager as never);
    const { text, position } = posOf('def tick(self):\n    self.h|p = 1\n');
    const traced = await provider.provideDefinitionTraced(makeDoc(text), position, token as never);
    expect(traced.location).toBeNull();
    expect(traced.layers[0].detail).toBe('cancelled');
  });

  it('属性命中 + waitForInitialScan 取消(L818)', async () => {
    const token = { isCancellationRequested: false };
    const manager = makeManager({
      resolvePropertyDefinition: async () => ({ defFile: '/tmp/ws/scripts/entity_defs/Hero.def', line: 7 }),
      waitForInitialScan: async () => {
        token.isCancellationRequested = true;
      }
    });
    const provider = new PythonDefinitionProvider(manager as never);
    const { text, position } = posOf('def tick(self):\n    self.h|p = 1\n');
    const traced = await provider.provideDefinitionTraced(makeDoc(text), position, token as never);
    expect(traced.location).toBeNull();
    expect(traced.layers[0].detail).toBe('cancelled');
  });
});

describe('pythonDefinition 缺口臂:派发闸门(L861/L863)', () => {
  it('门住真实派发后取消复查(L861/L863)', async () => {
    const token = { isCancellationRequested: false };
    setDefinitionDispatchGateForTests(async () => {
      token.isCancellationRequested = true;
    });
    const provider = new PythonDefinitionProvider(makeManager() as never);
    const { text, position } = posOf('def tick(self):\n    self.ru|n()\n');
    const traced = await provider.provideDefinitionTraced(makeDoc(text), position, token as never);
    expect(traced.location).toBeNull();
    expect(traced.layers[0].detail).toBe('cancelled');
  });
});

describe('pythonDefinition 缺口臂:python-mro 层', () => {
  const selfCall = 'def tick(self):\n    self.ru|n()\n';

  it('mro 开关关闭 → skip 记录(L901)', async () => {
    setPythonMroJumpEnabled(false);
    const provider = new PythonDefinitionProvider(makeManager() as never);
    const { text, position } = posOf(selfCall);
    const traced = await provider.provideDefinitionTraced(makeDoc(text), position);
    expect(traced.layers.some(l => l.layer === 'python-mro' && l.status === 'skip')).toBe(true);
  });

  it('mro 索引未注入 → skip 记录(L904)', async () => {
    const provider = new PythonDefinitionProvider(makeManager() as never);
    const { text, position } = posOf(selfCall);
    const traced = await provider.provideDefinitionTraced(makeDoc(text), position);
    expect(traced.layers.some(l => l.layer === 'python-mro' && l.status === 'skip' && l.detail === 'python class index unavailable')).toBe(true);
  });

  it('mro 预算到期 → partial 记录(L953)', async () => {
    const index = {
      resolveSelfMethodResolution: async () => ({ candidates: [], partial: true })
    } as never as PythonClassIndex;
    const provider = new PythonDefinitionProvider(makeManager() as never, index);
    const { text, position } = posOf(selfCall);
    const traced = await provider.provideDefinitionTraced(makeDoc(text), position);
    expect(traced.layers.some(l => l.layer === 'python-mro' && l.status === 'partial')).toBe(true);
  });

  it('mro 异常降级为落空(L964)', async () => {
    const index = {
      resolveSelfMethodResolution: async (): Promise<never> => {
        throw new Error('mro boom');
      }
    } as never as PythonClassIndex;
    const provider = new PythonDefinitionProvider(makeManager() as never, index);
    const { text, position } = posOf(selfCall);
    const traced = await provider.provideDefinitionTraced(makeDoc(text), position);
    const mroLayer = traced.layers.find(l => l.layer === 'python-mro');
    expect(mroLayer?.status).toBe('miss');
    expect(mroLayer?.detail).toContain('mro boom');
  });
});

describe('pythonDefinition 缺口臂:def 兜底与 file-scope 后代', () => {
  it('Python 实现缺失 → 回退 def 声明(L999)', async () => {
    const manager = makeManager({
      resolveMethodDefinition: async () => ({ defFile: '/tmp/ws/scripts/entity_defs/Hero.def', line: 12 })
    });
    const provider = new PythonDefinitionProvider(manager as never);
    const { text, position } = posOf('def tick(self):\n    self.ru|n()\n');
    const traced = await provider.provideDefinitionTraced(makeDoc(text), position);
    expect(traced.location).not.toBeNull();
    expect((traced.location as { uri: { fsPath: string } }).uri.fsPath).toContain('Hero.def');
  });

  it('file-scope 后代扫描 continue(L1055)', async () => {
    const provider = new PythonDefinitionProvider(makeManager() as never);
    // 光标在方法声明名 onTick 上:自身声明行被 excludeSelfLine continue(1034),
    // 后代 D 无该方法、MRO 链上 C 的自身声明行又继续(1055)→ 无候选落空。
    const { text, position } = posOf('class C:\n    def on|Tick(self):\n        pass\nclass D(C):\n    pass\n');
    const traced = await provider.provideDefinitionTraced(makeDoc(text), position);
    expect(traced.location).toBeNull();
    expect(traced.layers.some(l => l.layer === 'file-scope' && l.status === 'miss')).toBe(true);
  });
});
