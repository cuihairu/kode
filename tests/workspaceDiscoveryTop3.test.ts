import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  conventionalConfigRoots,
  hasEngineConfigProbe,
  preheatDiscoveryScan,
  resetDiscoveryMemo,
  resetDiscoveryState,
  resolveDiscoveredEntityDefsRoot,
  resolveDiscoveredEntitiesXmlPath,
  resolveDiscoveredTypesXmlPath,
  scanWorkspaceAnchors
} from '../src/workspaceDiscovery';

// 书 PR-002 ③:workspaceDiscovery 交互路径 Top3 修复的行为锁定。
// 测量证据(docs/perf/discovery-sync-run.txt):冷 walk 40.5ms/次(large
// 20000 条目)是交互路径唯一 ms 级存量;约定 readdir 0.01ms、探针链
// 0.03ms、记忆项 existsSync ≈0。修复=预热挪时机 + 两个同级 memo;
// 失效口径与 scanCache 一致(resetDiscoveryState/resetDiscoveryMemo)。

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-discovery-top3-'));
  resetDiscoveryState();
});

afterAll(() => {
  resetDiscoveryState();
});

describe('preheatDiscoveryScan(冷 walk 挪出交互路径)', () => {
  it('预热后三兄弟 resolve 结果与冷扫描完全同源', () => {
    const defDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defDir, { recursive: true });
    fs.writeFileSync(path.join(defDir, 'Hero.def'), '<root><Properties/></root>', 'utf8');
    fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), '<root><Hero/></root>', 'utf8');

    // 预热(激活期语义)
    preheatDiscoveryScan(root);

    // 预热后 resolve(交互路径语义)与直接冷扫描结果逐字段一致
    const preheated = {
      entityDefs: resolveDiscoveredEntityDefsRoot(root),
      entitiesXml: resolveDiscoveredEntitiesXmlPath(root),
      typesXml: resolveDiscoveredTypesXmlPath(root)
    };
    resetDiscoveryState();
    scanWorkspaceAnchors(root);
    const cold = {
      entityDefs: resolveDiscoveredEntityDefsRoot(root),
      entitiesXml: resolveDiscoveredEntitiesXmlPath(root),
      typesXml: resolveDiscoveredTypesXmlPath(root)
    };
    expect(preheated).toEqual(cold);
    expect(preheated.entityDefs).toBe(defDir);
  });
});

describe('conventionalConfigRoots memo(约定 readdir)', () => {
  it('同级失效口径:resetDiscoveryMemo 后新 *_assets 目录可见', () => {
    expect(conventionalConfigRoots(root).some(p => p.endsWith('flyff_assets'))).toBe(false);
    // memo 生效期内新建目录不可见(与 scanCache 同级陈旧语义)
    fs.mkdirSync(path.join(root, 'flyff_assets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'flyff_assets', 'res', 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'flyff_assets', 'res', 'server', 'kbengine.xml'), '<root/>', 'utf8');
    expect(conventionalConfigRoots(root).some(p => p.endsWith('flyff_assets'))).toBe(false);
    // 同级失效后可见
    resetDiscoveryMemo();
    const roots = conventionalConfigRoots(root);
    expect(roots.some(p => p.endsWith('flyff_assets'))).toBe(true);
    // 探针谓词(经 memo)命中新资产根
    expect(hasEngineConfigProbe(path.join(root, 'flyff_assets'))).toBe(true);
  });
});

describe('hasEngineConfigProbe memo(探针链 existsSync)', () => {
  it('未命中 memo 后补建探针文件:resetDiscoveryMemo 后翻真', () => {
    expect(hasEngineConfigProbe(root)).toBe(false);
    fs.mkdirSync(path.join(root, 'res', 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'res', 'server', 'kbengine.xml'), '<root/>', 'utf8');
    expect(hasEngineConfigProbe(root)).toBe(false);
    resetDiscoveryMemo();
    expect(hasEngineConfigProbe(root)).toBe(true);
  });
});
