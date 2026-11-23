import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  findFilesAcrossRoots,
  resetEngineSubtreeExclusionCache,
  resetScanRootCache,
  resolveEngineSubtreeExclusions
} from '../src/scanRoots';
import { configurationOverrides, workspace as stubWorkspace } from './helpers/vscodeStub';

// ENGINE-LIB-SCAN-005 刀2:引擎仓子树剔出业务扫描。
//   - 用户布局=打开含引擎仓+assets 的上层目录(引擎仓是工作区**孩子**,
//     findEngineRoot 向上找找不到;一二层子目录 hasEngineTreeMarker 探测);
//   - 剔除=绝对路径前缀,三面(workspace glob 后滤+外部遍历剪枝+收尾兜底);
//   - 无标记=零剔除,行为与刀2 前一致(不按目录名全局剔,普通项目自有
//     Lib 目录不受影响——刀1 的形态锚定同纪律);
//   - 标记=hasEngineTreeMarker 双标记(version.h 旧树 | kbeversion.h 2.5.10+)。

const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
};

/** 在 root 下造一棵带引擎标记的最小树(kbe/src/lib/common/<marker>) */
const makeEngineTree = (root: string, marker: 'version.h' | 'kbeversion.h' = 'version.h'): void => {
  write(
    path.join(root, 'kbe', 'src', 'lib', 'common', marker),
    marker === 'version.h' ? '#define KBE_VERSION "2.5.10"\n' : '#define KBE_VERSION_MAJOR 2\n'
  );
};

const originalFindFiles = stubWorkspace.findFiles;

describe('引擎仓子树剔除(ENGINE-LIB-SCAN-005 刀2)', () => {
  const roots: string[] = [];

  const makeRoot = (prefix: string): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.workspaceFolders = [];
    configurationOverrides.clear();
    resetEngineSubtreeExclusionCache();
    resetScanRootCache();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const setWorkspace = (root: string): void => {
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } as never, name: 'engex', index: 0 }];
  };

  const stubFindFilesWith = (fsPaths: string[]): void => {
    stubWorkspace.findFiles = (async () => fsPaths.map(fsPath => ({ fsPath }))) as never;
  };

  it('内嵌引擎仓孩子整棵剔:引擎 def/Lib 不进业务扫描,assets def 照留', async () => {
    const root = makeRoot('kode-engex-child-');
    const assets = path.join(root, 'assets');
    // 扫描根 = {assets}/scripts(只扫 assetsRoot/scripts 令);引擎仓是扫描根的
    // 一层孩子,由 probeEmbeddedEngineRoots 探到 → 刀2 前缀剔,而非扫描根门挡。
    const engineChild = path.join(assets, 'scripts', 'kbe-engine');
    makeEngineTree(engineChild);
    const engineDef = path.join(engineChild, 'kbe', 'res', 'entity_defs', 'EngineMonster.def');
    const engineLib = path.join(engineChild, 'scripts', 'common', 'Lib', 'os_stub.py');
    write(engineDef, '<root/>');
    write(engineLib, 'x = 1\n');
    const avatarDef = path.join(assets, 'scripts', 'entity_defs', 'Avatar.def');
    write(avatarDef, '<root/>');

    setWorkspace(root);
    configurationOverrides.set('kbengine', { assetsRoot: assets });
    stubFindFilesWith([engineDef, avatarDef, engineLib]);

    const defs = await findFilesAcrossRoots('**/*.def', null);
    expect(defs.map(uri => uri.fsPath)).toEqual([avatarDef]);
    // 剔除根=引擎仓孩子本身(绝对路径前缀,非目录名)
    const exclusions = resolveEngineSubtreeExclusions();
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0].endsWith('kbe-engine')).toBe(true);
  });

  it('二层内嵌(vendor/kbengine)与新标记 kbeversion.h 同样被剔', async () => {
    const root = makeRoot('kode-engex-nested-');
    const assets = path.join(root, 'assets');
    // 引擎仓作为扫描根的二层孩子(probe 探一二层)
    const engineNested = path.join(assets, 'scripts', 'vendor', 'kbengine');
    makeEngineTree(engineNested, 'kbeversion.h');
    const engineDef = path.join(engineNested, 'kbe', 'res', 'entity_defs', 'Gate.def');
    write(engineDef, '<root/>');

    setWorkspace(root);
    configurationOverrides.set('kbengine', { assetsRoot: assets });
    stubFindFilesWith([engineDef]);

    const defs = await findFilesAcrossRoots('**/*.def', null);
    expect(defs).toHaveLength(0);
    expect(resolveEngineSubtreeExclusions()).toHaveLength(1);
  });

  it('无引擎标记=零剔除:普通目录与项目自有 Lib 不受影响', async () => {
    const root = makeRoot('kode-engex-plain-');
    // 业务文件落在 {assets}/scripts 扫描根内
    const ownLib = path.join(root, 'scripts', 'game', 'Lib', 'util.py');
    const mainPy = path.join(root, 'scripts', 'game', 'main.py');
    write(ownLib, 'x = 1\n');
    write(mainPy, 'y = 2\n');

    setWorkspace(root);
    configurationOverrides.set('kbengine', { assetsRoot: root });
    stubFindFilesWith([ownLib, mainPy]);

    expect(resolveEngineSubtreeExclusions()).toHaveLength(0);
    const pys = await findFilesAcrossRoots('**/*.py', null);
    expect(pys.map(uri => uri.fsPath).sort()).toEqual([mainPy, ownLib].sort());
  });

  it('工作区=引擎仓本身:整根都是引擎子树,业务扫描为空', async () => {
    const root = makeRoot('kode-engex-self-');
    makeEngineTree(root);
    // 扫描根在引擎树内:findEngineRoot 向上探到根 → 整根入排除集
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    const engineDef = path.join(root, 'kbe', 'res', 'entity_defs', 'EngineOnly.def');
    write(engineDef, '<root/>');

    setWorkspace(root);
    configurationOverrides.set('kbengine', { assetsRoot: root });
    stubFindFilesWith([engineDef]);

    expect((await findFilesAcrossRoots('**/*.def', null)).length).toBe(0);
    // findEngineRoot 向上探测:根自身带标记 → 根入排除集
    expect(resolveEngineSubtreeExclusions().length).toBe(1);
  });

  it('显式 kbengine.engineRoot 设置被采纳(marker 校验通过才认)', () => {
    const workspaceRoot = makeRoot('kode-engex-ws-');
    const engineOutside = makeRoot('kode-engex-out-');
    makeEngineTree(engineOutside);

    setWorkspace(workspaceRoot);
    configurationOverrides.set('kbengine', { engineRoot: engineOutside });

    const exclusions = resolveEngineSubtreeExclusions();
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0].endsWith(path.basename(engineOutside))).toBe(true);

    // marker 校验不通过(空目录冒充引擎根)不认,零剔除
    const fakeRoot = makeRoot('kode-engex-fake-');
    configurationOverrides.set('kbengine', { engineRoot: fakeRoot });
    resetEngineSubtreeExclusionCache();
    expect(resolveEngineSubtreeExclusions()).toHaveLength(0);
  });
});
