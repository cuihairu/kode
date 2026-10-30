import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  KBE_STUB_FILE_NAME,
  PYTHON_STUB_EXPORT_ENABLED_DEFAULT,
  buildKbeStubExportContent,
  buildKbeStubExportContentForWorkspace,
  exportKbeStubs,
  kbeStubDir,
  kbeStubFilePath
} from '../src/pythonStubExport';
import { KBE_SYMBOLS, buildKbeStubDocument } from '../src/kbeModuleIndex';
import {
  configurationOverrides,
  messages,
  Uri,
  windowState,
  workspace as stubWorkspace,
  workspaceState
} from './helpers/vscodeStub';

// 功能差距盘点 G2(docs/reference-feature-gap.md):kbeModuleIndex 符号索引
// 只服务 kode 自己的补全/悬停/跳转,Pylance 看不见——把同一份索引导出成
// `.kbengine/stubs/KBEngine.pyi` 真文件,配合 G1 的 extraPaths 接线才能解析
// `import KBEngine`。纯内容段断言同源性;导出段注入 deps 不碰真 fs。

interface DepsScript {
  existing?: string[];
  initial?: Record<string, string>;
  readFails?: boolean;
  writeFails?: boolean;
}

const makeDeps = (script: DepsScript = {}): {
  deps: import('../src/pythonStubExport').StubExportDeps;
  writes: Array<{ path: string; content: string }>;
  mkdirs: string[];
} => {
  const writes: Array<{ path: string; content: string }> = [];
  const mkdirs: string[] = [];
  return {
    writes,
    mkdirs,
    deps: {
      exists: (candidate: string): boolean => (script.existing ?? []).includes(candidate),
      readFile: (path: string): string => {
        if (script.readFails) {
          throw new Error('EACCES');
        }
        return script.initial?.[path] ?? '';
      },
      writeFile: (path: string, content: string): void => {
        if (script.writeFails) {
          throw new Error('EROFS');
        }
        writes.push({ path, content });
      },
      mkdir: (dir: string): void => {
        if (script.writeFails) {
          throw new Error('EROFS');
        }
        mkdirs.push(dir);
      }
    }
  };
};

const folder = (fsPath: string): vscode.WorkspaceFolder =>
  ({ uri: Uri.file(fsPath), name: fsPath.split('/').pop() ?? fsPath, index: 0 }) as vscode.WorkspaceFolder;

describe('存根文件路径(kbeStubDir/kbeStubFilePath)', () => {
  it('落在 .kbengine/stubs 约定目录,文件名 KBEngine.pyi', () => {
    expect(kbeStubDir('/ws')).toBe('/ws/.kbengine/stubs');
    expect(kbeStubFilePath('/ws')).toBe('/ws/.kbengine/stubs/KBEngine.pyi');
    expect(KBE_STUB_FILE_NAME).toBe('KBEngine.pyi');
  });
});

describe('buildKbeStubExportContent(与符号索引同源)', () => {
  const content = buildKbeStubExportContent();

  it('头部明示 kode 自动生成、重导出覆盖', () => {
    expect(content).toContain('kode 自动生成');
    expect(content).toContain('Regeneration overwrites edits');
    expect(content).toContain('not a complete engine API catalog');
  });

  it('不带虚拟桩文档措辞(导出的是真文件,不是只读桩)', () => {
    expect(content).not.toContain('只读');
    expect(content).not.toContain('跳转目标为本桩文档');
  });

  it('索引每条符号都出现在导出内容里,签名与桩文档同形', () => {
    const stub = buildKbeStubDocument();
    for (const entry of KBE_SYMBOLS) {
      expect(content).toContain(`${entry.signature}:`);
      expect(stub.content).toContain(`${entry.signature}:`);
    }
  });
});

describe('buildKbeStubExportContentForWorkspace(engine detection)', () => {
  it('falls back to the curated catalog when engine detection is disabled', () => {
    const previous = process.env.KBENGINE_ROOT;
    process.env.KBENGINE_ROOT = '/definitely/missing';
    try {
      expect(buildKbeStubExportContentForWorkspace('/ws', { engineRoot: null }))
        .toBe(buildKbeStubExportContent());
    } finally {
      if (previous === undefined) {
        delete process.env.KBENGINE_ROOT;
      } else {
        process.env.KBENGINE_ROOT = previous;
      }
    }
  });

  it('concatenates an explicit engine checkout and rewrites private imports', () => {
    const engineRoot = mkdtempSync(join(os.tmpdir(), 'kode-engine-'));
    mkdirSync(join(engineRoot, 'typings'), { recursive: true });
    writeFileSync(join(engineRoot, 'typings', '_KBEngine_common.pyi'), 'from _KBEngine_server_errors import *\n\nclass Entity:\n    id: int\n');
    writeFileSync(join(engineRoot, 'typings', '_KBEngine_baseapp.pyi'), 'from _KBEngine_common import Entity\n\ndef address() -> int: ...\n');
    for (const moduleName of [
      '_KBEngine_bots', '_KBEngine_cellapp', '_KBEngine_dbmgr', '_KBEngine_hooks',
      '_KBEngine_interfaces', '_KBEngine_logger', '_KBEngine_loginapp',
      '_KBEngine_pythonapp', '_KBEngine_server_errors'
    ]) {
      writeFileSync(join(engineRoot, 'typings', `${moduleName}.pyi`), '# fixture\n');
    }
    const content = buildKbeStubExportContentForWorkspace('/ws', {
      engineRoot,
      engineRootEnv: {}
    });
    try {
      expect(content).toContain('generated from the local KBEngine typings checkout');
      expect(content).toContain('from KBEngine import');
      expect(content).not.toContain('from _KBEngine_common import');
      expect(content).not.toContain('from _KBEngine_server_errors import');
      expect(content).toContain('class Entity:');
      expect(content).toContain('def address() -> int: ...');
    } finally {
      rmSync(engineRoot, { recursive: true, force: true });
    }
  });

  it('falls back to the curated catalog when a typings module file is missing', () => {
    // 树只带 marker(_KBEngine_common.pyi),模块序列第二个文件缺失 →
    // 读取抛错落 catch → 引擎内容判 null → 回落精选目录,不产出残缺存根。
    const engineRoot = mkdtempSync(join(os.tmpdir(), 'kode-engine-partial-'));
    try {
      mkdirSync(join(engineRoot, 'typings'), { recursive: true });
      writeFileSync(join(engineRoot, 'typings', '_KBEngine_common.pyi'), 'class Entity:\n    id: int\n');
      const content = buildKbeStubExportContentForWorkspace('/ws', {
        engineRoot,
        engineRootEnv: {}
      });
      expect(content).toBe(buildKbeStubExportContent());
      expect(content).not.toContain('generated from the local KBEngine typings checkout');
    } finally {
      rmSync(engineRoot, { recursive: true, force: true });
    }
  });
});

describe('exportKbeStubs(装配层)', () => {
  beforeEach(() => {
    messages.info.length = 0;
    messages.warning.length = 0;
    messages.error.length = 0;
    windowState.reset();
    workspaceState.reset();
    configurationOverrides.clear();
  });

  it('默认设置为开', () => {
    expect(PYTHON_STUB_EXPORT_ENABLED_DEFAULT).toBe(true);
  });

  it('设置关闭时说明返回,不写任何文件', async () => {
    configurationOverrides.set('kbengine', { 'python.stubExport': false });
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes } = makeDeps();

    await exportKbeStubs(deps);

    expect(messages.info[0]).toContain('已关闭');
    expect(writes).toHaveLength(0);

    // 静默模式(激活期)下关闭同样零提示
    await exportKbeStubs(deps, { silent: true });
    expect(messages.info).toHaveLength(1);
    stubWorkspace.workspaceFolders = [];
  });

  it('未打开工作区时如实说明', async () => {
    stubWorkspace.workspaceFolders = [];
    const { deps } = makeDeps();

    await exportKbeStubs(deps);

    expect(messages.info[0]).toContain('未打开工作区');
    expect(messages.info[0]).toContain('存根导出');
  });

  it('首次导出:建目录写文件,内容即同源生成物,播报文件夹', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes, mkdirs } = makeDeps();

    await exportKbeStubs(deps);

    expect(mkdirs).toEqual(['/ws/.kbengine/stubs']);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/ws/.kbengine/stubs/KBEngine.pyi');
    expect(writes[0].content).toBe(buildKbeStubExportContent());
    expect(messages.info[0]).toContain('ws');
  });

  it('内容一致时零写零提示(idempotent)', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes } = makeDeps({
      existing: ['/ws/.kbengine/stubs/KBEngine.pyi'],
      initial: { '/ws/.kbengine/stubs/KBEngine.pyi': buildKbeStubExportContent() }
    });

    await exportKbeStubs(deps);

    expect(writes).toHaveLength(0);
    expect(messages.info).toHaveLength(0);
  });

  it('磁盘内容陈旧时重写', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes } = makeDeps({
      existing: ['/ws/.kbengine/stubs/KBEngine.pyi'],
      initial: { '/ws/.kbengine/stubs/KBEngine.pyi': '# 旧版本存根' }
    });

    await exportKbeStubs(deps);

    expect(writes).toHaveLength(1);
    expect(writes[0].content).toBe(buildKbeStubExportContent());
  });

  it('文件在但读不到时按陈旧处理重写', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes } = makeDeps({
      existing: ['/ws/.kbengine/stubs/KBEngine.pyi'],
      readFails: true
    });

    await exportKbeStubs(deps);

    expect(writes).toHaveLength(1);
  });

  it('静默模式:全程零提示,写文件照做', async () => {
    stubWorkspace.workspaceFolders = [folder('/ws')];
    const { deps, writes } = makeDeps();

    await exportKbeStubs(deps, { silent: true });

    expect(writes).toHaveLength(1);
    expect(messages.info).toHaveLength(0);
  });

  it('默认真 fs 依赖:存根路径上是目录时读取抛错按陈旧处理,重写失败如实告警', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = require('fs') as typeof import('fs');
    const { tmpdir } = require('os') as typeof import('os');
    const dir = mkdtempSync(join(tmpdir(), 'kode-stub-'));
    try {
      // 存根目标路径被一个同名目录占住:exists 真,readFileSync 抛 EISDIR →
      // 判陈旧 → mkdir(已存在,recursive 幂等) → writeFile 抛 → failed 臂
      mkdirSync(kbeStubFilePath(dir), { recursive: true });
      stubWorkspace.workspaceFolders = [folder(dir)];

      // 不注入 deps,走 fileSystemStubExportDeps 真实 fs
      await exportKbeStubs();

      expect(messages.warning[0]).toContain(dir.split('/').pop() ?? dir);
      expect(messages.info).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    stubWorkspace.workspaceFolders = [];
  });

  it('目录不可写时告警并继续,不影响其他文件夹', async () => {
    stubWorkspace.workspaceFolders = [folder('/ro'), folder('/ok')];
    const writable = makeDeps();
    const failing = makeDeps({ writeFails: true });
    // 只让 /ro 不可写:按路径分派
    const mixed = {
      exists: (p: string): boolean => p.startsWith('/ro') ? failing.deps.exists(p) : writable.deps.exists(p),
      readFile: (p: string): string => p.startsWith('/ro') ? failing.deps.readFile(p) : writable.deps.readFile(p),
      writeFile: (p: string, c: string): void => void (p.startsWith('/ro') ? failing.deps.writeFile(p, c) : writable.deps.writeFile(p, c)),
      mkdir: (p: string): void => void (p.startsWith('/ro') ? failing.deps.mkdir(p) : writable.deps.mkdir(p))
    };

    await exportKbeStubs(mixed);

    expect(writable.writes.map(write => write.path)).toEqual(['/ok/.kbengine/stubs/KBEngine.pyi']);
    expect(messages.warning[0]).toContain('ro');
    expect(messages.info[0]).toContain('ok');
  });
});
