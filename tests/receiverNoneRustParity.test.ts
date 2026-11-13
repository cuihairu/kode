/**
 * receiverNone Rust↔TS 行为对拍(AUDIT-005 B2 车道批 3,沿 spaceNavRustParity
 * 先例):用真实 kode-server 二进制跑 `$/kode/lint/analyzeReceiverNone`,把 Rust
 * 结构面经 renderRustReceiverNoneItems 渲染,与 TS 兜底 receiverNoneDiagnosticItems
 * 对同一语料**全量深等**(有序数组 toEqual:range/message/severity/source/code
 * 逐条一致)。
 *
 * 语义面由 TS 供给(方法区间 = parsePythonFile;段声明 = 合成表),与生产装配
 * (buildReceiverNoneItemsWithRust)同一条入参路径。语料 = 合成样本(guard
 * 全族命中/边界/掩码/别名/段错配)+ 真实 fixture .py 全量。
 *
 * 与 kodeCoreE2E 同口径:二进制缺失(未构建 Rust)则整套 skip,不破坏
 * 纯 TS 门禁;二进制在场则跑真实 RPC。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import { parsePythonFile } from '../src/backend/pythonParser';
import {
  renderRustReceiverNoneItems,
  receiverNoneDiagnosticItems
} from '../src/backend/receiverNoneDiagnostics';
import type { EntityMapping } from '../src/entityMapping';
import { pythonScriptDomain } from '../src/entityMapping';

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

/** 最小 EntityMapping 替身(渲染/兜底只用 methods 面) */
function mappingWith(declarations: Record<string, string[]>): EntityMapping {
  const methods: EntityMapping['methods'] = {};
  for (const [name, sections] of Object.entries(declarations)) {
    methods[name] = sections.map(section => ({
      defFile: 'demo.def',
      line: 1,
      section: section as 'BaseMethods' | 'CellMethods' | 'ClientMethods',
      exposed: true,
      identity: {
        ownerKind: 'entity' as const,
        ownerName: 'Demo',
        sourceKind: 'local' as const,
        sourceChain: [],
        symbolName: name
      }
    }));
  }
  return {
    name: 'Demo',
    defFile: 'demo.def',
    pythonFile: 'demo.py',
    pythonFiles: ['demo.py'],
    properties: {},
    methods
  };
}

/**
 * 合成样本:guard 全族(正向真值/is not None/not(is None)/校验器/早退 return/
 * 早退 raise/别名/别名重绑失效/嵌套 def 不跨界/单行 if/三元)+ 掩码面(注释/
 * 字符串/f-string)+ 段错配(错配成条/同段不报)+ 多接收者混排 + 非 ASCII 偏移。
 */
const SYNTHETIC_SAMPLES: Array<{
  label: string;
  text: string;
  declarations?: Record<string, string[]>;
}> = [
  {
    label: 'no-guard',
    text: 'class Avatar:\n    def onSay(self):\n        self.cell.doAttack()\n'
  },
  {
    label: 'guard-truthy',
    text: 'class Avatar:\n    def onSay(self):\n        if self.cell:\n            self.cell.doAttack()\n'
  },
  {
    label: 'guard-is-not-none',
    text: 'class Avatar:\n    def onSay(self):\n        if self.cell is not None:\n            self.cell.doAttack()\n'
  },
  {
    label: 'guard-not-is-none',
    text: 'class Avatar:\n    def onSay(self):\n        if not (self.cell is None):\n            self.cell.doAttack()\n'
  },
  {
    label: 'guard-validator',
    text: 'class Avatar:\n    def onSay(self):\n        if kbe.isValid(self.cell):\n            self.cell.doAttack()\n'
  },
  {
    label: 'guard-early-return',
    text: 'class Avatar:\n    def onSay(self):\n        if not self.cell:\n            return\n        self.cell.doAttack()\n'
  },
  {
    label: 'guard-early-raise',
    text: 'class Avatar:\n    def onSay(self):\n        if self.cell is None:\n            raise RuntimeError("offline")\n        self.cell.doAttack()\n'
  },
  {
    label: 'guard-conjunct',
    text: 'class Avatar:\n    def onSay(self):\n        if self.cell and self.cell.isReady:\n            self.cell.doAttack()\n'
  },
  {
    label: 'guard-or-unknown',
    text: 'class Avatar:\n    def onSay(self):\n        if self.base or self.cell:\n            self.cell.doAttack()\n'
  },
  {
    label: 'alias-guarded',
    text: 'class Avatar:\n    def onSay(self):\n        cell = self.cell\n        if cell:\n            cell.doAttack()\n'
  },
  {
    label: 'alias-rebind-invalidates',
    text: 'class Avatar:\n    def onSay(self):\n        cell = self.cell\n        if cell:\n            cell = None\n            self.cell.doAttack()\n'
  },
  {
    label: 'nested-def-no-cross',
    text: 'class Avatar:\n    def onSay(self):\n        if self.cell:\n            def inner():\n                self.cell.doAttack()\n            inner()\n'
  },
  {
    label: 'same-line-if',
    text: 'class Avatar:\n    def onSay(self):\n        if self.cell: self.cell.doAttack()\n'
  },
  {
    label: 'same-line-ternary',
    text: 'class Avatar:\n    def onSay(self):\n        v = self.cell.doAttack() if self.cell else 0\n'
  },
  {
    label: 'mask-comment-string',
    text: 'class Avatar:\n    def onSay(self):\n        # self.cell.doAttack()\n        s = "self.cell.doAttack()"\n'
  },
  {
    label: 'mask-fstring',
    text: 'class Avatar:\n    def onSay(self):\n        log(f"cell={self.cell}")\n        self.cell.doAttack()\n'
  },
  {
    label: 'mismatch-reports',
    text: 'class Avatar:\n    def onSay(self):\n        self.base.doAttack()\n',
    declarations: { doAttack: ['CellMethods'] }
  },
  {
    label: 'match-no-report',
    text: 'class Avatar:\n    def onSay(self):\n        self.base.doAttack()\n',
    declarations: { doAttack: ['BaseMethods'] }
  },
  {
    label: 'mixed-receivers',
    text: 'class Avatar:\n    def onSay(self):\n        self.client.someRpc()\n        self.base.createCellEntity("Cell")\n        self.cell.doAttack()\n'
  },
  {
    label: 'non-ascii-offsets',
    text: 'class Avatar:\n    def onSay(self):\n        print("庆祝🎉") ; self.cell.doAttack()\n'
  },
  {
    label: 'multiline-continuation',
    text: 'class Avatar:\n    def onSay(self, a, b):\n        if (a and\n                b):\n            self.cell.doAttack()\n'
  },
  { label: 'empty', text: '' }
];

const suite = binaryReady ? describe : describe.skip;

suite('receiverNone Rust↔TS 行为对拍(真实 kode-server)', () => {
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
      const samples = [...SYNTHETIC_SAMPLES.map(sample => ({ ...sample, label: sample.label })), ...fixtureTexts];
      expect(samples.length).toBeGreaterThan(22);
      for (const sample of samples) {
        const parsed = parsePythonFile(sample.text, sample.label);
        const methods = parsed.classes.map(cls => ({
          startLine: cls.startLine,
          endLine: cls.endLine,
          defLines: [...cls.methods.values()].map(location => location.line)
        }));
        const declarations: Record<string, string[]> = {};
        const mapping = 'declarations' in sample && sample.declarations
          ? mappingWith(sample.declarations)
          : undefined;
        if (mapping) {
          for (const [name, locations] of Object.entries(mapping.methods)) {
            declarations[name] = locations.map(location => location.section);
          }
        }
        // 逐面语义闸(深审-3):生产装配面从文档路径换算调用面下发给 Rust
        // (buildReceiverNoneItemsWithRust 同口径),两侧同输入对拍才成立
        const callerFace = pythonScriptDomain(sample.label) ?? undefined;
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzeReceiverNone',
          params: { text: sample.text, methods, declarations, callerFace }
        })) as { items?: unknown };
        const rustItems = resp.items ?? [];
        const rendered = renderRustReceiverNoneItems(rustItems, mapping);
        expect(
          rendered,
          `${sample.label}: Rust 结构面含畸形条目(整面作废语义)`
        ).not.toBeNull();
        const tsItems = receiverNoneDiagnosticItems(sample.text, sample.label, mapping, true);
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
      const itemsFor = async (
        text: string,
        methods: Array<{ startLine: number; endLine: number; defLines: number[] }>,
        declarations: Record<string, string[]> = {},
        callerFace?: string
      ) => {
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzeReceiverNone',
          params: { text, methods, declarations, callerFace }
        })) as { items?: Array<{ code: string; kind: string; line: number; character: number; receiver: string; methodName: string }> };
        return resp.items ?? [];
      };
      const methods = [{ startLine: 0, endLine: 5, defLines: [1] }];
      // 无 guard 报 1 / 正向与早退守卫零报 / 校验器守卫零报
      const bare = await itemsFor('class A:\n    def f(self):\n        self.cell.foo()\n', methods);
      expect(bare).toHaveLength(1);
      expect(bare[0].kind).toBe('receiverNone');
      expect(bare[0].character).toBe(18);
      expect(bare[0].methodName).toBe('foo');
      expect(await itemsFor('class A:\n    def f(self):\n        if self.cell:\n            self.cell.foo()\n', methods)).toHaveLength(0);
      expect(await itemsFor('class A:\n    def f(self):\n        if not self.cell:\n            return\n        self.cell.foo()\n', methods)).toHaveLength(0);
      expect(await itemsFor('class A:\n    def f(self):\n        if kbe.isValid(self.cell):\n            self.cell.foo()\n', methods)).toHaveLength(0);
      // 段错配成条(receiverNone 在前)/ 同段不报 / 段声明空不报
      const mismatch = await itemsFor(
        'class A:\n    def f(self):\n        self.base.jump()\n',
        methods,
        { jump: ['CellMethods'] }
      );
      expect(mismatch.map(item => item.kind)).toEqual(['receiverNone', 'sectionMismatch']);
      expect(mismatch[1].code).toBe('kbengine.sectionMismatch');
      expect(await itemsFor('class A:\n    def f(self):\n        self.base.jump()\n', methods, { jump: ['BaseMethods'] }))
        .toHaveLength(1);
      expect(await itemsFor('class A:\n    def f(self):\n        self.base.jump()\n', methods, {}))
        .toHaveLength(1);
      // 注释/字符串掩码零报
      expect(await itemsFor('class A:\n    def f(self):\n        # self.cell.foo()\n        s = "self.cell.foo()"\n', methods))
        .toHaveLength(0);
      // 逐面语义闸(wire 契约,深审-3):callerFace=cell → self.cell(AttributeError
      // 面)滤除,self.base 照常报;face 缺省(旧口径)两处都报
      const faceSample = 'class A:\n    def f(self):\n        self.cell.foo()\n        self.base.bar()\n';
      const faceFiltered = await itemsFor(faceSample, methods, {}, 'cell');
      expect(faceFiltered).toHaveLength(1);
      expect(faceFiltered[0].receiver).toBe('base');
      expect(faceFiltered[0].methodName).toBe('bar');
      expect(await itemsFor(faceSample, methods)).toHaveLength(2);
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 60000);
});
