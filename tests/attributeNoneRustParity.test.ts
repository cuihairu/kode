/**
 * attributeNone Rust↔TS 行为对拍(AUDIT-005 B2 车道批 6,沿 readOnlyWriteRustParity
 * 先例):用真实 kode-server 二进制跑 `$/kode/lint/analyzeAttributeNone`,把 Rust
 * 词法结构面经 renderAttributeNoneRustItems 渲染(流敏感 None 证据 TS 裁定),
 * 与 TS 兜底 attributeNoneDiagnosticItems 对同一语料**全量深等**(有序数组
 * toEqual:range/message/severity/source/code 逐条一致)。
 *
 * 分工:Rust = 预掩码文本词法扫描(match[0].indexOf 首次出现语义逐字对齐);
 * TS = 掩码单一来源 + 流敏感 None 证据 + 消息渲染。入参 text = 预掩码文本
 * (与生产装配 buildAttributeNoneItemsWithRust 同一条路径);原文零 `self.` 线索
 * 生产序短路不发 RPC(掩码只减不增,两侧空面)。
 * 语料 = 合成样本(None 证据全族/窄化全族/内建跳过/indexOf 同名成员/掩码面/
 * 多命中/非 ASCII 列)+ 真实 fixture .py 全量。
 *
 * 与 kodeCoreE2E 同口径:二进制缺失(未构建 Rust)则整套 skip,不破坏纯 TS
 * 门禁;二进制在场则跑真实 RPC。versionKey 每样本唯一(流解析缓存按版本键,
 * 同键异文会撞)。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import { maskPythonNonCode } from '../src/backend/pythonLexicalMask';
import {
  ATTRIBUTE_NONE_DIAGNOSTIC_CODE,
  attributeNoneDiagnosticItems,
  renderAttributeNoneRustItems
} from '../src/backend/selfAttributeNoneDiagnostics';

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

/** findings → 诊断项(与 diagnostics.ts attributeNone 臂映射同形) */
function itemsOf(findings: ReturnType<typeof attributeNoneDiagnosticItems>) {
  return findings.map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.member.length }
    },
    message: finding.message,
    severity: 'Warning' as const,
    source: 'kbengine' as const,
    code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE
  }));
}

/**
 * 合成样本:__init__ None 无守卫报/守卫窄化不报/= [] 覆盖不报/类级 None 报/
 * 内建 receiver 跳过/非 None 属性不报/早退守卫/同行同属性多成员/indexOf 同名
 * 成员(self.id.id)/掩码面(字符串注释提及)/非 ASCII 列/零线索短路/空文本。
 */
const SYNTHETIC_SAMPLES: Array<{ label: string; text: string }> = [
  {
    label: 'none-init-no-guard',
    text: 'class Foo:\n    def __init__(self):\n        self.TalentTree = None\n    def method(self):\n        self.TalentTree.get(0)\n'
  },
  {
    label: 'guard-narrowed',
    text: 'class Foo:\n    def __init__(self):\n        self.TalentTree = None\n    def method(self):\n        if self.TalentTree is None:\n            self.TalentTree = make_tree()\n        self.TalentTree.get(0)\n'
  },
  {
    label: 'reassign-narrowed',
    text: 'class Foo:\n    def __init__(self):\n        self.TalentTree = None\n        self.TalentTree = []\n    def other(self):\n        self.TalentTree.get(0)\n'
  },
  {
    label: 'class-level-none',
    text: 'class Foo:\n    TalentTree = None\n    def method(self):\n        self.TalentTree.get(0)\n'
  },
  {
    label: 'builtin-receivers',
    text: 'class Foo:\n    def method(self):\n        self.cell.tick()\n        self.base.create()\n        self.client.req()\n'
  },
  {
    label: 'non-none-attr',
    text: 'class Foo:\n    def __init__(self):\n        self.X = []\n    def method(self):\n        self.X.append(1)\n'
  },
  {
    label: 'early-return-guard',
    text: 'class Foo:\n    def __init__(self):\n        self.X = None\n    def method(self):\n        if self.X is None:\n            return\n        self.X.append(1)\n'
  },
  {
    label: 'same-line-two-members',
    text: 'class Foo:\n    def __init__(self):\n        self.cfg = None\n    def method(self):\n        self.cfg.load(); self.cfg.save()\n'
  },
  {
    label: 'indexof-same-name-member',
    text: 'class Foo:\n    def __init__(self):\n        self.id = None\n    def method(self):\n        self.id.id\n'
  },
  {
    label: 'masked-string-comment',
    text: '# self.TalentTree.get(0)\ns = "self.TalentTree.get(0)"\nclass Foo:\n    def __init__(self):\n        self.TalentTree = None\n    def method(self):\n        self.TalentTree.get(0)\n'
  },
  {
    label: 'non-ascii-column',
    text: 'class Foo:\n    def __init__(self):\n        self.cfg = None\n    def method(self):\n        log("庆祝"); self.cfg.load()\n'
  },
  {
    label: 'shape-fails',
    text: 'self.x\nself.5y.z\nself.q.()\nmyself.a.b\n_self.a.b\n'
  },
  {
    label: 'zero-clue',
    text: 'print(1)\nx = self\nd = obj.attr\n'
  },
  { label: 'empty', text: '' }
];

const suite = binaryReady ? describe : describe.skip;

suite('attributeNone Rust↔TS 行为对拍(真实 kode-server)', () => {
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
      expect(samples.length).toBeGreaterThan(13);
      for (const sample of samples) {
        const versionKey = `parity-attr:${sample.label}`;
        const tsItems = itemsOf(attributeNoneDiagnosticItems(sample.text, undefined, versionKey));
        // 生产装配同序短路:原文零 self. 线索 → 兜底面即 [],不发 RPC
        if (!sample.text.includes('self.')) {
          expect(tsItems, `${sample.label}: TS 短路面应为空`).toEqual([]);
          continue;
        }
        const masked = maskPythonNonCode(sample.text);
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzeAttributeNone',
          params: { text: masked }
        })) as { items?: unknown };
        const rustItems = resp.items ?? [];
        const rendered = renderAttributeNoneRustItems(rustItems, masked, versionKey);
        expect(
          rendered,
          `${sample.label}: Rust 结构面含畸形条目(整面作废语义)`
        ).not.toBeNull();
        expect(
          itemsOf(rendered!),
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
      const itemsFor = async (text: string) => {
        const masked = maskPythonNonCode(text);
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzeAttributeNone',
          params: { text: masked }
        })) as { items?: Array<{ code: string; attr: string; member: string; character: number }> };
        return resp.items ?? [];
      };
      // 裸访问报 1:attr/member/成员列逐项(流证据=TS 单独裁定,此处只验词法面)
      const bare = await itemsFor('class Foo:\n    def m(self):\n        self.tree.get(0)\n');
      expect(bare).toHaveLength(1);
      expect(bare[0].code).toBe('kbengine.attributeNone');
      expect(bare[0].attr).toBe('tree');
      expect(bare[0].member).toBe('get');
      // 匹配起点 36(前两行偏移)+ 'self.tree.get' 内 indexOf('get') = 10
      expect(bare[0].character).toBe(46);
      // 内建 receiver 跳过 / 形态失败零报
      expect(await itemsFor('self.cell.tick()\n')).toHaveLength(0);
      expect(await itemsFor('self.x.()\n')).toHaveLength(0);
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 60000);
});
