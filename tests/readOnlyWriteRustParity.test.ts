/**
 * readOnlyWrite Rust↔TS 行为对拍(AUDIT-005 B2 车道批 5,沿 postDestroyRustParity
 * 先例):用真实 kode-server 二进制跑 `$/kode/lint/analyzeReadOnlyWrite`,把 Rust
 * 结构面经 renderRustReadOnlyWriteItems 渲染(属性表重解析完整性校验),与 TS
 * 兜底 findReadOnlyWriteFindings 对同一语料**全量深等**(有序数组 toEqual:
 * range/message/severity/source/code 逐条一致)。
 *
 * 语义闸由 TS 供给(readonlyNames = face 表 readonly 名集,与生产装配
 * buildReadOnlyWriteItemsWithRust 同一条入参路径;face=null 只查宏公共 3)。
 * 语料 = 合成样本(写入形态全族/排除形态/掩码/多命中/非 ASCII 列)+ 真实
 * fixture .py 全量。
 *
 * 与 kodeCoreE2E 同口径:二进制缺失(未构建 Rust)则整套 skip,不破坏
 * 纯 TS 门禁;二进制在场则跑真实 RPC。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import {
  getEntityBuiltinPropertiesForFace,
  type EntityComponentFace
} from '../src/backend/entityBuiltinProperties';
import { findReadOnlyWriteFindings, renderRustReadOnlyWriteItems } from '../src/backend/readOnlyWriteDiagnostics';

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

/** face 表 readonly 名集(与生产装配同一条供给路径) */
const readonlyNamesOf = (face: EntityComponentFace | null): string[] =>
  getEntityBuiltinPropertiesForFace(face)
    .filter(property => property.readonly)
    .map(property => property.name);

/** TS 兜底 findings → 诊断项(与 readOnlyWriteDiagnosticItemsAsync 映射同形) */
function tsItemsOf(
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null
) {
  return findReadOnlyWriteFindings(text, pathFace, defFaces).map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning' as const,
    source: 'kbengine' as const,
    code: finding.code
  }));
}

/**
 * 合成样本:普通/增强(两字符+三字符)/注解/def 头同行注解/一行体套件冒号/
 * del(整词/双空白/括号边界)/比较与值上下文排除/海象/续写/下标/可写属性/
 * 掩码面(字符串注释 f-string)/多命中序/非 ASCII 列。face 变体覆盖
 * pathFace/baseapp、无目录域+def 唯一面、无目录域+def 多面(宏公共 3)。
 */
const SYNTHETIC_SAMPLES: Array<{
  label: string;
  text: string;
  pathFace?: EntityComponentFace | null;
  defFaces?: readonly EntityComponentFace[] | null;
}> = [
  {
    label: 'assign',
    text: 'class Avatar:\n    def onSay(self):\n        self.id = 1\n',
    pathFace: 'cellapp'
  },
  {
    label: 'augmented-two',
    text: 'self.id += 1\nself.className -= 2\n',
    pathFace: 'cellapp'
  },
  {
    label: 'augmented-three',
    text: 'self.id **= 2\nself.id //= 2\nself.isDestroyed <<= 1\nself.id >>= 1\n',
    pathFace: 'cellapp'
  },
  {
    label: 'annotated',
    text: 'self.id: int = 0\n',
    pathFace: 'baseapp'
  },
  {
    label: 'def-header-annotated',
    text: 'def m(self): self.id: int = 0\n',
    pathFace: 'baseapp'
  },
  {
    label: 'suite-colon-body',
    text: 'if self.isDestroyed: self.counter = 0\n',
    pathFace: 'baseapp'
  },
  {
    label: 'del-forms',
    text: 'del self.id\ndel  self.className\ndel (self.id)\n',
    pathFace: 'cellapp'
  },
  {
    label: 'comparisons-value-context',
    text: 'x = self.id == 1\ny = self.id != 2\nz = self.id >= 3\nw = self.id + 4\nv = self.id if ok else 0\n',
    pathFace: 'baseapp'
  },
  {
    label: 'walrus',
    text: 'self.id := 1\n',
    pathFace: 'baseapp'
  },
  {
    label: 'attr-chain-subscript',
    text: 'self.id.x = 1\nself.id[0] = 2\ndel self.id.x\n',
    pathFace: 'cellapp'
  },
  {
    label: 'writable-prop',
    text: 'self.position = (0, 0, 0)\nself.velocity += 1\n',
    pathFace: 'cellapp'
  },
  {
    label: 'masked',
    text: '# self.id = 1\ns = "self.id = 1"\nlog(f"hp={self.id}")\n',
    pathFace: 'cellapp'
  },
  {
    label: 'multi-order',
    text: 'def f(self):\n    self.id = 1\n    del self.className\n    self.cell = None\n',
    pathFace: 'baseapp'
  },
  {
    label: 'non-ascii-column',
    text: 's = "庆祝" ; self.id = 1\n',
    pathFace: 'baseapp'
  },
  {
    label: 'multiline-annotated',
    text: 'self.id: (\n    int\n) = 0\n',
    pathFace: 'baseapp'
  },
  {
    label: 'no-face',
    text: 'class Avatar:\n    def onSay(self):\n        self.id = 1\n',
    pathFace: null
  },
  {
    label: 'def-unique-face',
    text: 'self.cell = None\nself.id = 1\n',
    pathFace: null,
    defFaces: ['cellapp']
  },
  {
    label: 'def-multi-face-common-only',
    text: 'self.cell = None\nself.id = 1\nself.position = (0, 0, 0)\n',
    pathFace: null,
    defFaces: ['baseapp', 'cellapp']
  },
  { label: 'empty', text: '', pathFace: 'cellapp' }
];

const suite = binaryReady ? describe : describe.skip;

suite('readOnlyWrite Rust↔TS 行为对拍(真实 kode-server)', () => {
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
      expect(samples.length).toBeGreaterThan(18);
      for (const sample of samples) {
        const pathFace = sample.pathFace !== undefined ? sample.pathFace : 'cellapp';
        const defFaces = sample.defFaces !== undefined ? sample.defFaces : null;
        const tsItems = tsItemsOf(sample.text, pathFace, defFaces);
        // 生产装配同序短路:非实体脚本(路径面无 def 归属)→ 兜底面即 [],不发 RPC
        const isEntityScript = pathFace !== null || (defFaces !== null && defFaces.length > 0);
        if (!isEntityScript) {
          expect(tsItems, `${sample.label}: TS 短路面应为空`).toEqual([]);
          continue;
        }
        const face = pathFace ?? (defFaces !== null && defFaces.length === 1 ? defFaces[0] : null);
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzeReadOnlyWrite',
          params: { text: sample.text, readonlyNames: readonlyNamesOf(face) }
        })) as { items?: unknown };
        const rustItems = resp.items ?? [];
        const rendered = renderRustReadOnlyWriteItems(rustItems, pathFace, defFaces);
        expect(
          rendered,
          `${sample.label}: Rust 结构面含畸形条目(整面作废语义)`
        ).not.toBeNull();
        expect(
          rendered,
          `${sample.label}: Rust ≠ TS(能力丢失/漂移)`
        ).toEqual(tsItems);
      }
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 120000);

  it('合成样本逐面健全(命中在位/边界零报,防双侧同错空转)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined,
    });
    await client.start();
    try {
      const itemsFor = async (text: string, face: EntityComponentFace | null) => {
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzeReadOnlyWrite',
          params: { text, readonlyNames: readonlyNamesOf(face) }
        })) as { items?: Array<{ code: string; kind: string; propertyName: string; character: number }> };
        return resp.items ?? [];
      };
      // 裸赋值报 1:形态/属性名逐项
      const bare = await itemsFor('self.id = 1\n', 'baseapp');
      expect(bare).toHaveLength(1);
      expect(bare[0].code).toBe('kbengine.readOnlyWrite');
      expect(bare[0].kind).toBe('assign');
      expect(bare[0].propertyName).toBe('id');
      expect(bare[0].character).toBe(0);
      // 增强与 del 形态逐项 / 一行体套件冒号零报 / 比较零报 / 可写属性零报
      expect((await itemsFor('self.cell += 1\n', 'baseapp'))[0].kind).toBe('augmented');
      expect((await itemsFor('del self.id\n', 'baseapp'))[0].kind).toBe('del');
      expect(await itemsFor('if self.isDestroyed: x = 1\n', 'baseapp')).toHaveLength(0);
      expect(await itemsFor('x = self.id == 1\n', 'baseapp')).toHaveLength(0);
      expect(await itemsFor('self.position = (0, 0, 0)\n', 'cellapp')).toHaveLength(0);
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 60000);
});
