/**
 * spaceNav Rust↔TS 行为对拍(AUDIT-005 B2 车道批 3,沿 roleMisuseRustParity
 * 先例):用真实 kode-server 二进制跑 `$/kode/lint/analyzeSpaceNav`,把 Rust
 * 结构面经 renderRustSpaceNavItems 渲染,与 TS 兜底 computeSpaceNavFindings
 * 对同一语料**全量深等**(有序数组 toEqual:line/start/end/message/code 逐条一致)。
 *
 * 语料 = 合成样本(三子检查命中/边界/掩码面)+ 真实 fixture .py 全量。
 *
 * 与 kodeCoreE2E 同口径:二进制缺失(未构建 Rust)则整套 skip,不破坏
 * 纯 TS 门禁;二进制在场则跑真实 RPC。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import {
  computeSpaceNavFindings,
  renderRustSpaceNavItems,
  SPACE_NAV_DIAGNOSTIC_CODE
} from '../src/backend/spaceNavDiagnostics';

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const binaryReady = existsSync(binaryPath);

const FIXTURE_ROOT = join(repoRoot, 'tests', 'fixtures');

/** 递归收集 fixture .py(现实语料;对拍不挑内容,双实现同输入即可) */
function collectPythonFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectPythonFiles(full, out);
    } else if (entry.endsWith('.py')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 合成样本:三子检查各自命中/边界/掩码/多命中确定性覆盖。
 * 1) _mapping 保留键:set/del 双路径、非 _mapping 键不报、注释/字符串掩码;
 * 2) navigate 无 canNavigate:有守卫不报、无守卫报、注释/字符串掩码;
 * 3) params 引号键:顶层引号键报、int 键不报、嵌套引号键不报。
 */
const SYNTHETIC_SAMPLES: Array<{ label: string; text: string }> = [
  { label: 'mapping-set', text: 'self.setSpaceData("foo", "_mapping")\n' },
  { label: 'mapping-del', text: 'self.delSpaceData("foo", "_mapping")\n' },
  { label: 'mapping-nonreserved', text: 'self.setSpaceData("foo", "path")\n' },
  { label: 'mapping-mask', text: '# self.setSpaceData("a", "_mapping")\ns = "self.setSpaceData(\\"a\\", \\"_mapping\\")"\n' },
  { label: 'navigate-no-guard', text: 'def f(self):\n    self.navigate(1)\n' },
  { label: 'navigate-guarded', text: 'def f(self):\n    if self.canNavigate():\n        self.navigate(1)\n' },
  { label: 'navigate-pathpoints', text: 'self.navigatePathPoints([1, 2, 3])\n' },
  { label: 'navigate-mask', text: '# self.navigate(1)\ns = "self.navigate(1)"\n' },
  { label: 'params-string-key', text: 'self.addSpaceGeometryMapping(0, 1, 2, 3, {"0": "x.navmesh"})\n' },
  { label: 'params-int-key', text: 'self.addSpaceGeometryMapping(0, 1, 2, 3, {0: "x.navmesh"})\n' },
  { label: 'params-nested-string-key', text: 'self.addSpaceGeometryMapping(0, 1, 2, 3, {0: {"a": 1}})\n' },
  { label: 'mixed-multi', text: 'self.setSpaceData("a", "_mapping")\nself.navigate(1)\n' }
];

const suite = binaryReady ? describe : describe.skip;

suite('spaceNav Rust↔TS 行为对拍(真实 kode-server)', () => {
  it('Rust 结构面渲染 ≡ TS 兜底(全量深等,合成+fixture)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined,
    });
    await client.start();
    try {
      const fixtureTexts = collectPythonFiles(FIXTURE_ROOT).map(file => ({
        label: `fixture:${file.slice(FIXTURE_ROOT.length + 1)}`,
        text: readFileSync(file, 'utf8')
      }));
      const samples = [...SYNTHETIC_SAMPLES, ...fixtureTexts];
      expect(samples.length).toBeGreaterThan(12);
      for (const sample of samples) {
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzeSpaceNav',
          params: { text: sample.text }
        })) as { items?: unknown };
        const rustItems = resp.items ?? [];
        const rendered = renderRustSpaceNavItems(rustItems);
        expect(
          rendered,
          `${sample.label}: Rust 结构面含畸形条目(整面作废语义)`
        ).not.toBeNull();
        const tsItems = computeSpaceNavFindings(sample.text);
        expect(
          rendered,
          `${sample.label}: Rust ≠ TS(能力丢失/漂移)`
        ).toEqual(tsItems);
      }
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 60000);

  it('合成样本逐子检查面健全(命中在位/边界零报,防双侧同错空转)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined,
    });
    await client.start();
    try {
      const itemsFor = async (text: string) => {
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzeSpaceNav',
          params: { text }
        })) as { items?: Array<{ code: string; kind: string; line: number; length: number }> };
        return resp.items ?? [];
      };
      // 1) _mapping:set 报 1 / 非保留键零报 / 掩码零报
      expect(await itemsFor('self.setSpaceData("foo", "_mapping")\n')).toHaveLength(1);
      expect(await itemsFor('self.setSpaceData("foo", "path")\n')).toHaveLength(0);
      expect(await itemsFor('# self.setSpaceData("a", "_mapping")\n')).toHaveLength(0);
      // 2) navigate:无守卫报 1 / 有守卫零报
      expect(await itemsFor('self.navigate(1)\n')).toHaveLength(1);
      expect(await itemsFor('if self.canNavigate():\n    self.navigate(1)\n')).toHaveLength(0);
      // 3) params:字符串键报 1 / int 键零报 / 嵌套字符串键零报
      expect(await itemsFor('self.addSpaceGeometryMapping(0, 1, 2, 3, {"0": "x"})\n')).toHaveLength(1);
      expect(await itemsFor('self.addSpaceGeometryMapping(0, 1, 2, 3, {0: "x"})\n')).toHaveLength(0);
      expect(await itemsFor('self.addSpaceGeometryMapping(0, 1, 2, 3, {0: {"a": 1}})\n')).toHaveLength(0);
      // 多命中各成条 + kind 判别 + code 面
      const multi = await itemsFor('self.setSpaceData("a", "_mapping")\nself.navigate(1)\n');
      expect(multi.map(item => item.kind)).toEqual(['mappingKey', 'navigateNoGuard']);
      expect(multi[0].code).toBe(SPACE_NAV_DIAGNOSTIC_CODE);
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 30000);
});
