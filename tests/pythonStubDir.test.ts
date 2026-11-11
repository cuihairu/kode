/**
 * `.pyi` 存根目录用户可配(批142,任务单 kode-pyi.md 用户令:「.pyi 目录也应该
 * 用户配置吧,不配置才默认生成,配置了就扫描」):三级来源(设置 > 环境变量 >
 * 默认约定)、VS Code 变量替换,全部走批141 的统一替换实现。批 ③ 静态模板
 * 定案后导出面是 copy-if-absent 复制:配置的目录(用户所有)同样按模板集
 * 复制,已有文件一律不覆盖;旧产物迁移只发生在 kode 自管的托管目录。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PYTHON_STUB_DIR_DEFAULT,
  PYTHON_STUB_DIR_ENV,
  KBE_STUB_GENERATED_MARKER,
  exportKbeStubs,
  fileSystemStubExportDeps,
  readStubDirSetting,
  resolveStubDir,
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

const ROOT = '/ws/main';

describe('resolveStubDir 默认来源', () => {
  it('未配置时落默认约定目录 .kbengine/stubs,标为 kode 自管', () => {
    const resolved = resolveStubDir(ROOT, {});
    expect(resolved.dir).toBe('/ws/main/.kbengine/stubs');
    expect(resolved.source).toBe('default');
    expect(resolved.origin).toBe(PYTHON_STUB_DIR_DEFAULT);
    expect(resolved.userOwned).toBe(false);
    expect(resolved.raw).toBeNull();
  });

  it('设置里的空串不算配置,仍走默认约定', () => {
    expect(resolveStubDir(ROOT, { setting: '   ' }).source).toBe('default');
  });

  it('设置值非字符串时按未配置处理,不把对象拼成路径', () => {
    expect(resolveStubDir(ROOT, { setting: { a: 1 } }).source).toBe('default');
    expect(resolveStubDir(ROOT, { setting: 42 }).source).toBe('default');
  });
});

describe('resolveStubDir 设置与环境变量优先级', () => {
  it('设置生效时以设置为准,目录属用户所有', () => {
    const resolved = resolveStubDir(ROOT, { setting: 'typings/stubs' });
    expect(resolved.dir).toBe('/ws/main/typings/stubs');
    expect(resolved.source).toBe('setting');
    expect(resolved.userOwned).toBe(true);
    expect(resolved.raw).toBe('typings/stubs');
  });

  it('环境变量在设置未配时接管', () => {
    const resolved = resolveStubDir(ROOT, {
      env: { [PYTHON_STUB_DIR_ENV]: '/abs/typings' }
    });
    expect(resolved.dir).toBe('/abs/typings');
    expect(resolved.source).toBe('env');
    expect(resolved.userOwned).toBe(true);
  });

  it('设置与环境变量同时存在时设置覆盖环境变量', () => {
    const resolved = resolveStubDir(ROOT, {
      setting: 'from-setting',
      env: { [PYTHON_STUB_DIR_ENV]: '/from-env' }
    });
    expect(resolved.dir).toBe('/ws/main/from-setting');
    expect(resolved.source).toBe('setting');
  });

  it('环境变量为空串按未配处理', () => {
    expect(resolveStubDir(ROOT, { env: { [PYTHON_STUB_DIR_ENV]: '' } }).source).toBe('default');
  });

  it('环境变量两侧空白被裁掉', () => {
    const resolved = resolveStubDir(ROOT, {
      env: { [PYTHON_STUB_DIR_ENV]: '  typings  ' }
    });
    expect(resolved.dir).toBe('/ws/main/typings');
  });
});

describe('resolveStubDir 路径形态', () => {
  it('相对路径按工作区根解析', () => {
    expect(resolveStubDir(ROOT, { setting: 'typings/stubs' }).dir).toBe('/ws/main/typings/stubs');
  });

  it('绝对路径原样采用,不与工作区根拼接', () => {
    expect(resolveStubDir(ROOT, { setting: '/opt/typings' }).dir).toBe('/opt/typings');
  });

  it('尾部斜杠被裁掉,避免拼出双斜杠', () => {
    expect(resolveStubDir(ROOT, { setting: 'typings/' }).dir).toBe('/ws/main/typings');
  });

  it('展开 VS Code 变量(与 debug.json 同一套替换机制)', () => {
    const resolved = resolveStubDir(ROOT, {
      setting: '${workspaceFolder}/typings',
      folders: [{ fsPath: ROOT, name: 'main' }]
    });
    expect(resolved.dir).toBe('/ws/main/typings');
  });

  it('展开环境变量后再判定绝对性', () => {
    const resolved = resolveStubDir(ROOT, {
      setting: '${env:KODE_PYI_DIR}',
      env: { KODE_PYI_DIR: '/from/env/typings' }
    });
    expect(resolved.dir).toBe('/from/env/typings');
    expect(resolved.source).toBe('setting');
  });

  it('变量替换后为空串时如实落空目录,不偷偷回落默认目录', () => {
    const resolved = resolveStubDir(ROOT, { setting: '${env:KODE_ABSENT_DIR}/x' });
    expect(resolved.dir).toBe('/x');
    expect(resolved.source).toBe('setting');
  });

  it('windows 盘符路径不被当作相对路径拼接', () => {
    const resolved = resolveStubDir(ROOT, { setting: 'C:\\work\\typings' });
    expect(resolved.dir).toBe('C:\\work\\typings');
  });

  it('盘符路径写成正斜杠同样按绝对路径处理', () => {
    expect(resolveStubDir(ROOT, { setting: 'C:/work/typings' }).dir).toBe('C:/work/typings');
  });
});

// ── 模板夹具(真 tmpdir:collect 走真 fs 判目录;项目侧全内存)──────
const memory = new Map<string, string>();
let writes: string[] = [];
let deleted: string[] = [];

const makeTemplateRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'kode-stubdir-template-'));
  mkdirSync(join(root, 'KBEngine'), { recursive: true });
  writeFileSync(join(root, 'KBEngine', '__init__.pyi'), '# init\n');
  writeFileSync(join(root, 'KBEngine', 'Entity.pyi'), '# entity\n');
  return root;
};

const makeDeps = (templateRoot: string): StubExportDeps => ({
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
  writeFile: (candidate: string, content: string): void => {
    writes.push(candidate);
    memory.set(candidate, content);
  },
  mkdir: (): void => undefined,
  deleteFile: (candidate: string): void => {
    deleted.push(candidate);
    memory.delete(candidate);
  },
  listDir: (dir: string): string[] => (dir.startsWith(templateRoot) ? readdirSync(dir) : [])
});

const folder = (fsPath: string): vscode.WorkspaceFolder =>
  ({
    uri: Uri.file(fsPath),
    name: fsPath.split('/').pop() ?? fsPath,
    index: 0
  }) as vscode.WorkspaceFolder;

describe('exportKbeStubs 用户指定目录(copy-if-absent 装配层)', () => {
  beforeEach(() => {
    memory.clear();
    writes = [];
    deleted = [];
    messages.info.length = 0;
    messages.warning.length = 0;
    configurationOverrides.clear();
    workspaceState.reset();
    windowState.reset();
  });

  it('配置的目录(python.stubDir)落用户目录,模板集照复制', async () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': 'typings' });
    stubWorkspace.workspaceFolders = [folder('/ws/main')];
    const root = makeTemplateRoot();
    try {
      await exportKbeStubs(makeDeps(root), { templateRoot: root });

      expect(writes.sort()).toEqual([
        '/ws/main/typings/KBEngine/Entity.pyi',
        '/ws/main/typings/KBEngine/__init__.pyi'
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('用户目录里已有同名文件不覆盖(copy-if-absent 对用户目录同样成立)', async () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': 'typings' });
    stubWorkspace.workspaceFolders = [folder('/ws/main')];
    const root = makeTemplateRoot();
    memory.set('/ws/main/typings/KBEngine/Entity.pyi', '# 用户魔改版\n');
    try {
      await exportKbeStubs(makeDeps(root), { templateRoot: root });

      expect(writes).toEqual(['/ws/main/typings/KBEngine/__init__.pyi']);
      expect(memory.get('/ws/main/typings/KBEngine/Entity.pyi')).toBe('# 用户魔改版\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('用户目录不迁移:同名 KBEngine.pyi 即使带 kode 生成标记也不删', async () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': 'typings' });
    stubWorkspace.workspaceFolders = [folder('/ws/main')];
    const root = makeTemplateRoot();
    memory.set('/ws/main/typings/KBEngine.pyi', `${KBE_STUB_GENERATED_MARKER}\n`);
    try {
      await exportKbeStubs(makeDeps(root), { templateRoot: root });

      expect(deleted).toEqual([]);
      expect(memory.has('/ws/main/typings/KBEngine.pyi')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('deps 未注入目录枚举能力时按模板缺失处理,不盲写', async () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': 'typings' });
    stubWorkspace.workspaceFolders = [folder('/ws/main')];
    const root = makeTemplateRoot();
    const deps = makeDeps(root);
    delete deps.listDir;
    try {
      await exportKbeStubs(deps, { templateRoot: root });

      expect(writes).toEqual([]);
      expect(messages.warning[0]).toContain('模板读不到');
    } finally {
      rmSync(root, { recursive: true, force: true });
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('静默模式零提示', async () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': 'typings' });
    stubWorkspace.workspaceFolders = [folder('/ws/main')];
    const root = makeTemplateRoot();
    try {
      await exportKbeStubs(makeDeps(root), { templateRoot: root, silent: true });

      expect(messages.info).toHaveLength(0);
      expect(messages.warning).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('工作区列表为 undefined 时按空处理,如实说明', async () => {
    const root = makeTemplateRoot();
    try {
      stubWorkspace.workspaceFolders = undefined as never;
      const deps = makeDeps(root);

      await exportKbeStubs(deps, { templateRoot: root });
      expect(messages.info[0]).toContain('未打开工作区');

      await exportKbeStubs(deps, { templateRoot: root, silent: true });
      expect(messages.info).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      stubWorkspace.workspaceFolders = [];
    }
  });

  it('默认真 fs 依赖的目录扫描能读出条目', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kode-stub-'));
    try {
      writeFileSync(join(dir, 'a.pyi'), '');
      expect(fileSystemStubExportDeps.listDir?.(dir)).toContain('a.pyi');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveStubDir 装配层读设置', () => {
  beforeEach(() => {
    configurationOverrides.clear();
  });

  it('经 readStubDirSetting 读到 kbengine.python.stubDir', () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': 'typings' });
    expect(resolveStubDir(ROOT, { setting: readStubDirSetting() }).dir).toBe('/ws/main/typings');
  });

  it('设置缺项时 readStubDirSetting 回落空串', () => {
    expect(readStubDirSetting()).toBe('');
  });
});
