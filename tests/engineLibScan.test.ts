import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Uri } from './fake-vscode/core';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { isEnginePythonLibPath } from '../src/backend/pythonScanRules';
import { findFilesAcrossRoots, resetScanRootCache } from '../src/scanRoots';
import { PythonClassIndex } from '../src/backend/pythonClassIndex';
import { resetLanguageServiceMetrics } from '../src/languageServiceMetrics';

// ENGINE-LIB-SCAN-005 刀1:KBEngine 引擎仓自带 python 标准库镜像
// (kbe/scripts/common/Lib)按路径形态剔出业务 python 扫描。锚定纪律:
// 只认 kbe/scripts/common/Lib 段序,普通项目自有 Lib 目录不误伤
// (KODE-CFG-017 形态锚定先例)。用户报「开了 log 一直在扫
// kbe/scripts/common/Lib 下大量库」——引擎标准库不是业务代码。

const tmpRoots: string[] = [];
const makeTmpDir = (label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kode-englib-${label}-`));
  tmpRoots.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.findFiles = (async () => []) as typeof stubWorkspace.findFiles;
  configurationOverrides.delete('kbengine');
  resetScanRootCache();
});

describe('isEnginePythonLibPath 路径形态判定(ENGINE-LIB-SCAN-005 刀1)', () => {
  it('引擎仓形态命中:posix/反斜杠/大小写/库根目录本身', () => {
    expect(isEnginePythonLibPath('/eng/kbe/scripts/common/Lib/os.py')).toBe(true);
    expect(isEnginePythonLibPath('C:\\eng\\kbe\\scripts\\common\\Lib\\os.py')).toBe(true);
    expect(isEnginePythonLibPath('/eng/kbe/scripts/common/lib/os.py')).toBe(true);
    // 库根目录本身(遍历剪枝时目录路径先于文件到过滤器)
    expect(isEnginePythonLibPath('/eng/kbe/scripts/common/Lib')).toBe(true);
    // 引擎仓不在扫描根开头也可:形态锚定(段序),非根前缀
    expect(isEnginePythonLibPath('/ws/sub/kbe/scripts/common/Lib/json/__init__.py')).toBe(true);
  });

  it('用户自有目录不误伤:普通 Lib/段序不全/相似名', () => {
    expect(isEnginePythonLibPath('/ws/Lib/mod.py')).toBe(false);
    expect(isEnginePythonLibPath('/ws/lib/mod.py')).toBe(false);
    expect(isEnginePythonLibPath('/ws/kbe/Lib/mod.py')).toBe(false);
    expect(isEnginePythonLibPath('/ws/kbe/scripts/Lib/mod.py')).toBe(false);
    expect(isEnginePythonLibPath('/ws/kbe/scripts/common/Libs/mod.py')).toBe(false);
    expect(isEnginePythonLibPath('/ws/kbe/scripts/common/library/mod.py')).toBe(false);
    expect(isEnginePythonLibPath('/ws/scripts/common/mod.py')).toBe(false);
    expect(isEnginePythonLibPath('')).toBe(false);
  });
});

describe('findFilesAcrossRoots pathFilter:workspace 结果后滤 + 外部根遍历剪枝', () => {
  it('workspace glob 命中的引擎库文件被后滤,业务文件保留', async () => {
    const ws = makeTmpDir('ws');
    const good = Uri.file(path.join(ws, 'scripts', 'base', 'Avatar.py'));
    const engineLib = Uri.file(path.join(ws, 'kbe', 'scripts', 'common', 'Lib', 'os.py'));
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async () => [good, engineLib]) as typeof stubWorkspace.findFiles;
    const found = await findFilesAcrossRoots('**/*.py', null, undefined, p => !isEnginePythonLibPath(p));
    expect(found.map(u => u.fsPath)).toEqual([good.fsPath]);
  });

  it('外部根(assetsRoot)遍历:引擎库目录整棵不下潜,业务脚本照常入列', async () => {
    const ws = makeTmpDir('ws');
    const assets = makeTmpDir('assets');
    fs.mkdirSync(path.join(assets, 'scripts', 'base'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'scripts', 'base', 'Avatar.py'), 'class Avatar:\n    pass\n');
    fs.mkdirSync(path.join(assets, 'kbe', 'scripts', 'common', 'Lib', 'json'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'kbe', 'scripts', 'common', 'Lib', 'os.py'), 'import sys\n');
    fs.writeFileSync(path.join(assets, 'kbe', 'scripts', 'common', 'Lib', 'json', '__init__.py'), '""\n');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async () => []) as typeof stubWorkspace.findFiles;
    configurationOverrides.set('kbengine', { assetsRoot: assets });
    resetScanRootCache();
    const found = await findFilesAcrossRoots('**/*.py', null, undefined, p => !isEnginePythonLibPath(p));
    expect(found.map(u => u.fsPath)).toEqual([path.join(assets, 'scripts', 'base', 'Avatar.py')]);
  });

  it('pathFilter 缺省=不过滤(generic 行为不变,def/xml 等语料面不受影响)', async () => {
    const ws = makeTmpDir('ws');
    const engineDef = Uri.file(path.join(ws, 'kbe', 'scripts', 'common', 'Lib', 'x.py'));
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async () => [engineDef]) as typeof stubWorkspace.findFiles;
    const found = await findFilesAcrossRoots('**/*.py', null);
    expect(found.map(u => u.fsPath)).toEqual([engineDef.fsPath]);
  });
});

describe('pythonClassIndex 扫描面接线(发现/懒查同口径)', () => {
  it('全量发现剔引擎库;按名懒查同样不落引擎库文件', async () => {
    const ws = makeTmpDir('idx');
    const goodPath = path.join(ws, 'scripts', 'base', 'Avatar.py');
    fs.mkdirSync(path.dirname(goodPath), { recursive: true });
    fs.writeFileSync(goodPath, 'class Avatar:\n    pass\n');
    const engineLibPath = path.join(ws, 'kbe', 'scripts', 'common', 'Lib', 'EngineStd.py');
    fs.mkdirSync(path.dirname(engineLibPath), { recursive: true });
    fs.writeFileSync(engineLibPath, 'class EngineStd:\n    pass\n');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async () => [
      Uri.file(goodPath),
      Uri.file(engineLibPath)
    ]) as typeof stubWorkspace.findFiles;
    resetLanguageServiceMetrics();
    const index = new PythonClassIndex();
    index.scheduleBackgroundScan();
    await index.waitForInitialScan();
    // 业务类照常入索引
    const hits = await index.findClassesByName('Avatar');
    expect(hits.map(c => c.filePath)).toEqual([goodPath]);
    // 引擎库类不入索引;findClassesByName 未命中时的按需单文件发现(:1264)
    // 同口径不落引擎库
    expect(await index.findClassesByName('EngineStd')).toEqual([]);
  }, 10000);
});
