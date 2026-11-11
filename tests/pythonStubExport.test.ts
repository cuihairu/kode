import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  KBENGINE_STUB_TEMPLATE_RELATIVE_ROOT,
  KBE_STUB_FILE_NAME,
  KBE_STUB_GENERATED_MARKER,
  PYTHON_STUB_EXPORT_ENABLED_DEFAULT,
  collectKbengineStubTemplateFiles,
  exportKbeStubs,
  kbeStubDir,
  kbeStubFilePath,
  kbeStubPackageInitPath,
  resetKbeStubs,
  resolveKbengineStubTemplateRoot,
  type StubExportDeps
} from '../src/pythonStubExport';
import {
  configurationOverrides,
  messages,
  Uri,
  windowState,
  workspace as stubWorkspace,
  workspaceState
} from './helpers/vscodeStub';

// 批 ③(用户令 2026-11-11 静态模板定案):插件内置模板(顶层 typings/,
// 派生自 fork typings)copy-if-absent 复制到存根目录。铁律=零覆盖:目标
// 已存在一个字节不动,覆盖只走显式 reset 且要用户确认。模板侧用真 tmpdir
// (collect 走真 fs 判目录),项目侧全内存注入,不碰真盘。

// ── 模板夹具(真 tmpdir;形状对齐内置 typings/ 的最小子集)──────────
const makeTemplateRoot = (): string => {
  const root = mkdtempSync(join(os.tmpdir(), 'kode-stub-template-'));
  mkdirSync(join(root, 'KBEngine'), { recursive: true });
  writeFileSync(join(root, 'KBEngine', '__init__.pyi'), '# init\nfrom .Entity import Entity\n');
  writeFileSync(join(root, 'KBEngine', 'Entity.pyi'), '# entity template\nclass Entity:\n    id: int\n');
  writeFileSync(join(root, 'KBEngine', 'Proxy.pyi'), '# proxy template\nclass Proxy(Entity):\n    __ACCOUNT_NAME__: str\n');
  writeFileSync(join(root, 'README.md'), '# author metadata, never copied\n');
  return root;
};

const templateRealDeps = (templateRoot: string): Pick<StubExportDeps, 'exists' | 'readFile' | 'listDir'> => ({
  exists: (candidate: string): boolean => candidate.startsWith(templateRoot) || memory.has(candidate),
  readFile: (candidate: string): string => {
    if (candidate.startsWith(templateRoot)) {
      return readFileSync(candidate, 'utf8');
    }
    const content = memory.get(candidate);
    if (content === undefined) {
      throw new Error(`ENOENT: ${candidate}`);
    }
    return content;
  },
  listDir: (dir: string): string[] => readdirSync(dir)
});

// ── 项目侧内存 fs ────────────────────────────────────────────────
const memory = new Map<string, string>();
let writes: Array<{ path: string; content: string }> = [];
let mkdirs: string[] = [];
let deleted: string[] = [];
let writeFailFor = new Set<string>();
let readFailFor = new Set<string>();

const makeDeps = (templateRoot?: string): StubExportDeps => {
  const real = templateRoot ? templateRealDeps(templateRoot) : undefined;
  return {
    exists: (candidate: string): boolean => real?.exists(candidate) ?? memory.has(candidate),
    readFile: (candidate: string): string => {
      if (readFailFor.has(candidate)) {
        throw new Error('EACCES');
      }
      if (real && candidate.startsWith(templateRoot!)) {
        return real.readFile(candidate);
      }
      const content = memory.get(candidate);
      if (content === undefined) {
        throw new Error(`ENOENT: ${candidate}`);
      }
      return content;
    },
    writeFile: (candidate: string, content: string): void => {
      if (writeFailFor.has(candidate)) {
        throw new Error('EROFS');
      }
      writes.push({ path: candidate, content });
      memory.set(candidate, content);
    },
    mkdir: (dir: string): void => {
      mkdirs.push(dir);
    },
    deleteFile: (candidate: string): void => {
      deleted.push(candidate);
      memory.delete(candidate);
    },
    listDir: (dir: string): string[] => real ? real.listDir(dir) : readdirSync(dir)
  };
};

const folder = (fsPath: string): vscode.WorkspaceFolder =>
  ({ uri: Uri.file(fsPath), name: fsPath.split('/').pop() ?? fsPath, index: 0 }) as vscode.WorkspaceFolder;

beforeEach(() => {
  memory.clear();
  writes = [];
  mkdirs = [];
  deleted = [];
  writeFailFor = new Set();
  readFailFor = new Set();
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;
  windowState.reset();
  workspaceState.reset();
  configurationOverrides.clear();
  stubWorkspace.workspaceFolders = [];
});

describe('存根路径面(kbeStubDir/kbeStubFilePath/kbeStubPackageInitPath)', () => {
  it('落在托管目录 stubs 约定下,桩包入口 KBEngine/__init__.pyi', () => {
    expect(kbeStubDir('/ws')).toBe('/ws/.kbengine/stubs');
    expect(kbeStubFilePath('/ws')).toBe('/ws/.kbengine/stubs/KBEngine.pyi');
    expect(kbeStubPackageInitPath('/ws')).toBe('/ws/.kbengine/stubs/KBEngine/__init__.pyi');
    expect(kbeStubPackageInitPath('/ws', 'mykb')).toBe('/ws/mykb/stubs/KBEngine/__init__.pyi');
  });

  it('迁移判定标记与模板相对根常量', () => {
    expect(KBE_STUB_FILE_NAME).toBe('KBEngine.pyi');
    expect(KBE_STUB_GENERATED_MARKER).toBe('# KBEngine.pyi — kode generated');
    expect(KBENGINE_STUB_TEMPLATE_RELATIVE_ROOT).toBe('typings');
    expect(resolveKbengineStubTemplateRoot('/ext')).toBe('/ext/typings');
  });
});

describe('collectKbengineStubTemplateFiles(内置模板清单)', () => {
  it('递归收集 .pyi,相对路径正斜杠排序,README.md 不进项目', () => {
    const root = makeTemplateRoot();
    try {
      const files = collectKbengineStubTemplateFiles(root, templateRealDeps(root) as StubExportDeps);
      expect(files).not.toBeNull();
      expect(files!.map(file => file.relativePath)).toEqual([
        'KBEngine/Entity.pyi',
        'KBEngine/Proxy.pyi',
        'KBEngine/__init__.pyi'
      ]);
      expect(files!.find(file => file.relativePath === 'KBEngine/Entity.pyi')?.content).toContain('# entity template');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('模板根缺失或无 .pyi 时返回 null(调用方如实告警)', () => {
    expect(collectKbengineStubTemplateFiles('/definitely/missing', templateRealDeps('/definitely/missing') as StubExportDeps)).toBeNull();
    const root = makeTemplateRoot();
    try {
      rmSync(join(root, 'KBEngine'), { recursive: true, force: true });
      expect(collectKbengineStubTemplateFiles(root, templateRealDeps(root) as StubExportDeps)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('exportKbeStubs(copy-if-absent 复制)', () => {
  it('默认设置为开', () => {
    expect(PYTHON_STUB_EXPORT_ENABLED_DEFAULT).toBe(true);
  });

  it('设置关闭时说明返回,不写任何文件;静默模式零提示', async () => {
    configurationOverrides.set('kbengine', { 'python.stubExport': false });
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const root = makeTemplateRoot();
    try {
      const deps = makeDeps(root);
      await exportKbeStubs(deps, { templateRoot: root });
      expect(messages.info[0]).toContain('已关闭');
      expect(writes).toHaveLength(0);

      await exportKbeStubs(deps, { templateRoot: root, silent: true });
      expect(messages.info).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('未打开工作区时如实说明', async () => {
    const root = makeTemplateRoot();
    try {
      await exportKbeStubs(makeDeps(root), { templateRoot: root });
      expect(messages.info[0]).toContain('未打开工作区');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('模板根缺失时告警跳过,不写任何文件', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    await exportKbeStubs(makeDeps(), { templateRoot: '/definitely/missing' });
    expect(messages.warning[0]).toContain('模板读不到');
    expect(writes).toHaveLength(0);
  });

  it('首次复制:模板全部 .pyi 落桩包目录,README 不复制,播报文件夹', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const root = makeTemplateRoot();
    try {
      await exportKbeStubs(makeDeps(root), { templateRoot: root });

      const writtenPaths = writes.map(write => write.path);
      expect(writtenPaths).toEqual([
        '/ws/.kbengine/stubs/KBEngine/Entity.pyi',
        '/ws/.kbengine/stubs/KBEngine/Proxy.pyi',
        '/ws/.kbengine/stubs/KBEngine/__init__.pyi'
      ]);
      expect(mkdirs).toContain('/ws/.kbengine/stubs/KBEngine');
      expect(messages.info[0]).toContain('ws');
      expect(messages.info[0]).toContain('copy-if-absent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('copy-if-absent 铁律:目标已存在零字节动(用户魔改保留),缺的补上', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const root = makeTemplateRoot();
    memory.set('/ws/.kbengine/stubs/KBEngine/Entity.pyi', '# 用户魔改版 Entity\n');
    try {
      await exportKbeStubs(makeDeps(root), { templateRoot: root });

      expect(writes.map(write => write.path)).toEqual([
        '/ws/.kbengine/stubs/KBEngine/Proxy.pyi',
        '/ws/.kbengine/stubs/KBEngine/__init__.pyi'
      ]);
      expect(memory.get('/ws/.kbengine/stubs/KBEngine/Entity.pyi')).toBe('# 用户魔改版 Entity\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('托管目录旧产物迁移:带 kode 生成标记的 KBEngine.pyi 移除', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const root = makeTemplateRoot();
    memory.set(
      '/ws/.kbengine/stubs/KBEngine.pyi',
      `${KBE_STUB_GENERATED_MARKER}\n# 旧动态生成内容\n`
    );
    try {
      await exportKbeStubs(makeDeps(root), { templateRoot: root });

      expect(deleted).toEqual(['/ws/.kbengine/stubs/KBEngine.pyi']);
      expect(messages.info.some(line => line.includes('旧生成物'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('无标记的同名 KBEngine.pyi 是用户资产,一字节不动', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const root = makeTemplateRoot();
    memory.set('/ws/.kbengine/stubs/KBEngine.pyi', '# 用户手写,无 kode 标记\n');
    try {
      await exportKbeStubs(makeDeps(root), { templateRoot: root });

      expect(deleted).toHaveLength(0);
      expect(memory.get('/ws/.kbengine/stubs/KBEngine.pyi')).toBe('# 用户手写,无 kode 标记\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('用户目录(python.stubDir)不迁移:同名文件即使带标记也不碰', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    configurationOverrides.set('kbengine', { 'python.stubDir': '/user-stubs' });
    const root = makeTemplateRoot();
    memory.set('/user-stubs/KBEngine.pyi', `${KBE_STUB_GENERATED_MARKER}\n# 用户目录里的旧文件\n`);
    try {
      await exportKbeStubs(makeDeps(root), { templateRoot: root });

      expect(deleted).toHaveLength(0);
      expect(memory.get('/user-stubs/KBEngine.pyi')).toContain('用户目录里的旧文件');
      expect(writes.every(write => write.path.startsWith('/user-stubs/'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('目录不可写时告警并继续,不影响其他文件夹', async () => {
    stubWorkspace.workspaceFolders = [folder('/ro'), folder('/ok')];
    const root = makeTemplateRoot();
    writeFailFor = new Set(['/ro/.kbengine/stubs/KBEngine/Entity.pyi']);
    try {
      await exportKbeStubs(makeDeps(root), { templateRoot: root });

      expect(messages.warning[0]).toContain('ro');
      expect(messages.info[0]).toContain('ok');
      expect(memory.has('/ok/.kbengine/stubs/KBEngine/Entity.pyi')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('静默模式:全程零提示,复制照做', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const root = makeTemplateRoot();
    try {
      await exportKbeStubs(makeDeps(root), { templateRoot: root, silent: true });

      expect(writes).toHaveLength(3);
      expect(messages.info).toHaveLength(0);
      expect(messages.warning).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resetKbeStubs(显式重置,唯一覆盖通道)', () => {
  it('确认弹窗取消=零动作', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const root = makeTemplateRoot();
    memory.set('/ws/.kbengine/stubs/KBEngine/Entity.pyi', '# 用户魔改版\n');
    const original = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = (async (): Promise<undefined> => undefined) as typeof original;
    try {
      await resetKbeStubs(makeDeps(root), { templateRoot: root });

      expect(deleted).toHaveLength(0);
      expect(writes).toHaveLength(0);
      expect(memory.get('/ws/.kbengine/stubs/KBEngine/Entity.pyi')).toBe('# 用户魔改版\n');
    } finally {
      vscode.window.showWarningMessage = original;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('确认重置:模板集同名文件删后按模板重复制,模板外文件与用户资产不动', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const root = makeTemplateRoot();
    memory.set('/ws/.kbengine/stubs/KBEngine/Entity.pyi', '# 用户魔改版\n');
    memory.set('/ws/.kbengine/stubs/KBEngine/unknown_extra.pyi', '# 模板集之外\n');
    memory.set('/ws/.kbengine/stubs/KBEngine.pyi', `${KBE_STUB_GENERATED_MARKER}\n# 旧生成物\n`);
    const original = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = (async (): Promise<string> => '重置') as typeof original;
    try {
      await resetKbeStubs(makeDeps(root), { templateRoot: root });

      // 模板集同名文件:删后重建
      expect(deleted).toContain('/ws/.kbengine/stubs/KBEngine/Entity.pyi');
      expect(memory.get('/ws/.kbengine/stubs/KBEngine/Entity.pyi')).toContain('# entity template');
      // 模板集之外:不碰
      expect(deleted).not.toContain('/ws/.kbengine/stubs/KBEngine/unknown_extra.pyi');
      expect(memory.get('/ws/.kbengine/stubs/KBEngine/unknown_extra.pyi')).toBe('# 模板集之外\n');
      // 旧生成物:回收且不再重建
      expect(deleted).toContain('/ws/.kbengine/stubs/KBEngine.pyi');
      expect(memory.has('/ws/.kbengine/stubs/KBEngine.pyi')).toBe(false);
      expect(messages.info[0]).toContain('重置');
    } finally {
      vscode.window.showWarningMessage = original;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
