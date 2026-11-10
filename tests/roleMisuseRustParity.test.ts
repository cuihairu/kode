/**
 * roleMisuse Rust↔TS 行为对拍(AUDIT-005 B2 车道批 2,沿 trapLintsRustParity
 * 先例):用真实 kode-server 二进制跑 `$/kode/lint/analyzeRoleMisuse`,把 Rust
 * 结构面经 renderRustRoleMisuseItems 渲染,与 TS 兜底 findRoleMisuseFindings
 * (同面表 ROLE_MISUSE_TABLES)对同一语料**全量深等**(有序数组 toEqual:
 * range/message/severity/source/code 逐条一致)。
 *
 * 语料 = 合成样本(逐面命中/边界/掩码面)+ 真实 fixture .py 全量 × 三面
 * (现实文本覆盖)。面表用真实引擎表(TS 桥接给 Rust,与静态表同源)。
 *
 * 与 kodeCoreE2E 同口径:二进制缺失(未构建 Rust)则整套 skip,不破坏
 * 纯 TS 门禁;二进制在场则跑真实 RPC。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import {
  findRoleMisuseFindings,
  renderRustRoleMisuseItems,
  roleMisuseFindingsToItems,
  ROLE_MISUSE_TABLES,
  ROLE_MISUSE_DIAGNOSTIC_CODE
} from '../src/backend/roleMisuseDiagnostics';
import type { EntityComponentFace } from '../src/backend/entityBuiltinProperties';

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const binaryReady = existsSync(binaryPath);

const FIXTURE_ROOT = join(repoRoot, 'tests', 'fixtures');

const FACES: readonly EntityComponentFace[] = ['baseapp', 'cellapp', 'client'];

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
 * 合成样本:逐面命中/边界/掩码/多段面确定性覆盖。属性名用真实引擎表
 * 成员(velocity[client]/position[cellapp,client]/layer[cellapp]/
 * databaseID[baseapp]/id+isDestroyed[宏公共三面]),语义可人工核。
 */
const SYNTHETIC_SAMPLES: Array<{ label: string; text: string }> = [
  { label: 'velocity-on-base', text: 'self.velocity = 1.0\n' },
  { label: 'position-on-base', text: 'self.position = (1, 2, 3)\n' },
  { label: 'databaseID-on-cell', text: 'x = self.databaseID\n' },
  { label: 'layer-on-client', text: 'print(self.layer)\n' },
  { label: 'legal-no-report', text: 'self.id\nself.isDestroyed\nself.client.cell.call()\n' },
  { label: 'mask-comment-string', text: '# self.layer\ns = "self.layer"\nprint(self.layer)\n' },
  { label: 'multi-one-line', text: 'self.velocity = self.layer\n' },
  { label: 'boundaries', text: 'myself.position\nself.position.x\nself.\n' },
  { label: 'non-ascii-offset', text: '# 速度 self.velocity\nprint("速度", self.velocity)\n' }
];

const suite = binaryReady ? describe : describe.skip;

suite('roleMisuse Rust↔TS 行为对拍(真实 kode-server)', () => {
  it('Rust 结构面渲染 ≡ TS 兜底(全量深等,合成+fixture,三面)', async () => {
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
      expect(samples.length).toBeGreaterThan(8);
      for (const face of FACES) {
        for (const sample of samples) {
          const resp = (await client.request('$/kode/rpc', {
            method: '$/kode/lint/analyzeRoleMisuse',
            params: {
              text: sample.text,
              face,
              facePropertyNames: ROLE_MISUSE_TABLES
            }
          })) as { items?: unknown };
          const rustItems = resp.items ?? [];
          const rendered = renderRustRoleMisuseItems(rustItems, face, ROLE_MISUSE_TABLES);
          expect(
            rendered,
            `${sample.label}[${face}]: Rust 结构面含畸形/矛盾条目(整面作废语义)`
          ).not.toBeNull();
          const tsItems = roleMisuseFindingsToItems(
            findRoleMisuseFindings(sample.text, face, null, ROLE_MISUSE_TABLES)
          );
          expect(
            rendered,
            `${sample.label}[${face}]: Rust ≠ TS(能力丢失/漂移)`
          ).toEqual(tsItems);
        }
      }
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 60000);

  it('合成样本逐面断言面健全(命中在位/边界零报,防双侧同错空转)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined,
    });
    await client.start();
    try {
      const itemsFor = async (text: string, face: EntityComponentFace) => {
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzeRoleMisuse',
          params: { text, face, facePropertyNames: ROLE_MISUSE_TABLES }
        })) as { items?: Array<{ code: string; propertyName: string; line: number }> };
        return resp.items ?? [];
      };
      // velocity(client-only)于 base 面报 1,于 cell 报 1,于 client 零报(合法)
      expect(await itemsFor('self.velocity = 1.0\n', 'baseapp')).toHaveLength(1);
      expect(await itemsFor('self.velocity = 1.0\n', 'cellapp')).toHaveLength(1);
      expect(await itemsFor('self.velocity = 1.0\n', 'client')).toHaveLength(0);
      // 宏公共 id 三面零报
      expect(await itemsFor('self.id\n', 'baseapp')).toHaveLength(0);
      expect(await itemsFor('self.id\n', 'cellapp')).toHaveLength(0);
      expect(await itemsFor('self.id\n', 'client')).toHaveLength(0);
      // 一行两处各自成条
      const multi = await itemsFor('self.velocity = self.layer\n', 'baseapp');
      expect(multi.map(item => item.propertyName)).toEqual(['velocity', 'layer']);
      // 掩码:注释/字符串内不报,真实访问报 1
      const masked = await itemsFor('# self.layer\ns = "self.layer"\nprint(self.layer)\n', 'baseapp');
      expect(masked).toHaveLength(1);
      expect(masked[0].line).toBe(2);
      // 边界:无 `\b` 左界/后随 `.`/空属性 → 零报
      expect(await itemsFor('myself.position\nself.position.x\nself.\n', 'baseapp')).toHaveLength(0);
      // code 面
      const first = await itemsFor('self.velocity = 1.0\n', 'baseapp');
      expect(first[0].code).toBe(ROLE_MISUSE_DIAGNOSTIC_CODE);
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 30000);
});
