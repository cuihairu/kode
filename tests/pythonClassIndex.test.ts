import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Position, Uri } from './fake-vscode/core';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import {
  PythonClassIndex,
  PY_SCAN_EXCLUDE,
  linearizeC3,
  parsePythonFile,
  type PythonClassDef
} from '../src/pythonClassIndex';
import { EntityMappingManager } from '../src/entityMapping';
import { PythonDefinitionProvider } from '../src/languageProviders';
import { makeTextDocument } from './helpers/vscodeStub';

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

// ---------------------------------------------------------------------------
// 「加载很久 / No definition found」修复回归(2026-10-16):
// ① 扫描面收窄到 PY_SCAN_EXCLUDE(排 vcpkg/build/.tmp…;实测旧面 14,245 个
//    .py × 10.13ms ≈ 144 秒,是「加载很久」主来源);
// ② 扫描失败不得永久缓存(修复前 catch 吞掉后 scanPromise 停在已扫描态,
//    跨文件类永远补不进来 → 每次跳转 No definition found);
// ③ provider 级真实跳转:走完整 provideDefinition 链,不是只测索引 API。
// ---------------------------------------------------------------------------
describe('扫描面收窄与失败重试', () => {
  const makeTmp = (): { dir: string; cleanup: () => void } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-scan-scope-'));
    fs.writeFileSync(path.join(dir, 'a.py'), 'class Alpha:\n\tdef meth(self):\n\t\tpass\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.py'), 'class Beta(Alpha):\n\tdef run(self):\n\t\tself.meth()\n', 'utf8');
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  };

  it('findFiles 收窄为 PY_SCAN_EXCLUDE(含 vcpkg/build),失败后下次重试并命中', async () => {
    const { dir, cleanup } = makeTmp();
    // PR5 后:跨目录场景——staging(同目录/import/同名文件)覆盖不到的
    // 引用仍依赖全量扫描,用它守住「扫描失败不得永久缓存」的回归;
    // 同目录命中不再依赖扫描(Definition 去全仓阻塞)由下一用例锁定。
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.renameSync(path.join(dir, 'b.py'), path.join(dir, 'sub', 'b.py'));
    const queryFile = path.join(dir, 'sub', 'b.py');
    const original = stubWorkspace.findFiles;
    const seen: Array<{ pattern?: string; exclude?: unknown }> = [];
    let attempt = 0;
    let failing = true;
    stubWorkspace.findFiles = (async (pattern?: string, exclude?: unknown) => {
      attempt += 1;
      seen.push({ pattern, exclude });
      if (failing) {
        throw new Error('search service unavailable');
      }
      return ['a.py', 'sub/b.py'].map(name => Uri.file(path.join(dir, name)));
    }) as typeof stubWorkspace.findFiles;

    try {
      const index = new PythonClassIndex();
      // 持续失败期间:staging 覆盖不到的跨目录类 → 当次落空,且不等全量扫描
      const first = await index.resolveSelfMethod(queryFile, 2, 'meth');
      expect(first, '持续扫描失败当次降级为 null').toBeNull();
      const attemptsWhileFailing = attempt;
      expect(attemptsWhileFailing, '失败期间确有扫描尝试').toBeGreaterThan(0);

      // 恢复后必须重新发起 findFiles(修复前 catch 吞掉后 scan 永久停在
      // 「已扫描」态 → 不再尝试、永远 null)。调度器排队使失败扫描可能晚于
      // 上一查询返回:第一发吸收在途失败,失败不缓存 → 紧接的全量口径调用
      // 必须重新发现并命中。
      failing = false;
      await index.findClassesByName('Alpha');
      const classes = await index.findClassesByName('Alpha');
      expect(attempt, '恢复后必须重试 findFiles').toBeGreaterThan(attemptsWhileFailing);
      expect(classes.length, '恢复后全量扫描应命中').toBeGreaterThan(0);
      const second = await index.resolveSelfMethod(queryFile, 2, 'meth');
      expect(second, '恢复后应跨目录命中').not.toBeNull();
      expect(second!.filePath).toBe(path.join(dir, 'a.py'));
      expect(second!.className).toBe('Alpha');

      // 排除面:pattern 为 **/*.py 且排除列表 = 收窄后的 PY_SCAN_EXCLUDE
      // (PR5 起组合根元数据发现也会复用同一 stub,这里按 pattern 过滤取证)
      const pyScan = seen.find(item => item.pattern === '**/*.py');
      expect(pyScan, '应有 **/*.py 全量发现尝试').toBeDefined();
      expect(pyScan!.exclude).toBe(PY_SCAN_EXCLUDE);
      expect(String(seen[0].exclude)).toContain('vcpkg');
      expect(String(seen[0].exclude)).toContain('build');
      expect(PY_SCAN_EXCLUDE).toContain('.tmp');
    } finally {
      stubWorkspace.findFiles = original;
      cleanup();
    }
  });

  // PR5 ②:冷启动首查不等全量扫描——发现面只报 b.py(模拟搜索索引未收录
  // a.py),全量扫描永远看不到 Alpha 定义文件;首查依靠快照 + 按需单文件解析
  // (同目录兄弟)照常命中,不依赖全量扫描结果。
  it('冷启动 Definition 首查不阻塞在全量扫描上(发现面未收录仍命中)', async () => {
    const { dir, cleanup } = makeTmp();
    const original = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (pattern?: string) =>
      pattern && !pattern.includes('*.py')
        ? [] // entities.xml/.def/types.xml 元数据发现直接空
        : [Uri.file(path.join(dir, 'b.py'))]) as typeof stubWorkspace.findFiles;
    try {
      const index = new PythonClassIndex();
      const started = performance.now();
      const loc = await index.resolveSelfMethod(path.join(dir, 'b.py'), 2, 'meth');
      const elapsed = performance.now() - started;
      expect(loc, '发现面未收录的文件仍按需命中').not.toBeNull();
      expect(loc!.filePath).toBe(path.join(dir, 'a.py'));
      expect(loc!.className).toBe('Alpha');
      expect(elapsed, `首查应远快于全量解析(实测 ${Math.round(elapsed)}ms)`).toBeLessThan(2000);
      // 全量口径收尾:后台扫描按发现面口径工作(a.py 不在其发现面);
      // 按需入索引的 a.py 保留在会话缓存里,Alpha 仍可解析(快照口径)
      expect(await index.findClassesByName('Beta').then(list => list.length)).toBe(1);
      expect((await index.findClassesByName('Alpha')).map(cls => cls.filePath)).toEqual([path.join(dir, 'a.py')]);
    } finally {
      stubWorkspace.findFiles = original;
      cleanup();
    }
  });
});

// provider 级真实跳转(路径不存在的机器自动跳过):完整 provideDefinition 链 =
// kbe 分支 → types.xml 反查 → self 访问 → property/method(.def,无归属→null)
// → PythonClassIndex 兜底。三例均须落到 Machines.py 的真实定义行。
describe('provideDefinition 真实 kbengine 跳转(端到端)', () => {
  const ROOT = 'D:/workspaces/kbengine';
  const CONTROLLER = path.join(ROOT, 'kbe', 'tools', 'server', 'pycluster', 'cluster_controller.py');
  const ORIGINAL = stubWorkspace.findFiles;

  const realFindFiles = async (pattern?: string, exclude?: unknown): Promise<Uri[]> => {
    const wantDef = Boolean(pattern && pattern.includes('*.def'));
    const excluded = new Set<string>();
    for (const part of String(exclude ?? '').replace(/^\*\*\/\{/, '').replace(/\}\/\*\*$/, '').split(',')) {
      const name = part.trim();
      if (name) {
        excluded.add(name);
      }
    }
    const out: Uri[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!excluded.has(entry.name) && entry.name !== '.git') {
            walk(full);
          }
        } else if (wantDef ? entry.name.endsWith('.def') : entry.name.endsWith('.py')) {
          out.push(Uri.file(full));
        }
      }
    };
    walk(ROOT);
    return out;
  };

  it('cluster_controller 三处 self 方法 → Machines.py 真实定义行', async () => {
    if (!fs.existsSync(CONTROLLER)) {
      console.warn(`skip: ${CONTROLLER} not found`);
      return;
    }
    stubWorkspace.findFiles = realFindFiles as unknown as typeof stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ROOT), name: 'kbengine', index: 0 }];

    try {
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      const provider = new PythonDefinitionProvider(manager, new PythonClassIndex());
      const text = fs.readFileSync(CONTROLLER, 'utf8');
      const lines = text.split('\n');
      const cases = [
        { line: 72, method: 'queryAllInterfaces', defLine: 210 },
        { line: 181, method: 'startServer', defLine: 238 },
        { line: 338, method: 'getComponentInfos', defLine: 396 }
      ];

      for (const item of cases) {
        const lineText = lines[item.line];
        const at = lineText.indexOf(item.method);
        expect(at, `行 ${item.line + 1} 应含 ${item.method}`).toBeGreaterThan(0);
        const document = makeTextDocument(text, { fileName: CONTROLLER, languageId: 'python' });
        const location = (await provider.provideDefinition(
          document,
          new Position(item.line, at + 1)
        )) as { uri: { fsPath: string }; range: { start: { line: number } } } | null;

        expect(location, `${item.method} 应有落点`).not.toBeNull();
        expect(location!.uri.fsPath.replace(/\\/g, '/')).toContain('pycommon/Machines.py');
        expect(location!.range.start.line, `${item.method} 定义行`).toBe(item.defLine);
      }
      manager.dispose();
    } finally {
      stubWorkspace.findFiles = ORIGINAL;
      stubWorkspace.workspaceFolders = [];
    }
  });
});
