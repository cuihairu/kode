import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  findFilesAcrossRoots,
  resetEngineSubtreeExclusionCache,
  resetScanRootCache,
  resetUserScanExcludeCache
} from '../src/scanRoots';
import { configurationOverrides, workspace as stubWorkspace } from './helpers/vscodeStub';

// ENGINE-LIB-SCAN-005 刀3:kbengine.index.scanExcludeGlobs 用户排除兜底。
//   - 每条 glob 经 minimatch(dot 开)对规范化绝对路径匹配,目录命中整棵剔;
//   - 裸目录名简写(kbe)按「任意前缀/kbe/任意后缀」双星形态解释;
//   - 坏模式跳过不炸(一条手误不把扫描炸停);默认空=零排除;
//   - 与刀2 引擎子树同一接入面(workspace glob 后滤+外部遍历剪枝)。

const originalFindFiles = stubWorkspace.findFiles;

describe('kbengine.index.scanExcludeGlobs 用户排除兜底(ENGINE-LIB-SCAN-005 刀3)', () => {
  let root = '';

  afterEach(() => {
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.workspaceFolders = [];
    configurationOverrides.clear();
    resetUserScanExcludeCache();
    resetEngineSubtreeExclusionCache();
    resetScanRootCache();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  const setUp = (files: string[]): string => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-scanex-'));
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), 'x = 1\n', 'utf8');
    }
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } as never, name: 'scanex', index: 0 }];
    stubWorkspace.findFiles = (async () =>
      files.map(file => ({ fsPath: path.join(root, file) }))) as never;
    return root;
  };

  it('glob 子树剔:gen 目录整棵不进,业务文件照留', async () => {
    setUp(['gen/schema_a.py', 'gen/nested/schema_b.py', 'game/main.py', 'game/api.py']);
    configurationOverrides.set('kbengine.index', { scanExcludeGlobs: ['**/gen/**'] });

    const found = await findFilesAcrossRoots('**/*.py', null);
    expect(found.map(uri => path.relative(root, uri.fsPath)).sort()).toEqual(['game/api.py', 'game/main.py']);
  });

  it('裸目录名简写:kbe 按「任意前缀/kbe/任意后缀」解释', async () => {
    setUp(['kbe/patch/fix.py', 'src/kbe/helper.py', 'src/main.py']);
    configurationOverrides.set('kbengine.index', { scanExcludeGlobs: ['kbe'] });

    const found = await findFilesAcrossRoots('**/*.py', null);
    expect(found.map(uri => path.relative(root, uri.fsPath))).toEqual(['src/main.py']);
  });

  it('默认空=零排除,不误伤', async () => {
    setUp(['gen/schema_a.py', 'game/main.py']);

    const found = await findFilesAcrossRoots('**/*.py', null);
    expect(found).toHaveLength(2);
  });

  it('坏模式跳过不炸:一条手误不拖垮其余 glob', async () => {
    setUp(['gen/schema_a.py', 'game/main.py']);
    // 未闭合方括号 = minimatch 编译抛;gen 仍应被第二条剔掉
    configurationOverrides.set('kbengine.index', { scanExcludeGlobs: ['[', '**/gen/**'] });

    const found = await findFilesAcrossRoots('**/*.py', null);
    expect(found.map(uri => path.relative(root, uri.fsPath))).toEqual(['game/main.py']);
  });

  it('配置变化即时生效(缓存按 globs 内容换 key)', async () => {
    setUp(['gen/schema_a.py', 'tmp_gen/out.py', 'game/main.py']);

    configurationOverrides.set('kbengine.index', { scanExcludeGlobs: ['**/gen/**'] });
    let found = await findFilesAcrossRoots('**/*.py', null);
    expect(found.map(uri => path.relative(root, uri.fsPath)).sort()).toEqual(['game/main.py', 'tmp_gen/out.py']);

    configurationOverrides.set('kbengine.index', { scanExcludeGlobs: ['**/gen/**', '**/tmp_gen/**'] });
    found = await findFilesAcrossRoots('**/*.py', null);
    expect(found.map(uri => path.relative(root, uri.fsPath))).toEqual(['game/main.py']);
  });
});
