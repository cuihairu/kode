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
