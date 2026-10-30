// 覆盖补齐(lcov 基线):pythonReturnTypeInference / pythonClassIndex /
// quickActions 三模块的未覆盖行——错误守卫、边界分支、少走路径的行为锁。
// 只加测试不改实现;每条 it 锁一个真实语义,不做「调 getter 刷行数」的空转。

import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  collectProjectPythonFiles,
  extractDefReturnAnnotation,
  extractFileReturnAnnotations,
  extractFileReturnAnnotationsAsync,
  parseLocalAssignmentCall,
  releaseDocumentReturnAnnotations,
  resetPythonReturnAnnotationCache,
  resolveLocalVariableReturnType,
  resolveLocalVariableReturnTypeFromSnapshot,
  updateDocumentReturnAnnotationsAsync
} from '../src/pythonReturnTypeInference';
import {
  clearRecentAnnotationSourceLogs,
  getRecentAnnotationSourceLogs,
  setAnnotationSourceLogEnabled
} from '../src/annotationSourceLog';
import { displayPath, linearizeC3, PythonClassIndex, type PythonClassDef } from '../src/pythonClassIndex';
import { IndexScheduler, type IndexTaskHandle, type IndexTaskSpec } from '../src/indexScheduler';
import { clearRecentJumpLogs, getRecentJumpLogs, setJumpLogEnabled } from '../src/navigationLog';
import {
  QuickActionManager,
  setDefaultScriptRuntime,
  terminalHttp,
  terminalScript,
  type QuickActionManagerDeps
} from '../src/quickActions';
import { ProcessManager, type ProcessSpawnRunner } from '../src/processManager';
import type { LogHubLike } from '../src/logHub';
import {
  makeTextDocument,
  memoryFileSystem,
  messages,
  Uri,
  window as stubWindow,
  windowState,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// ---- 解析接缝(pythonClassIndexParseFailure.test.ts 同款):默认透传真实
// parsePythonFileResponsive,按用例切成拒绝,复现「worker 停用/解析失败」路径。
const parseState = vi.hoisted(() => ({
  impl: undefined as undefined | ((...args: unknown[]) => Promise<unknown>)
}));
vi.mock('../src/pythonParserWorkerHost', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/pythonParserWorkerHost')>();
  return {
    ...actual,
    parsePythonFileResponsive: (...args: unknown[]) =>
      parseState.impl
        ? parseState.impl(...args)
        : (actual.parsePythonFileResponsive as (...a: unknown[]) => Promise<unknown>)(...args)
  };
});

// ---- 脚手架(pythonIndexPr5.test.ts 同款) ----

const cleanups: Array<() => void> = [];
const httpServers: http.Server[] = [];

const makeRoot = (files: Record<string, string>): Record<string, string> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cov-'));
  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    paths[name] = full;
  }
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return paths;
};

const rootDirOf = (filePath: string): string => path.dirname(filePath);

const pointWorkspaceAt = (dir: string): void => {
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(dir), name: 'ws', index: 0 }];
};

const stubFindFiles = (routing: (pattern: string) => string[]): void => {
  stubWorkspace.findFiles = (async (pattern?: unknown) =>
    routing(String(pattern ?? '')).map(file => Uri.file(file))) as typeof stubWorkspace.findFiles;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition not met in time');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

type SyncDoc = Parameters<PythonClassIndex['syncDocumentParse']>[0];
const pyDoc = (fileName: string, text: string, version: number): SyncDoc =>
  makeTextDocument(text, { fileName, languageId: 'python', version }) as unknown as SyncDoc;
const fullDoc = (fileName: string, text: string, version: number): vscode.TextDocument =>
  makeTextDocument(text, { fileName, languageId: 'python', version }) as unknown as vscode.TextDocument;

// 私有面读取(既有用例同款 as 转型):重试登记表/在途请求/组合根内容缓存。
type ClassIndexInternals = PythonClassIndex & {
  loadFile(filePath: string, version: number): Promise<boolean>;
  stagedRequests: Map<string, Promise<void>>;
  pendingScanRetries: Map<string, number>;
  rootsContentCache: Map<string, unknown>;
};
const asInternals = (index: PythonClassIndex): ClassIndexInternals => index as ClassIndexInternals;

// 全部 full-reindex 任务注入失败:复现「整块被取消/失败」的重试口径。
class RejectFullReindexScheduler extends IndexScheduler {
  async waitForIdle(timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const status = this.getStatus();
      if (status.queued === 0 && status.running === null) { return; }
      if (Date.now() - start > timeoutMs) { throw new Error('scheduler not idle in time'); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  override enqueue(spec: IndexTaskSpec): IndexTaskHandle {
    if (spec.kind !== 'full-reindex') { return super.enqueue(spec); }
    return super.enqueue({ ...spec, run: async () => { throw new Error('chunk cancelled'); } });
  }
}

const ASSET_FILES = {
  'entities.xml': '<?xml version="1.0"?><entities><Avatar/></entities>',
  'types.xml': '<types><VECTOR3>FLOAT32</VECTOR3></types>',
  'Avatar.def': '<root><Properties><name><Type>VECTOR3</Type></name></Properties></root>',
  'Avatar.py': 'class Avatar:\n\tdef onTimer(self):\n\t\treturn 0\n',
  'bridge.py': 'avatar_instance = Avatar()\n'
};

const assetRouting = (paths: Record<string, string>) => (pattern: string): string[] => {
  const glob = pattern.replace(/\*\*\//, '');
  if (glob === 'entities.xml') { return [paths['entities.xml']]; }
  if (glob === 'types.xml') { return [paths['types.xml']]; }
  if (glob.endsWith('.def')) { return [paths['Avatar.def']]; }
  if (glob.includes('*.py')) { return [paths['Avatar.py'], paths['bridge.py']]; }
  return [];
};

// ---- quickActions 脚手架(quickActionManager.test.ts 同款) ----

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalShowInfo = windowish.showInformationMessage;
const scriptRuns: Array<{ name?: string; script: string; background: boolean }> = [];

const memento = new Map<string, unknown>();
const makeContext = (): vscode.ExtensionContext =>
  ({
    subscriptions: [],
    extensionUri: Uri.file('/ext'),
    workspaceState: {
      get: <T>(key: string): T | undefined => memento.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        memento.set(key, value);
      }
    }
  }) as unknown as vscode.ExtensionContext;

const makeDeps = (): QuickActionManagerDeps => ({
  runScript: async options => {
    scriptRuns.push(options);
    return { code: 0, stdout: '', stderr: '' };
  },
  runHttp: async () => ({ status: 200, body: '' }),
  executeCommand: async () => undefined
});

const setConfig = (config: unknown): void => {
  memoryFileSystem.set('/ws/.kbengine/debug.json', JSON.stringify(config));
};

const readConfig = (): { quickActions?: Array<{ name?: string; source?: string }>; httpRequests?: unknown[] } | null => {
  const raw = memoryFileSystem.files.get('/ws/.kbengine/debug.json');
  return raw ? JSON.parse(Buffer.from(raw).toString('utf8')) : null;
};

const makeRecordingHub = (): { hub: LogHubLike; lines: Array<{ component?: string; text: string }> } => {
  const lines: Array<{ component?: string; text: string }> = [];
  const hub = {
    stdout: () => undefined,
    stderr: () => undefined,
    info: (input: { component?: string; text: string }) => { lines.push({ component: input.component, text: input.text }); },
    warning: () => undefined,
    error: (input: { component?: string; text: string }) => { lines.push({ component: input.component, text: input.text }); }
  };
  return { hub: hub as unknown as LogHubLike, lines };
};

afterEach(() => {
  // 解析接缝与三模块全局开关全部复位,防止用例间串味
  parseState.impl = undefined;
  resetPythonReturnAnnotationCache();
  setJumpLogEnabled(false);
  clearRecentJumpLogs();
  setAnnotationSourceLogEnabled(false);
  clearRecentAnnotationSourceLogs();
  windowish.showInformationMessage = originalShowInfo;
  setDefaultScriptRuntime(new ProcessManager(undefined, undefined), undefined);
  // vscode 替身状态复位
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.findFiles = async () => [];
  stubWorkspace.textDocuments = [];
  memoryFileSystem.reset();
  windowState.reset();
  memento.clear();
  scriptRuns.length = 0;
  for (const server of httpServers.splice(0)) {
    server.closeAllConnections?.();
    void server.close();
  }
  for (const cleanup of cleanups.splice(0)) { cleanup(); }
});

// ---- pythonReturnTypeInference ----

describe('pythonReturnTypeInference 覆盖补齐', () => {
  it('parseLocalAssignmentCall:字符串里的 #/引号/转义不当注释与调用切分', () => {
    // '#' 在字符串内:掩码后仍是完整调用,不会被当注释截断
    expect(parseLocalAssignmentCall("msg = fmt('a#b')")).toEqual({
      target: 'msg', receiver: null, methodName: 'fmt'
    });
    // 字符串里的单引号(双引号包裹)不提前闭串
    expect(parseLocalAssignmentCall('flag = parse("it\'s # fine")')).toEqual({
      target: 'flag', receiver: null, methodName: 'parse'
    });
    // 反斜杠转义:跳过被转义字符,闭串位置不漂移
    expect(parseLocalAssignmentCall("data = check('a\\'b')")).toEqual({
      target: 'data', receiver: null, methodName: 'check'
    });
    // 右值是纯字符串字面量:不是调用 → null
    expect(parseLocalAssignmentCall('msg = "plain string"')).toBeNull();
  });

  it('extractDefReturnAnnotation:命中面(多行签名/空白归一/字符串里的括号)', () => {
    expect(extractDefReturnAnnotation('def get_data(self) -> JSONDATA:\n    return None\n', 'get_data')).toBe('JSONDATA');
    // 多行签名:形参注解里的冒号在括号内不收口
    expect(extractDefReturnAnnotation('def build(\n    a: int,\n    b: str,\n) -> Multi:\n    pass\n', 'build')).toBe('Multi');
    // 注解两端空白归一
    expect(extractDefReturnAnnotation('def f() ->   Spaced   :\n    pass\n', 'f')).toBe('Spaced');
    // 默认参字符串里的 )/: 掩码后不误收口
    expect(extractDefReturnAnnotation('def real(x = "):" ) -> MASKED:\n    pass\n', 'real')).toBe('MASKED');
  });

  it('extractDefReturnAnnotation:落空面(无箭头/无 def/截断/空注解/名字边界)', () => {
    // def 在而 -> 缺:null(无注解不显示)
    expect(extractDefReturnAnnotation('def f(self):\n    pass\n', 'f')).toBeNull();
    // def 不在:null
    expect(extractDefReturnAnnotation('x = 1\n', 'missing')).toBeNull();
    // 签名截断(64 行窗口内无收口冒号):null
    expect(extractDefReturnAnnotation('def broken(', 'broken')).toBeNull();
    // -> 后为空:null
    expect(extractDefReturnAnnotation('def f() -> :\n    pass\n', 'f')).toBeNull();
    // 名字边界:get_data 不得误吞 get_database
    expect(extractDefReturnAnnotation('def get_database(self) -> NO:\n', 'get_data')).toBeNull();
  });

  it('extractFileReturnAnnotations(同步/异步):字符串里的假 def 不入账', async () => {
    const source = [
      "FAKE = 'def hidden() -> NOPE:'",
      "TRIPLE = '''abc'''",
      'def real(x = "):" ) -> SYNC_RES:',
      '    pass',
      "s = 'a\\'b'  # tail comment",
      't = "x # y"',
      ''
    ].join('\n');
    // 同步掩码:单/三引号字符串、串内转义、行尾注释都不产生假 def
    expect([...extractFileReturnAnnotations(source)]).toEqual([['real', 'SYNC_RES']]);
    // 异步协作掩码同口径
    expect([...(await extractFileReturnAnnotationsAsync(source))]).toEqual([['real', 'SYNC_RES']]);
  });

  it('collectProjectPythonFiles:排除目录不走、排序保确定、limit 截断、文件当根返回空', () => {
    const paths = makeRoot({
      'keep0.py': 'x = 0\n',
      'sub/keep.py': 'x = 1\n',
      'node_modules/skip.py': 'x = 2\n',
      '.venv/skip2.py': 'x = 3\n',
      'notes.txt': 'not python\n'
    });
    const root = rootDirOf(paths['keep0.py']);
    const files = collectProjectPythonFiles(root);
    expect(files).toEqual([paths['keep0.py'], paths['sub/keep.py']]);
    // limit 在目录进入与文件收集两处都生效(顺序随 readdir,只锁数量)
    expect(collectProjectPythonFiles(root, 2)).toHaveLength(2);
    // 传文件路径当根:readdir ENOTDIR → 空清单不抛
    expect(collectProjectPythonFiles(paths['keep0.py'])).toEqual([]);
  });

  it('updateDocumentReturnAnnotationsAsync:提取期间文档已关,弃桶不复活', async () => {
    const paths = makeRoot({});
    const root = rootDirOf(Object.values(paths)[0] ?? path.join(os.tmpdir(), 'kode-cov-x'));
    const fileKey = path.join(root, 'svc.py');
    let closed = false;
    await updateDocumentReturnAnnotationsAsync(root, {
      fileKey,
      version: 5,
      // source() 在提取启动时才被调用:此刻关文档 = 代际前进,回包不得落桶
      source: () => {
        if (!closed) {
          closed = true;
          releaseDocumentReturnAnnotations(root, fileKey);
        }
        return 'def get_data() -> GHOST:\n    pass\n';
      }
    });
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root)).toBeNull();
    // 重新「打开」(新版本)后恢复正常提取入桶
    await updateDocumentReturnAnnotationsAsync(root, {
      fileKey,
      version: 6,
      source: () => 'def get_data() -> ALIVE:\n    pass\n'
    });
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root)?.annotation).toBe('ALIVE');
  });

  it('注解来源日志:磁盘快照命中落 hover-resolve source=disk-snapshot(非 import 面)', async () => {
    const paths = makeRoot({ 'svc.py': 'def get_data() -> DISK_ONLY:\n    return None\n' });
    const root = rootDirOf(paths['svc.py']);
    pointWorkspaceAt(root);
    // 先走一次完整解析暖盘
    const warmed = await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
    expect(warmed?.annotation).toBe('DISK_ONLY');
    setAnnotationSourceLogEnabled(true);
    clearRecentAnnotationSourceLogs();
    const resolved = resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root);
    expect(resolved?.annotation).toBe('DISK_ONLY');
    const lines = getRecentAnnotationSourceLogs().join('\n');
    expect(lines).toContain('hover-resolve');
    expect(lines).toContain('source=disk-snapshot');
    expect(lines).not.toContain('(import)');
  });

  it('resolveLocalVariableReturnType:全大写常量与无根工作区直接 null(不起异步)', () => {
    expect(resolveLocalVariableReturnType(['DATA = 1'], 0, 'DATA', '/tmp')).toBeNull();
    expect(resolveLocalVariableReturnType(['data = f()'], 0, 'data', null)).toBeNull();
  });
});

// ---- pythonClassIndex ----

describe('pythonClassIndex 覆盖补齐', () => {
  it('linearizeC3:非法继承图不可线性化时平铺去重,不丢类', () => {
    const defs: Record<string, string[]> = {
      O: [],
      X: ['O'],
      Y: ['O'],
      A: ['X', 'Y'],
      B: ['Y', 'X'],
      C: ['A', 'B']
    };
    const resolve = (name: string): PythonClassDef[] => [{
      name, bases: defs[name] ?? [], filePath: `/fake/${name}.py`, startLine: 0, endLine: 1, methods: new Map()
    }];
    const mro = linearizeC3('C', resolve);
    // X/Y 顺序在 A、B 两支互斥 → 死锁 → 平铺兜底:六个类一个不丢
    expect(mro).toEqual(['C', 'A', 'B', 'X', 'Y', 'O']);
  });

  it('linearizeC3:循环继承护栏终止,退化结果仍含自身与环路对端', () => {
    const defs: Record<string, string[]> = { A: ['B'], B: ['A'] };
    const resolve = (name: string): PythonClassDef[] => [{
      name, bases: defs[name] ?? [], filePath: `/fake/${name}.py`, startLine: 0, endLine: 1, methods: new Map()
    }];
    const mro = linearizeC3('A', resolve);
    expect(mro[0]).toBe('A');
    expect(mro).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('invalidate() 全量失效:五轴齐递增,版本键缓存清空', () => {
    const index = new PythonClassIndex();
    const file = '/ghost/svc.py';
    index.syncDocumentParse(pyDoc(file, 'class Svc:\n    pass\n', 1));
    expect(index.getParsedForVersion(file, 1)).not.toBeNull();
    const before = index.getIndexVersions();
    index.invalidate();
    const after = index.getIndexVersions();
    for (const key of ['classes', 'bases', 'methods', 'mro', 'compositionRoots'] as const) {
      expect(after[key]).toBeGreaterThan(before[key]);
    }
    // mro 轴在「五轴齐递增」与「扫描换代」两处各 +1(实际口径)
    expect(after.mro).toBe(before.mro + 2);
    expect(index.getParsedForVersion(file, 1)).toBeNull();
  });

  it('onFileChanged:非 .py 资产文件走失效通知,不抛不虚进类轴', async () => {
    const index = new PythonClassIndex();
    const classesBefore = index.getIndexVersion('classes');
    await index.onFileChanged('/ghost/Avatar.def');
    expect(index.getIndexVersion('classes')).toBe(classesBefore);
  });

  it('commitParsedFile:类集合变化(删类)递增 classes 版本轴', async () => {
    const index = new PythonClassIndex();
    const file = '/ghost/thing.py';
    index.syncDocumentParse(pyDoc(file, 'class Thing:\n    pass\nclass Other:\n    pass\n', 1));
    const before = index.getIndexVersion('classes');
    index.syncDocumentParse(pyDoc(file, 'class Thing:\n    pass\n', 2));
    expect(index.getIndexVersion('classes')).toBe(before + 1);
    // 删除的类不再可按名查到
    await expect(index.findClassesByName('Other')).resolves.toEqual([]);
  });

  it('组合根派生:并发查询并入同一在途派生(join 不重复读)', async () => {
    const paths = makeRoot(ASSET_FILES);
    pointWorkspaceAt(rootDirOf(paths['Avatar.py']));
    stubFindFiles(assetRouting(paths));
    const index = new PythonClassIndex();
    // 预热全量扫描:组合根派生不再被分块解析的赋值签名变化打断
    await index.findClassesByName('Avatar');
    const first = index.rootsContaining('Avatar');
    await Promise.resolve();
    const second = index.rootsContaining('Monster');
    expect(await first).toContain('Avatar');
    expect(await second).toEqual([]);
  });

  it('组合根派生:entities.xml 指向不存在文件,容错为无根(不抛)', async () => {
    const paths = makeRoot(ASSET_FILES);
    pointWorkspaceAt(rootDirOf(paths['Avatar.py']));
    stubFindFiles(pattern => {
      const glob = pattern.replace(/\*\*\//, '');
      if (glob === 'entities.xml') { return [path.join(rootDirOf(paths['entities.xml']), 'missing.xml')]; }
      return assetRouting(paths)(pattern);
    });
    const index = new PythonClassIndex();
    expect(await index.rootsContaining('Avatar')).toEqual([]);
  });

  it('组合根派生:元数据 glob 拒绝 → rootsMap 落空,查询返回空不缓存假象', async () => {
    const paths = makeRoot(ASSET_FILES);
    pointWorkspaceAt(rootDirOf(paths['Avatar.py']));
    stubFindFiles(pattern => {
      const glob = pattern.replace(/\*\*\//, '');
      if (glob.includes('*.py')) { return [paths['Avatar.py'], paths['bridge.py']]; }
      throw new Error('findFiles rejected');
    });
    const index = new PythonClassIndex();
    expect(await index.rootsContaining('Avatar')).toEqual([]);
    // 失败不缓存:下一次调用会重新派生(而非拿空结果答话)
    expect(await index.rootsContaining('Avatar')).toEqual([]);
  });

  it('全扫分块失败:登记待补+日志;重试整块再被取消则保持登记', async () => {
    const paths = makeRoot({
      'a.py': 'class Alpha:\n\tdef meth(self):\n\t\tpass\n',
      'b.py': 'class Beta(Alpha):\n\tdef run(self):\n\t\tself.meth()\n'
    });
    pointWorkspaceAt(rootDirOf(paths['a.py']));
    stubFindFiles(pattern => {
      if (pattern.includes('*.py')) { return [paths['a.py'], paths['b.py']]; }
      return [];
    });
    setJumpLogEnabled(true);
    const scheduler = new RejectFullReindexScheduler();
    const index = new PythonClassIndex(scheduler);
    const internals = asInternals(index);
    await index.waitForInitialScan();
    // 分块全部失败:两文件登记待补 + 日志明确「未随分块解析」
    expect(getRecentJumpLogs().some(line => line.includes('未随分块解析'))).toBe(true);
    expect(internals.pendingScanRetries.size).toBe(2);
    expect(await index.findClassesByName('Beta')).toHaveLength(0);
    // 查询触发的定向重试整块同样被取消:登记保持(不误删不放弃),下一次查询再试
    await scheduler.waitForIdle();
    expect(internals.pendingScanRetries.size).toBe(2);
  }, 10000);

  it('待补重试:解析失败有界重试,3 次后放弃且旧索引保留', async () => {
    const paths = makeRoot({ 'svc.py': 'class Svc:\n    def m(self):\n        pass\n' });
    pointWorkspaceAt(rootDirOf(paths['svc.py']));
    stubFindFiles(pattern => {
      if (pattern.includes('*.py')) { return [paths['svc.py']]; }
      return [];
    });
    setJumpLogEnabled(true);
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    await index.waitForInitialScan();
    expect(await index.findClassesByName('Svc')).toHaveLength(1);
    // 解析通道拒绝:装载不提交 → 登记待补(旧索引保留)
    parseState.impl = async () => { throw new Error('worker down'); };
    expect(await internals.loadFile(paths['svc.py'], -1)).toBe(false);
    expect(internals.pendingScanRetries.has(paths['svc.py'])).toBe(true);
    // 查询驱动定向重试:每次提交失败推进计数,满 3 次放弃不再无限重试
    const deadline = Date.now() + 4000;
    while (internals.pendingScanRetries.size > 0 && Date.now() < deadline) {
      await index.findClassesByName('Svc');
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    expect(internals.pendingScanRetries.size).toBe(0);
    expect(getRecentJumpLogs().some(line => line.includes('放弃'))).toBe(true);
    // 重试与放弃期间旧类索引保留:跳转不落空
    expect(await index.findClassesByName('Svc')).toHaveLength(1);
  }, 10000);

  it('removeRoot:定向摘除组合根内容缓存,返回摘除的 py 文件数', async () => {
    const paths = makeRoot(ASSET_FILES);
    pointWorkspaceAt(rootDirOf(paths['Avatar.py']));
    stubFindFiles(assetRouting(paths));
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    await index.rootsContaining('Avatar');
    expect(internals.rootsContentCache.size).toBe(3);
    expect(index.removeRoot(rootDirOf(paths['Avatar.py']))).toBe(2);
    expect(internals.rootsContentCache.size).toBe(0);
  });

  it('removeRoot:在途 staged 请求与待补重试登记一并摘除', async () => {
    const paths = makeRoot({
      'a.py': 'class A:\n    pass\n',
      'b.py': 'class B:\n    pass\n',
      'c.py': 'x = 1\n'
    });
    const root = rootDirOf(paths['a.py']);
    pointWorkspaceAt(root);
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    index.syncDocumentParse(pyDoc(paths['a.py'], 'class A:\n    pass\n', 1));
    // 解析通道拒绝:b.py 装载失败 → 登记待补重试
    parseState.impl = async () => { throw new Error('worker down'); };
    expect(await internals.loadFile(paths['b.py'], -1)).toBe(false);
    expect(internals.pendingScanRetries.has(paths['b.py'])).toBe(true);
    // c.py 在途单文件任务:入队即挂 staged(未完成)
    const pendingFind = index.findEnclosingClass(paths['c.py'], 0);
    expect(internals.stagedRequests.has(paths['c.py'])).toBe(true);
    expect(index.removeRoot(root)).toBe(1);
    expect(internals.stagedRequests.has(paths['c.py'])).toBe(false);
    expect(internals.pendingScanRetries.has(paths['b.py'])).toBe(false);
    // 被摘除的任务照常跑完(解析仍失败 → null),不悬挂
    expect(await pendingFind).toBeNull();
  });

  it('asyncDocumentParse:解析失败返回 null,登记待补且旧版本解析保留', async () => {
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    const file = '/ghost/svc.py';
    index.syncDocumentParse(pyDoc(file, 'class Svc:\n    pass\n', 1));
    parseState.impl = async () => { throw new Error('worker down'); };
    expect(await index.asyncDocumentParse(pyDoc(file, 'class Svc:\n    def m(self):\n        pass\n', 2))).toBeNull();
    expect(internals.pendingScanRetries.has(file)).toBe(true);
    expect(index.getParsedForVersion(file, 1)).not.toBeNull();
  });

  it('resolveClassBase:请求文件解析失败 → 按落空降级,不升级全仓', async () => {
    const paths = makeRoot({ 'query.py': 'class Query:\n    pass\n' });
    pointWorkspaceAt(rootDirOf(paths['query.py']));
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    parseState.impl = async () => { throw new Error('worker down'); };
    const resolved = await index.resolveClassBase(fullDoc(paths['query.py'], 'class Query:\n    pass\n', 1), 'Unknown');
    expect(resolved).toBeNull();
    expect(internals.fileCache.has(paths['query.py'])).toBe(false);
    expect(internals.pendingScanRetries.has(paths['query.py'])).toBe(true);
  });

  it('findEnclosingClass:不可读文件 → null;读失败不登记待补(与解析失败分流)', async () => {
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    const ghost = '/nonexistent/dir/ghost.py';
    expect(await index.findEnclosingClass(ghost, 0)).toBeNull();
    // 读失败=文件不存在:与解析失败分流,不进待补重试表
    expect(internals.pendingScanRetries.has(ghost)).toBe(false);
  });

  it('findEnclosingClass/resolveSelfMethodResolution:文件无类 → null 与空集(带日志)', async () => {
    const paths = makeRoot({ 'plain.py': 'x = 1\n' });
    pointWorkspaceAt(rootDirOf(paths['plain.py']));
    setJumpLogEnabled(true);
    const index = new PythonClassIndex();
    expect(await index.findEnclosingClass(paths['plain.py'], 0)).toBeNull();
    const resolution = await index.resolveSelfMethodResolution(paths['plain.py'], 0, 'anything');
    expect(resolution).toEqual({ candidates: [], partial: false });
    expect(getRecentJumpLogs().some(line => line.includes('光标不在任何类内'))).toBe(true);
  });

  it('组合根等待超预算:已命中的静态 MRO 目标照常返回并标 partial', async () => {
    const paths = makeRoot({
      'a.py': 'class Alpha:\n\tdef meth(self):\n\t\tpass\n',
      'b.py': 'class Beta(Alpha):\n\tdef run(self):\n\t\tself.meth()\n'
    });
    pointWorkspaceAt(rootDirOf(paths['a.py']));
    // 元数据 glob 永不返回(组合根永远派生不完),py 发现照常
    const never = new Promise<never>(() => undefined);
    stubWorkspace.findFiles = (async (pattern?: unknown) => {
      if (String(pattern ?? '').includes('*.py')) {
        return [Uri.file(paths['a.py']), Uri.file(paths['b.py'])];
      }
      return never;
    }) as typeof stubWorkspace.findFiles;
    setJumpLogEnabled(true);
    const index = new PythonClassIndex();
    const resolution = await index.resolveSelfMethodResolution(paths['b.py'], 2, 'meth', undefined, undefined, 20);
    expect(resolution.partial).toBe(true);
    expect(resolution.candidates).toHaveLength(1);
    expect(resolution.candidates[0].className).toBe('Alpha');
    expect(getRecentJumpLogs().some(line => line.includes('组合根等待超时') && line.includes('先返回已命中'))).toBe(true);
  });

  it('反向后代:基类行查子类实现,命中并落 ③ 日志', async () => {
    const paths = makeRoot({
      'base.py': 'class Base:\n    pass\n',
      'child.py': 'class Child(Base):\n    def meth(self):\n        pass\n'
    });
    pointWorkspaceAt(rootDirOf(paths['base.py']));
    stubFindFiles(pattern => {
      if (pattern.includes('*.py')) { return [paths['base.py'], paths['child.py']]; }
      return [];
    });
    setJumpLogEnabled(true);
    const index = new PythonClassIndex();
    const hit = await index.resolveSelfMethod(paths['base.py'], 0, 'meth');
    expect(hit?.className).toBe('Child');
    expect(hit?.filePath).toBe(paths['child.py']);
    expect(getRecentJumpLogs().some(line => line.includes('反向后代'))).toBe(true);
  });

  it('descendantsOf:传递闭包含直接与间接子类,叶类无后代', async () => {
    const paths = makeRoot({
      'base.py': 'class Base:\n    pass\n',
      'mid.py': 'class Mid(Base):\n    pass\n',
      'leaf.py': 'class Leaf(Mid):\n    pass\n'
    });
    pointWorkspaceAt(rootDirOf(paths['base.py']));
    stubFindFiles(pattern => {
      if (pattern.includes('*.py')) { return [paths['base.py'], paths['mid.py'], paths['leaf.py']]; }
      return [];
    });
    const index = new PythonClassIndex();
    expect((await index.descendantsOf('Base')).map(cls => cls.name).sort()).toEqual(['Leaf', 'Mid']);
    expect(await index.descendantsOf('Leaf')).toEqual([]);
    expect(await index.descendantsOf('Nope')).toEqual([]);
  });

  it('mixinsProvidingTo:MRO 去掉自身,只留提供方', async () => {
    const paths = makeRoot({
      'base.py': 'class Base:\n    pass\n',
      'child.py': 'class Child(Base):\n    pass\n'
    });
    pointWorkspaceAt(rootDirOf(paths['base.py']));
    stubFindFiles(pattern => {
      if (pattern.includes('*.py')) { return [paths['base.py'], paths['child.py']]; }
      return [];
    });
    const index = new PythonClassIndex();
    expect(await index.mixinsProvidingTo('Child')).toEqual(['Base']);
    expect(await index.mixinsProvidingTo('Nope')).toEqual([]);
  });

  it('displayPath:工作区内相对化(正斜杠),区外原样', () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws/proj'), name: 'proj', index: 0 }];
    expect(displayPath('/ws/proj/scripts/a.py')).toBe('scripts/a.py');
    stubWorkspace.workspaceFolders = [];
    expect(displayPath('/elsewhere/a.py')).toBe('/elsewhere/a.py');
  });

  it('ensureDiscovered 同代缓存命中:发现后分块入队即败,重扫复用已发现列表(972)', async () => {
    const paths = makeRoot({ 'a.py': 'class A:\n    pass\n' });
    pointWorkspaceAt(rootDirOf(paths['a.py']));
    stubFindFiles(pattern => (String(pattern).includes('*.py') ? [paths['a.py']] : []));
    // 发现任务(initial-scan)放行,分块解析任务(full-reindex)同步抛:
    // 第一次扫描在发现成功后于入队处失败 → 完成代不记账,scanPromise 清空。
    class ThrowChunkScheduler extends IndexScheduler {
      override enqueue(spec: IndexTaskSpec): IndexTaskHandle {
        if (spec.kind === 'full-reindex') { throw new Error('chunk enqueue boom'); }
        return super.enqueue(spec);
      }
    }
    const index = new PythonClassIndex(new ThrowChunkScheduler());
    const internals = asInternals(index);
    // 第一次:发现成功(discoveredFiles 落号),扫描失败(重抛被 ensureScanned 吞掉)
    await index.waitForInitialScan();
    expect(internals.discoveredFiles).not.toBeNull();
    // 第二次:同代重扫 → ensureDiscovered 命中已发现列表缓存(972)
    await index.waitForInitialScan();
    expect((internals.discoveredFiles ?? []).map(uri => uri.fsPath)).toContain(paths['a.py']);
  });

  it('loadFileOnDemand 在途合并:同文件并发请求复用同一 pending(995)', async () => {
    const paths = makeRoot({ 'x.py': 'class X:\n    pass\n' });
    pointWorkspaceAt(rootDirOf(paths['x.py']));
    const index = new PythonClassIndex();
    const internals = asInternals(index);
    // 同步连发两次(无 await 间隔):第一次入队即挂 staged,第二次命中 pending 合并
    const first = index.findEnclosingClass(paths['x.py'], 0);
    const second = index.findEnclosingClass(paths['x.py'], 0);
    expect(internals.stagedRequests.has(paths['x.py'])).toBe(true);
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1?.name).toBe('X');
    expect(r2?.name).toBe('X');
  });

  it('stageClassNameFiles 发现拒绝:按落空降级,不升级不抛(1073)', async () => {
    const paths = makeRoot({ 'q.py': 'class Q:\n    pass\n' });
    pointWorkspaceAt(rootDirOf(paths['q.py']));
    // 类名同名 glob(**/Ghost.py)拒绝;全量 py 发现照常返回
    stubFindFiles(pattern => {
      const glob = String(pattern).replace(/\*\*\//, '');
      if (glob === 'Ghost.py') { throw new Error('discovery boom'); }
      return glob.includes('*.py') ? [paths['q.py']] : [];
    });
    const index = new PythonClassIndex();
    // Ghost 不在查询文件 q.py 中 → 定点补载同类名 glob → 拒绝 → 按落空返回 null
    const resolved = await index.resolveClassBase(fullDoc(paths['q.py'], 'class Q:\n    pass\n', 1), 'Ghost');
    expect(resolved).toBeNull();
  });
});

// ---- quickActions ----

describe('quickActions 覆盖补齐', () => {
  it('terminalScript:后台启动失败 → stderr 带原因、submitted:false、流水落 error', async () => {
    const { hub, lines } = makeRecordingHub();
    const runner = (): never => { throw new Error('spawn ENOENT'); };
    setDefaultScriptRuntime(new ProcessManager(runner as unknown as ProcessSpawnRunner, hub), hub);
    const result = await terminalScript({ name: 'bg', script: 'echo hi', background: true });
    expect(result).toEqual({ code: null, stdout: '', stderr: 'spawn ENOENT', submitted: false });
    expect(lines.some(line => line.text === 'spawn ENOENT' && line.component === 'bg')).toBe(true);
  });

  it('terminalHttp:真实回环 2xx 走 info 流水,非 2xx 走 error 流水;URL 无法解析抛出', async () => {
    const { hub, lines } = makeRecordingHub();
    const server = http.createServer((req, res) => {
      if (req.url === '/fail') {
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    httpServers.push(server);
    setDefaultScriptRuntime(new ProcessManager(undefined, undefined), hub);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await terminalHttp({ name: 'reload', method: 'POST', url: `${base}/reload`, body: 'x' });
    expect(lines.some(line => line.text.includes('→ 200') && line.component === 'http:reload')).toBe(true);
    await terminalHttp({ name: 'broken', method: 'GET', url: `${base}/fail` });
    expect(lines.some(line => line.text.includes('→ 500') && line.component === 'http:broken')).toBe(true);
    await expect(terminalHttp({ name: 'bad', method: 'GET', url: 'not a url' })).rejects.toThrow('URL 无法解析');
  });

  it('getTreeActions:非法变量动作回退原始目标(执行路径再报错)', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    setConfig({
      quickActions: [
        { name: 'bad', type: 'script', script: '${nosuchvar}/run.bat', background: false, confirm: true, source: 'manual' }
      ]
    });
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const rows = await manager.getTreeActions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'bad', type: 'script', target: '${nosuchvar}/run.bat' });
  });

  it('scanScriptsAndRefresh:无工作区根 → 提示而不抛', async () => {
    stubWorkspace.workspaceFolders = [];
    const manager = new QuickActionManager(makeContext(), makeDeps());
    await manager.scanScriptsAndRefresh();
    expect(messages.info.some(message => message.includes('无法扫描快速动作'))).toBe(true);
  });

  it('scanScriptsAndRefresh:脚本已消失 → 清除过期扫描动作,保留手工动作', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    setConfig({
      quickActions: [
        { name: 'old', type: 'script', script: '${workspaceFolder}/old.bat', background: false, confirm: true, source: 'scan' },
        { name: 'keep', type: 'command', command: 'kode.refresh', args: [], confirm: false, source: 'manual' }
      ]
    });
    memoryFileSystem.setDirectory('/ws', [['notes.txt', 1]]);
    const manager = new QuickActionManager(makeContext(), makeDeps());
    await manager.scanScriptsAndRefresh();
    expect(messages.info.some(message => message.includes('已清除 1 个过期扫描动作') && message.includes('保留 1 个手工动作'))).toBe(true);
    const written = readConfig();
    expect(written?.quickActions?.map(action => action.name)).toEqual(['keep']);
    expect(written?.quickActions?.[0]?.source).toBe('manual');
  });

  it('runScannedScript:登记确认后回写扫描形态动作到 debug.json', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    memoryFileSystem.setDirectory('/ws', [['cleanup.bat', 1]]);
    // 确认框脚本化应答「登记」;普通信息提示走默认实现入账 messages.info
    windowish.showInformationMessage = async (message: string, ...rest: unknown[]) => {
      if (rest.length === 0) {
        return (originalShowInfo as (m: string) => Promise<undefined>)(message);
      }
      return rest.includes('登记') ? '登记' : undefined;
    };
    const manager = new QuickActionManager(makeContext(), makeDeps());
    expect(await manager.runScannedScript('/ws/cleanup.bat')).toBe(true);
    expect(scriptRuns).toHaveLength(1);
    await waitFor(() => Boolean(readConfig()?.quickActions?.length));
    const written = readConfig();
    expect(written?.quickActions).toEqual([
      {
        name: 'cleanup',
        type: 'script',
        script: '${workspaceFolder}/cleanup.bat',
        cwd: '${workspaceFolder}',
        background: false,
        confirm: true,
        source: 'scan'
      }
    ]);
    expect(messages.info.some(message => message.includes('已登记「cleanup.bat」'))).toBe(true);
  });

  it('旧数字选择器 @http:0 走 debug 清单;缺口索引 false', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    setConfig({ httpRequests: [{ name: 'reload', method: 'POST', url: 'http://127.0.0.1:9/reload' }] });
    const entries: unknown[] = [];
    const manager = new QuickActionManager(makeContext(), {
      ...makeDeps(),
      runHttpEntry: async entry => {
        entries.push(entry);
        return true;
      }
    });
    expect(await manager.runByName('@http:0')).toBe(true);
    expect(entries).toEqual([
      { name: 'reload', url: 'http://127.0.0.1:9/reload', method: 'POST', headers: {}, body: '', enabled: true, keybinding: '' }
    ]);
    expect(await manager.runByName('@http:debug:9')).toBe(false);
  });

  it('无 runHttpEntry 注入:HTTP 动作回落真实 terminalHttp(本地回环真请求)', async () => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(String(req.url));
      res.statusCode = 200;
      res.end('pong');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    httpServers.push(server);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    setConfig({
      httpRequests: [
        { name: 'ping', method: 'GET', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ping` }
      ]
    });
    const manager = new QuickActionManager(makeContext(), makeDeps());
    expect(await manager.runByName('@http:debug:0')).toBe(true);
    expect(requests).toEqual(['/ping']);
  });

  it('HTTP 动作变量无法解析:报错返回 false,不发请求', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    setConfig({ httpRequests: [{ name: 'broken', method: 'GET', url: 'http://x/${missing}' }] });
    const manager = new QuickActionManager(makeContext(), makeDeps());
    expect(await manager.runByName('@http:debug:0')).toBe(false);
    expect(messages.error.some(message => message.includes('变量无法解析'))).toBe(true);
  });

  it('venv 启用但目录不存在:报错中止,不启动脚本', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const manager = new QuickActionManager(makeContext(), makeDeps());
    const run = (manager as unknown as { run: (action: unknown, options?: unknown) => Promise<boolean> }).run.bind(manager);
    const ok = await run({
      name: 'task',
      type: 'script',
      script: '/ws/task.bat',
      background: false,
      confirm: false,
      source: 'manual',
      venv: { enabled: true }
    });
    expect(ok).toBe(false);
    expect(scriptRuns).toHaveLength(0);
    expect(messages.error.some(message => message.includes('找不到虚拟环境目录'))).toBe(true);
  });
});
