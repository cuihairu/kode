import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Uri } from './fake-vscode/core';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import {
  PythonClassIndex,
  linearizeC3,
  parsePythonFile,
  type PythonClassDef
} from '../src/pythonClassIndex';

// mixin/跨类跳转根因修复:Python 类层级 + C3-MRO 解析。
// 1) 夹具单测(常绿):解析类作用域、C3 线性化、self.<method> 归属。
// 2) 真实 kbengine 验证:3 个唯一实现场景跨类跳转(路径存在才跑)。

const FIXTURE_BASE = `
class Machines:
\tdef queryAllInterfaces(self, ip="<broadcast>"):
\t\tpass
\tdef startServer(self, a, b, c):
\t\tpass

class ClusterControllerHandler(Machines):
\tdef do(self):
\t\tpass

class ClusterConsoleHandler(ClusterControllerHandler):
\tdef do(self):
\t\tself.queryAllInterfaces("x")
\t\tself.startServer(1, 2, 3)
`;

describe('parsePythonFile(类作用域归属)', () => {
  it('def 归属到其所在类;模块级 def 不算方法', () => {
    const parsed = parsePythonFile(
      'def module_level():\n\tpass\n\nclass A:\n\tdef meth(self):\n\t\tpass\n',
      '/x/mod.py'
    );
    expect(parsed.classes).toHaveLength(1);
    expect(parsed.classes[0].name).toBe('A');
    expect(parsed.classes[0].methods.has('meth')).toBe(true);
    expect(parsed.classes[0].methods.get('meth')!.line).toBe(4);
  });

  it('多类各自作用域:endLine 止于下一个同级类', () => {
    const parsed = parsePythonFile(FIXTURE_BASE, '/x/base.py');
    const names = parsed.classes.map(c => c.name);
    expect(names).toContain('Machines');
    expect(names).toContain('ClusterConsoleHandler');
    const machines = parsed.classes.find(c => c.name === 'Machines')!;
    const child = parsed.classes.find(c => c.name === 'ClusterConsoleHandler')!;
    // Machines 的方法不得被子类 def 污染
    expect(machines.methods.has('queryAllInterfaces')).toBe(true);
    expect(machines.methods.has('do')).toBe(false);
    // 子类自己 do 的行
    expect(child.methods.get('do')!.line).toBe(12);
    // 基类列表解析
    expect(child.bases).toEqual(['ClusterControllerHandler']);
  });
});

describe('linearizeC3(MRO)', () => {
  const byName = (map: Record<string, string[]>): ((n: string) => PythonClassDef[]) => {
    return (name: string): PythonClassDef[] => {
      const bases = map[name];
      if (!bases) {
        return [];
      }
      return [
        {
          name,
          bases,
          filePath: '/x/' + name + '.py',
          startLine: 0,
          endLine: 1,
          methods: new Map()
        }
      ];
    };
  };

  it('线性链:MRO 自身 → 直接基类 → 基类的基类', () => {
    const resolve = byName({ C: ['B'], B: ['A'], A: [] });
    expect(linearizeC3('C', resolve)).toEqual(['C', 'B', 'A']);
  });

  it('菱形:D3 → B → C → A(object 去重)', () => {
    // class D(B, C); B(A); C(A)
    const resolve = byName({ D: ['B', 'C'], B: ['A'], C: ['A'], A: [] });
    const mro = linearizeC3('D', resolve);
    expect(mro[0]).toBe('D');
    expect(mro).toContain('B');
    expect(mro).toContain('C');
    expect(mro).toContain('A');
    // A 只出现一次(去重)
    expect(mro.filter(n => n === 'A')).toHaveLength(1);
    // B 在 C 前(声明序)
    expect(mro.indexOf('B')).toBeLessThan(mro.indexOf('C'));
  });

  it('未知基类(外部/内置)不断链', () => {
    const resolve = byName({ X: ['KBEngineEntity'], KBEngineEntity: [] });
    expect(linearizeC3('X', resolve)).toEqual(['X', 'KBEngineEntity']);
  });
});

describe('resolveSelfMethod(跨类唯一实现)', () => {
  it('子类 self.method() 跳到基类唯一实现', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mixin-'));
    const file = path.join(tmp, 'controller.py');
    fs.writeFileSync(file, FIXTURE_BASE, 'utf8');

    const original = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (pattern?: string) =>
      pattern && pattern.includes('*.def') ? [] : [Uri.file(file)]) as typeof stubWorkspace.findFiles;
    try {
      const index = new PythonClassIndex();
      // 调用行:self.queryAllInterfaces 在 FIXTURE_BASE 0-based 第 13 行
      const loc = await index.resolveSelfMethod(file, 13, 'queryAllInterfaces');
      expect(loc).not.toBeNull();
      expect(loc!.className).toBe('Machines');
      expect(loc!.filePath).toBe(file);
      expect(loc!.line).toBe(2); // Machines.queryAllInterfaces 定义(0-based)
      // MRO 顺序供 CodeLens 用
      expect(loc!.mro[0]).toBe('ClusterConsoleHandler');
      expect(loc!.mro).toContain('Machines');

      // startServer 同理(唯一实现)
      const loc2 = await index.resolveSelfMethod(file, 14, 'startServer');
      expect(loc2).not.toBeNull();
      expect(loc2!.className).toBe('Machines');
      expect(loc2!.line).toBe(4);
    } finally {
      stubWorkspace.findFiles = original;
    }
  });
});

// ---------------------------------------------------------------------------
// 真实 kbengine 验证:3 个「跨类提供、唯一实现」场景(本机源码在则跑)
// ---------------------------------------------------------------------------
const KB_ROOT = 'D:/workspaces/kbengine';
const REAL_CONTROLLER = path.join(KB_ROOT, 'kbe/tools/server/pycluster/cluster_controller.py');
const REAL_MACHINES = path.join(KB_ROOT, 'kbe/tools/server/pycommon/Machines.py');
const realAvailable = fs.existsSync(REAL_CONTROLLER) && fs.existsSync(REAL_MACHINES);

describe.runIf(realAvailable)('真实 kbengine 跨类跳转(唯一实现)', () => {
  // 调用行(1-based,来自 grep 实测)→ 0-based;期望定义(1-based)→ 0-based
  const CASES = [
    { method: 'queryAllInterfaces', callLine1: 73, defLine1: 211 },
    { method: 'startServer', callLine1: 182, defLine1: 239 },
    { method: 'getComponentInfos', callLine1: 339, defLine1: 397 }
  ];

  it('3 个唯一实现全部跳到 Machines 定义', async () => {
    const original = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (pattern?: string) =>
      pattern && pattern.includes('*.def')
        ? []
        : [Uri.file(REAL_CONTROLLER), Uri.file(REAL_MACHINES)]) as typeof stubWorkspace.findFiles;
    try {
      const index = new PythonClassIndex();
      for (const c of CASES) {
        const loc = await index.resolveSelfMethod(REAL_CONTROLLER, c.callLine1 - 1, c.method);
        expect(loc, `${c.method} 未解析到定义`).not.toBeNull();
        expect(loc!.filePath).toBe(REAL_MACHINES);
        expect(loc!.line, `${c.method} 定义行`).toBe(c.defLine1 - 1);
        expect(loc!.className).toBe('Machines');
      }
    } finally {
      stubWorkspace.findFiles = original;
    }
  });

  it('复现证据:.def 派生索引对这些调用返回 null(修复前丢定位处)', async () => {
    // entityMapping.ts:573 ensureIndexForPythonFile 对非 .def 映射文件返回
    // undefined → resolveMethodDefinition 直接 return null。此处固化该事实,
    // 说明修复必须靠 Python MRO 兜底而非改 .def 索引。
    const original = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async () => []) as typeof stubWorkspace.findFiles;
    try {
      const { EntityMappingManager } = await import('../src/entityMapping');
      const manager = new EntityMappingManager({
        subscriptions: [],
        extensionUri: Uri.file('/workspace/ext')
      } as never);
      const resolved = await manager.resolveMethodDefinition(
        REAL_CONTROLLER,
        'queryAllInterfaces'
      );
      expect(resolved).toBeNull();
    } finally {
      stubWorkspace.findFiles = original;
    }
  });
});

// ---------------------------------------------------------------------------
// 主形态:Avatar 共同继承多文件 mixin;check_xxx 在文件 A 定义、在文件 B
// 经 self.check_xxx() 调用 —— 调用方静态类(MixinB/MixinC)MRO 里没有该方法,
// 必须反向经继承它的 Avatar 的 MRO 才落到 A 的定义处。
// 本机 kbengine 无此结构(kbe/ 与 .tmp 零个 2+ 基类、无 mixin 文件),故以
// 夹具精确复刻该形态;真实跨类用例见上节。
// ---------------------------------------------------------------------------
describe('主形态(兄弟 mixin 跨文件 self 调用,Avatar 共同继承)', () => {
  const A_FILE = [
    'class MixinA:',
    '\tdef check_alpha(self):',
    '\t\tpass',
    '',
    '\tdef check_gamma(self):',
    '\t\tpass',
    ''
  ].join('\n');
  const B_FILE = [
    'class MixinB:',
    '\tdef run_b(self):',
    '\t\tself.check_alpha()',
    '\t\tself.check_delta()',
    ''
  ].join('\n');
  const C_FILE = [
    'class MixinC:',
    '\tdef check_delta(self):',
    '\t\tpass',
    '',
    '\tdef run_c(self):',
    '\t\tself.check_gamma()',
    ''
  ].join('\n');
  const AVATAR_FILE = [
    'class Avatar(MixinA, MixinB, MixinC):',
    '\tdef boot(self):',
    '\t\tpass',
    ''
  ].join('\n');

  // 3 组:A 定义 / B 调用 / Avatar 共同继承
  const GROUPS = [
    { method: 'check_alpha', defFile: 'mixin_a.py', defLine1: 2, callFile: 'mixin_b.py', callLine1: 3 },
    { method: 'check_delta', defFile: 'mixin_c.py', defLine1: 2, callFile: 'mixin_b.py', callLine1: 4 },
    { method: 'check_gamma', defFile: 'mixin_a.py', defLine1: 5, callFile: 'mixin_c.py', callLine1: 6 }
  ];

  it('3 组全部从调用方静态类反向经 Avatar MRO 跳到定义文件', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-avatar-'));
    const files: Record<string, string> = {
      'mixin_a.py': A_FILE,
      'mixin_b.py': B_FILE,
      'mixin_c.py': C_FILE,
      'avatar.py': AVATAR_FILE
    };
    const paths: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
      paths[name] = path.join(tmp, name);
      fs.writeFileSync(paths[name], content, 'utf8');
    }

    const original = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (pattern?: string) =>
      pattern && pattern.includes('*.def')
        ? []
        : Object.values(paths).map(f => Uri.file(f))) as typeof stubWorkspace.findFiles;
    try {
      const index = new PythonClassIndex();
      for (const g of GROUPS) {
        const loc = await index.resolveSelfMethod(
          paths[g.callFile],
          g.callLine1 - 1,
          g.method
        );
        expect(loc, `${g.method} 未解析到定义`).not.toBeNull();
        expect(loc!.filePath, `${g.method} 定义文件`).toBe(paths[g.defFile]);
        expect(loc!.line, `${g.method} 定义行`).toBe(g.defLine1 - 1);
        // 提供者是 A/C 中的 mixin 类,不是调用方静态类
        expect(loc!.className).toMatch(/^Mixin/);
        expect(loc!.className).not.toBe(g.callFile === 'mixin_b.py' ? 'MixinB' : 'MixinC');
      }

      // 关键:调用方静态类 MRO 自身解不到 → 必走反向(经 Avatar)
      const mroOfB = await index.computeMRO('MixinB');
      expect(mroOfB).not.toContain('MixinA'); // 静态 MRO 无 A,证明是反向命中
      const avatarLoc = await index.resolveSelfMethod(paths['mixin_b.py'], 2, 'check_alpha');
      expect(avatarLoc!.anchorClass, '锚定类应为 Avatar(反向)').toBe('Avatar');
      expect(avatarLoc!.mro[0]).toBe('Avatar');
    } finally {
      stubWorkspace.findFiles = original;
    }
  });
});

// ---------------------------------------------------------------------------
// 真实 kbengine 反向案例(主形态的「调用方静态类解不到,需经继承它的类解」):
// vendored six.py —— _LazyDescr.__get__ 内 self._resolve() 静态类 _LazyDescr
// 自身与祖先(object)均无 _resolve;实现在其两个子类里,故应返回全部候选。
// ---------------------------------------------------------------------------
describe('真实 kbengine 反向形态(six.py)', () => {
  const SIX = path.join(
    'D:', 'workspaces', 'kbengine', 'kbe', 'tools', 'server', 'webconsole', 'six.py'
  );

  it('six.py:92 调用 → 返回 MovedModule 与 MovedAttribute 两个实现候选', async () => {
    if (!fs.existsSync(SIX)) {
      console.warn('skip: kbengine six.py 不在', SIX);
      return;
    }
    const original = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (pattern?: string) =>
      pattern && pattern.includes('*.def') ? [] : [Uri.file(SIX)]) as typeof stubWorkspace.findFiles;
    try {
      const index = new PythonClassIndex();
      const cands = await index.resolveSelfMethodCandidates(SIX, 91, '_resolve'); // 1-based 92
      expect(cands.length, '应有 2 个实现候选').toBe(2);
      const lines = cands.map(c => c.line).sort((a, b) => a - b);
      expect(lines, 'MovedModule._resolve(0-based 113) + MovedAttribute._resolve(0-based 158)')
        .toEqual([113, 158]);
      // 静态类自身 MRO 确实解不到(证明走的是反向)
      const mroDescr = await index.computeMRO('_LazyDescr');
      expect(mroDescr).not.toContain('MovedModule');
      // 单候选入口(首个)也非空
      const first = await index.resolveSelfMethod(SIX, 91, '_resolve');
      expect(first).not.toBeNull();
      expect(first!.anchorClass).toBeDefined();
    } finally {
      stubWorkspace.findFiles = original;
    }
  });
});
