/**
 * `.pyi` 存根目录用户可配(批142,任务单 kode-pyi.md 用户令:「.pyi 目录也应该
 * 用户配置吧,不配置才默认生成,配置了就扫描,没有 pyi 文件才生成」):
 * 三级来源(设置 > 环境变量 > 默认约定)、VS Code 变量替换、以及
 * 「目录里已有 .pyi 就不动用户文件」的判定,全部走批141 的统一替换实现。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PYTHON_STUB_DIR_DEFAULT,
  PYTHON_STUB_DIR_ENV,
  decideStubWrite,
  exportKbeStubs,
  fileSystemStubExportDeps,
  readStubDirSetting,
  resolveStubDir,
  scanStubDir
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

describe('scanStubDir 目录扫描', () => {
  it('列出目录下的 .pyi 文件', () => {
    const scan = scanStubDir('/ws/main/typings', {
      listDir: dir => (dir === '/ws/main/typings' ? ['a.pyi', 'notes.md', 'b.pyi'] : [])
    });
    expect(scan.pyiFiles).toEqual(['a.pyi', 'b.pyi']);
    expect(scan.unreadable).toBe(false);
  });

  it('目录为空时无 .pyi', () => {
    expect(scanStubDir('/ws/main/typings', { listDir: () => [] }).pyiFiles).toEqual([]);
  });

  it('目录读不到时如实标 unreadable,不当作空目录', () => {
    const scan = scanStubDir('/ws/main/typings', {
      listDir: () => {
        throw new Error('EACCES');
      }
    });
    expect(scan.unreadable).toBe(true);
    expect(scan.pyiFiles).toEqual([]);
  });

  it('只认小写 .pyi 后缀', () => {
    const scan = scanStubDir('/d', { listDir: () => ['a.PYI', 'b.pyi.txt'] });
    expect(scan.pyiFiles).toEqual([]);
  });

  it('抛的不是 Error 时按字符串记原因,不丢信息', () => {
    const scan = scanStubDir('/d', {
      listDir: () => {
        throw 'plain-string';
      }
    });
    expect(scan.unreadableReason).toBe('plain-string');
  });
});

describe('decideStubWrite 覆盖判定', () => {
  const userDir = resolveStubDir(ROOT, { setting: 'typings' });
  const defaultDir = resolveStubDir(ROOT, {});

  it('用户目录里没有 .pyi 时生成', () => {
    const decision = decideStubWrite(userDir, { pyiFiles: [], unreadable: false });
    expect(decision.write).toBe(true);
  });

  it('用户目录里已有 .pyi 时不覆盖用户文件', () => {
    const decision = decideStubWrite(userDir, { pyiFiles: ['mine.pyi'], unreadable: false });
    expect(decision.write).toBe(false);
    expect(decision.reason).toContain('mine.pyi');
  });

  it('用户目录读不到时不盲写,如实说明', () => {
    const decision = decideStubWrite(userDir, {
      pyiFiles: [],
      unreadable: true,
      unreadableReason: 'EACCES'
    });
    expect(decision.write).toBe(false);
    expect(decision.reason).toContain('读不到');
  });

  it('默认目录归 kode 自管:交给内容比对刷新,不因存在 .pyi 就停更', () => {
    const decision = decideStubWrite(defaultDir, { pyiFiles: ['KBEngine.pyi'], unreadable: false });
    expect(decision.write).toBe('managed');
  });

  it('读不到且未带原因时如实写未知原因', () => {
    const decision = decideStubWrite(userDir, { pyiFiles: [], unreadable: true });
    expect(decision.reason).toContain('未知原因');
  });
});

describe('exportKbeStubs 用户指定目录(装配层)', () => {
  const folder = (fsPath: string): vscode.WorkspaceFolder =>
    ({
      uri: Uri.file(fsPath),
      name: fsPath.split('/').pop() ?? fsPath,
      index: 0
    }) as vscode.WorkspaceFolder;

  beforeEach(() => {
    messages.info.length = 0;
    messages.warning.length = 0;
    configurationOverrides.clear();
    workspaceState.reset();
    windowState.reset();
  });

  const makeDeps = (entries: string[] | null) => {
    const writes: string[] = [];
    const mkdirs: string[] = [];
    const deps: import('../src/pythonStubExport').StubExportDeps = {
      exists: () => false,
      readFile: () => '',
      writeFile: (path: string) => {
        writes.push(path);
      },
      mkdir: (dir: string) => {
        mkdirs.push(dir);
      },
      listDir: entries === null
        ? () => {
          throw new Error('EACCES');
        }
        : () => entries
    };
    return { deps, writes, mkdirs };
  };

  it('配置的目录里没有 .pyi 时生成到该目录', async () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': 'typings' });
    stubWorkspace.workspaceFolders = [folder('/ws/main')];
    const { deps, writes, mkdirs } = makeDeps([]);

    await exportKbeStubs(deps);

    expect(mkdirs).toEqual(['/ws/main/typings']);
    expect(writes).toEqual(['/ws/main/typings/KBEngine.pyi']);
    stubWorkspace.workspaceFolders = [];
  });

  it('配置的目录里已有 .pyi 时不生成不覆盖,如实播报', async () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': 'typings' });
    stubWorkspace.workspaceFolders = [folder('/ws/main')];
    const { deps, writes } = makeDeps(['mine.pyi']);

    await exportKbeStubs(deps);

    expect(writes).toEqual([]);
    expect(messages.info[0]).toContain('mine.pyi');
    stubWorkspace.workspaceFolders = [];
  });

  it('配置的目录读不到时不盲写', async () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': 'typings' });
    stubWorkspace.workspaceFolders = [folder('/ws/main')];
    const { deps, writes } = makeDeps(null);

    await exportKbeStubs(deps);

    expect(writes).toEqual([]);
    expect(messages.info[0]).toContain('读不到');
    stubWorkspace.workspaceFolders = [];
  });

  it('deps 未注入目录扫描能力时按读不到处理,不放行盲写', async () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': 'typings' });
    stubWorkspace.workspaceFolders = [folder('/ws/main')];
    const { deps, writes } = makeDeps([]);
    delete deps.listDir;

    await exportKbeStubs(deps);

    expect(writes).toEqual([]);
    expect(messages.info[0]).toContain('未注入目录扫描能力');
    stubWorkspace.workspaceFolders = [];
  });

  it('静默模式跳过用户目录时零提示', async () => {
    configurationOverrides.set('kbengine', { 'python.stubDir': 'typings' });
    stubWorkspace.workspaceFolders = [folder('/ws/main')];
    const { deps } = makeDeps(['mine.pyi']);

    await exportKbeStubs(deps, { silent: true });

    expect(messages.info).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('工作区列表为 undefined 时按空处理,如实说明', async () => {
    stubWorkspace.workspaceFolders = undefined as never;
    const { deps } = makeDeps([]);

    await exportKbeStubs(deps);
    expect(messages.info[0]).toContain('未打开工作区');

    await exportKbeStubs(deps, { silent: true });
    expect(messages.info).toHaveLength(1);
    stubWorkspace.workspaceFolders = [];
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

