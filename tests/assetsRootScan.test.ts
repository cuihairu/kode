import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Position, Uri } from './fake-vscode/core';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { makeTextDocument } from './helpers/vscodeStub';
import { EntityMappingManager } from '../src/entityMapping';
import { PythonClassIndex, PY_SCAN_EXCLUDE } from '../src/pythonClassIndex';
import { PythonDefinitionProvider } from '../src/languageProviders';
import {
  findFilesAcrossRoots,
  getIndexScanRoots,
  getExternalScanRoots,
  resetScanRootCache
} from '../src/scanRoots';

// 真实 kbengine 目录形态验收(用户 2026-10-16:扫描根 = workspace ∪ assetsRoot)。
// workspace = kbe/tools(自身不含任何 .def/entities.xml),assetsRoot = kbe/res/
// sdk_templates/server/python_assets(仓库外于该工作区文件夹的资产树):
// entities.xml / .def / 脚本只存在于 assetsRoot 下,必须全部入索引,且
// assetsRoot 独有文件的调用能跳到定义。

const TOOLS = 'D:/workspaces/kbengine/kbe/tools';
const ASSETS = 'D:/workspaces/kbengine/kbe/res/sdk_templates/server/python_assets';

const normalize = (p: string): string => p.replace(/\\/g, '/');

const walkReal = (root: string, match: (name: string) => boolean): string[] => {
  const out: string[] = [];
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
        if (entry.name !== '.git') {
          walk(full);
        }
      } else if (entry.isFile() && match(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
};

const lineOf = (content: string, needle: string): number => {
  const index = content.split('\n').findIndex(line => line.includes(needle));
  expect(index, `缺少样本行: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
};

describe('真实 kbengine:assetsRoot 扫描根验收', () => {
  const ORIGINAL = stubWorkspace.findFiles;

  it('assetsRoot 下 entities.xml/.def/脚本全入索引,且 assetsRoot 独有文件跳转命中', async () => {
    if (!fs.existsSync(TOOLS) || !fs.existsSync(ASSETS)) {
      console.warn(`skip: ${TOOLS} 或 ${ASSETS} 不存在`);
      return;
    }

    resetScanRootCache();
    configurationOverrides.set('kbengine', { assetsRoot: ASSETS });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(TOOLS), name: 'tools', index: 0 }];
    // workspace 部分:按真实目录 walk 模拟 findFiles 的 workspace 域行为
    stubWorkspace.findFiles = (async (pattern?: string) => {
      const matches = pattern && pattern.includes('entities.xml')
        ? (name: string): boolean => name === 'entities.xml'
        : pattern && pattern.includes('*.def')
          ? (name: string): boolean => name.endsWith('.def')
          : pattern && pattern.includes('types.xml')
            ? (name: string): boolean => name === 'types.xml'
            : (name: string): boolean => name.endsWith('.py');
      return walkReal(TOOLS, matches).map(Uri.file);
    }) as typeof stubWorkspace.findFiles;

    try {
      // ── ① 扫描根:workspace 顶层 ∪ assetsRoot(两者并列,assetsRoot 在 workspace 文件夹之外) ──
      const roots = getIndexScanRoots();
      expect(roots.map(normalize)).toContain(normalize(TOOLS));
      expect(roots.map(normalize)).toContain(normalize(ASSETS));
      expect(getExternalScanRoots().map(normalize)).toEqual([normalize(ASSETS)]);

      // ── ② 前提证据:kbe/tools 自身没有任何实体定义(索引内容只能来自 assetsRoot) ──
      expect(walkReal(TOOLS, name => name.endsWith('.def')).length, 'workspace 应无 .def').toBe(0);
      expect(walkReal(TOOLS, name => name === 'entities.xml').length, 'workspace 应无 entities.xml').toBe(0);

      // ── ③ 计数:扫描结果 = assetsRoot 磁盘真值(workspace 域为 0) ──
      const fsEntities = walkReal(ASSETS, name => name === 'entities.xml');
      const fsDefs = walkReal(ASSETS, name => name.endsWith('.def'));
      const fsPy = walkReal(ASSETS, name => name.endsWith('.py'));
      expect(fsEntities.length, 'assetsRoot 应有 entities.xml').toBeGreaterThan(0);
      expect(fsDefs.length, 'assetsRoot 应有 .def').toBeGreaterThan(0);
      expect(fsPy.length, 'assetsRoot 应有脚本').toBeGreaterThan(0);

      const scannedEntities = (await findFilesAcrossRoots('**/entities.xml', PY_SCAN_EXCLUDE))
        .filter(uri => normalize(uri.fsPath).startsWith(normalize(ASSETS)));
      const scannedDefs = (await findFilesAcrossRoots('**/*.def', null))
        .filter(uri => normalize(uri.fsPath).startsWith(normalize(ASSETS)));
      const scannedPy = (await findFilesAcrossRoots('**/*.py', PY_SCAN_EXCLUDE))
        .filter(uri => normalize(uri.fsPath).startsWith(normalize(ASSETS)));
      expect(scannedEntities.length, 'entities.xml 全扫到').toBe(fsEntities.length);
      expect(scannedDefs.length, '.def 全扫到').toBe(fsDefs.length);
      expect(scannedPy.length, '脚本全扫到').toBe(fsPy.length);

      // ── ④ .def 入索引(多根 loader:外部资产根的 def 按名解析得到) ──
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      await manager.resolveMethodDefinitionForClass('Account', '__init__'); // 触发构造期扫描
      const account = manager.getAllMappings().find(mapping => mapping.name === 'Account');
      expect(account, 'assetsRoot 下的 Account.def 应入索引').toBeTruthy();
      expect(normalize(account!.defFile), '索引里的 def 文件在 assetsRoot 下')
        .toContain('python_assets/scripts/entity_defs/Account.def');

      // ── ⑤ entities.xml 入组合根派生(workspace 无此文件,命中即来自 assetsRoot) ──
      const index = new PythonClassIndex();
      expect(await index.rootsContaining('Account')).toEqual(['Account']);

      // ── ⑥ 跳转:assetsRoot 独有文件 Poller.py(workspace 下不存在)的 self 调用 → 同文件定义 ──
      const pollerAbs = path.join(ASSETS, 'scripts', 'interface', 'Poller.py');
      expect(fs.existsSync(path.join(TOOLS, 'scripts', 'interface', 'Poller.py')), '调用文件只在 assetsRoot').toBe(false);
      const pollerText = fs.readFileSync(pollerAbs, 'utf8');
      const callLine = lineOf(pollerText, 'self.processData(');
      const defLine = lineOf(pollerText, 'def processData');
      const provider = new PythonDefinitionProvider(manager, index);
      const document = makeTextDocument(pollerText, { fileName: pollerAbs, languageId: 'python' });
      const char = pollerText.split('\n')[callLine].indexOf('processData') + 3;
      const traced = await provider.provideDefinitionTraced(document, new Position(callLine, char));
      expect(traced.layers.map(layer => `${layer.layer}:${layer.status}`), '层1 落空 → 层2 命中')
        .toEqual(['entity-def:miss', 'python-mro:hit']);
      const loc = traced.location as { uri: { fsPath: string }; range: { start: { line: number } } };
      expect(normalize(loc.uri.fsPath)).toContain('python_assets/scripts/interface/Poller.py');
      expect(loc.range.start.line, 'processData 定义行(0-based)').toBe(defLine);

      fs.writeFileSync(
        'D:/hermes/cache/scratch/kode_assetsroot_report.json',
        JSON.stringify({
          scanRoots: { workspace: TOOLS, assetsRoot: ASSETS, external: getExternalScanRoots() },
          workspaceTruth: { def: 0, entitiesXml: 0 },
          assetsRootCounts: {
            entitiesXml: fsEntities.length,
            def: fsDefs.length,
            python: fsPy.length,
            scanned: { entitiesXml: scannedEntities.length, def: scannedDefs.length, python: scannedPy.length }
          },
          index: { entity: account?.name, defFile: account?.defFile, compositionRoots: ['Account'] },
          jump: {
            call: `python_assets/scripts/interface/Poller.py:${callLine + 1}`,
            definition: `python_assets/scripts/interface/Poller.py:${defLine + 1}`,
            layers: traced.layers.map(layer => `${layer.layer}=${layer.status}`)
          }
        }, null, 2),
        'utf8'
      );
      manager.dispose();
    } finally {
      stubWorkspace.findFiles = ORIGINAL;
      stubWorkspace.workspaceFolders = [];
      configurationOverrides.delete('kbengine');
      resetScanRootCache();
    }
  }, 120_000);
});
