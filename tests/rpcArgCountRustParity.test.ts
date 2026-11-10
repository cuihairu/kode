/**
 * rpcArgCount Rust↔TS 计数面对拍(AUDIT-005 B2 车道批 8,沿
 * propertyDirectionRustParity 先例):真实 kode-server 跑
 * `$/kode/lint/analyzeRpcArgCount`(params.text = **原文** + 发现面调用点,
 * counts 与 calls 序对齐),经生产装配 buildRpcArgCountsFromRust(门注入真实
 * client,校验/转换同一条路径)与 TS 本地 countCallArguments **槽位逐位深等**;
 * 再以同一 mapping 桩驱动判定面,computeRpcArgCountFindingsAsync(Rust-first)
 * ≡ computeRpcArgCountFindings(同步本地)**全量深等**——发现面/语义闸/消息
 * 渲染同一份 TS 代码,分歧只可能来自计数槽位。
 * 语料 = 合成样本(不符/相符/尾随逗号/跨行/星号实参未知/字符串与注释伪调用/
 * 无括号裸引用/名后空白/名后杂 token/字符串实参逗号/三引号实参/注释断行续扫/
 * CRLF/非 ASCII 列(含星形面字符 UTF-16 码元)/同文件多调用点/混合接收者/
 * 声明未就绪/段错配/歧义声明/声明星号形参/零线索/空)+ 真实 fixture .py 全量。
 * 与 kodeCoreE2E 同口径:二进制缺失(未构建 Rust)则整套 skip,不破坏纯 TS
 * 门禁;二进制在场则跑真实 RPC。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { buildRpcArgCountsFromRust } from '../src/backend/rpcArgCountRust';
import {
  computeRpcArgCountFindings,
  computeRpcArgCountFindingsAsync,
  countCallArguments
} from '../src/backend/rpcArgCountDiagnostics';
import { findPythonReceiverCalls } from '../src/backend/pythonLanguageUtils';
import { maskPythonNonCode } from '../src/backend/pythonLexicalMask';
import type { EntityMapping } from '../src/entityMapping';

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

// ---- mapping 桩词汇表(与 rpcArgCountDiagnostics.test.ts 同源) ---------------

/** 最小 EntityMapping 桩:只喂本诊断用到的 methods 表(section + declaredArgs) */
const mappingWithMethods = (
  methods: Record<string, Array<{ section: string; declaredArgs?: string[] }>>
): EntityMapping => ({
  methods: Object.fromEntries(
    Object.entries(methods).map(([name, defs]) => [
      name,
      defs.map(def => ({
        defFile: 'avatar.def',
        line: 10,
        section: def.section,
        exposed: false,
        declaredArgs: def.declaredArgs,
        identity: {
          ownerKind: 'method' as never,
          ownerName: 'Avatar',
          sourceKind: 'def' as never,
          sourceChain: [],
          symbolName: name
        }
      }))
    ])
  )
}) as unknown as EntityMapping;

interface Sample {
  label: string;
  text: string;
  methods: Record<string, Array<{ section: string; declaredArgs?: string[] }>>;
}

/**
 * 合成样本:数量不符/相符/尾随逗号/跨行/星号实参未知不报/字符串与注释伪调用
 * (发现面掩码去伪,计数面原文词法)/无括号裸引用(发现,计数未知)/名后空白
 * 合法/名后杂 token 未知/字符串实参含逗号/三引号实参/注释断行续扫/CRLF/
 * 非 ASCII 列(星形面字符 = 2 码元,UTF-16 基底)/同文件多调用点/混合接收者
 * 三侧/声明未就绪/段错配(语义闸)/同 section 歧义(语义闸)/声明星号形参
 * (语义闸)/零线索/空。
 */
const SYNTHETIC_SAMPLES: Sample[] = [
  {
    label: 'count-mismatch',
    text: 'self.cell.login(1, 2)\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'count-match',
    text: 'self.cell.login(1)\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'trailing-comma',
    text: 'self.cell.login(1,)\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'cross-line',
    text: 'self.cell.login(\n    1,\n    2\n)\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a', 'b'] }] }
  },
  {
    label: 'star-call-unknown',
    text: 'self.cell.login(*args)\nself.cell.login(**kw)\nself.cell.login(1, *rest)\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'masked-fake-calls',
    text: 's = "self.cell.login(1, 2)"\n# self.cell.login(1, 2)\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'bare-reference-no-paren',
    text: 'handler = self.cell.login\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'ws-before-paren',
    text: 'self.cell.login (1, 2)\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'other-token-after-name',
    text: 'self.cell.login x(1)\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'string-arg-commas',
    text: 'self.cell.login("a,b,c")\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'triple-string-arg',
    text: 'self.cell.login("""a,b(c)""")\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'comment-breaks-line',
    text: 'self.cell.login(1, # c\n    2)\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'crlf-corpus',
    text: 'self.cell.login(1,\r\n    2)\r\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'non-ascii-column-surrogate',
    text: 'log("𝐀𝐀庆祝"); self.cell.login(1, 2)\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'multi-calls',
    text: 'self.cell.login(1, 2)\nself.cell.logout()\nself.cell.login()\n',
    methods: {
      login: [{ section: 'CellMethods', declaredArgs: ['a'] }],
      logout: [{ section: 'CellMethods', declaredArgs: [] }]
    }
  },
  {
    label: 'mixed-receivers',
    text: 'self.base.login(1)\nself.cell.login(1, 2)\nself.client.login()\n',
    methods: {
      login: [
        { section: 'BaseMethods', declaredArgs: ['a'] },
        { section: 'CellMethods', declaredArgs: ['a'] },
        { section: 'ClientMethods', declaredArgs: [] }
      ]
    }
  },
  {
    label: 'undeclared-method',
    text: 'self.cell.ghost(1, 2)\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a'] }] }
  },
  {
    label: 'section-mismatch-gate',
    text: 'self.cell.login(1, 2)\n',
    methods: { login: [{ section: 'BaseMethods', declaredArgs: ['a', 'b'] }] }
  },
  {
    label: 'ambiguous-declarations-gate',
    text: 'self.cell.login(1, 2)\n',
    methods: {
      login: [
        { section: 'CellMethods', declaredArgs: ['a'] },
        { section: 'CellMethods', declaredArgs: ['a', 'b'] }
      ]
    }
  },
  {
    label: 'declared-star-arg-gate',
    text: 'self.cell.login(1, 2)\n',
    methods: { login: [{ section: 'CellMethods', declaredArgs: ['a', '*rest'] }] }
  },
  {
    label: 'zero-clue',
    text: 'print(1)\nd = obj.attr\n',
    methods: {}
  },
  { label: 'empty', text: '', methods: {} }
];

const suite = binaryReady ? describe : describe.skip;

/** 真实 client 包成门(生产装配同路径:runInRust → $/kode/rpc) */
async function withRustGate(
  run: (rpcCalls: Array<{ method: string; params: unknown }>) => Promise<void>
): Promise<void> {
  const client = new KodeCoreClient({
    binaryPath,
    initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
    onStderr: () => undefined
  });
  await client.start();
  const calls: Array<{ method: string; params: unknown }> = [];
  setKodeCoreShadowGate({
    runInRust: async (method: string, params: unknown) => {
      calls.push({ method, params });
      const result = await client.request('$/kode/rpc', { method, params });
      return { ok: true as const, result };
    }
  } as unknown as KodeCoreGate);
  try {
    await run(calls);
  } finally {
    setKodeCoreShadowGate(null);
    await client.dispose().catch(() => undefined);
  }
}

/** TS 计数面直查(发现面掩码 → 调用点;计数面原文) */
const tsCountsOf = (text: string): Array<number | null> => {
  const calls = findPythonReceiverCalls(maskPythonNonCode(text));
  const lines = text.split(/\r?\n/);
  return calls.map(call => countCallArguments(lines, call));
};

suite('rpcArgCount Rust↔TS 计数面对拍(真实 kode-server)', () => {
  it('Rust 计数槽位 ≡ TS 本地计数,判定面 ≡ 同步面(全量深等,合成+fixture)', async () => {
    await withRustGate(async calls => {
      const fixtureTexts = collectPythonFiles(FIXTURE_ROOT).map(file => ({
        label: `fixture:${file.slice(FIXTURE_ROOT.length + 1)}`,
        text: readFileSync(file, 'utf8'),
        methods: {} as Sample['methods']
      }));
      const samples = [...SYNTHETIC_SAMPLES, ...fixtureTexts];
      expect(samples.length).toBeGreaterThan(20);
      for (const sample of samples) {
        const callsBefore = calls.length;
        const rustCounts = await buildRpcArgCountsFromRust(sample.text, findPythonReceiverCalls(maskPythonNonCode(sample.text)));
        // 生产序:无调用点不发 RPC,直接合法空数组;有调用点恰好一次 RPC,
        // params.text = 原文(计数面自带词法态)
        const hasCalls = findPythonReceiverCalls(maskPythonNonCode(sample.text)).length > 0;
        if (!hasCalls) {
          expect(calls.length, `${sample.label}: 无调用点不应发 RPC`).toBe(callsBefore);
          expect(rustCounts, `${sample.label}: 无调用点应回合法空数组`).toEqual([]);
        } else {
          expect(calls.length, `${sample.label}: 应恰好一次 RPC`).toBe(callsBefore + 1);
          expect(calls[calls.length - 1].params, `${sample.label}: params.text=原文`).toHaveProperty('text', sample.text);
        }
        // 计数槽位对拍(calls 序逐位,null=未知两侧同语义)
        expect(rustCounts, `${sample.label}: Rust 计数槽位 ≠ TS 本地计数`).toEqual(
          tsCountsOf(sample.text)
        );
        // 判定面对拍(同一 mapping 桩驱动两侧,全量深等)
        const mapping = mappingWithMethods(sample.methods);
        const asyncFindings = await computeRpcArgCountFindingsAsync(sample.text, mapping);
        expect(asyncFindings, `${sample.label}: 判定面产出 ≠ 同步面(计数槽位漂移)`).toEqual(
          computeRpcArgCountFindings(sample.text, mapping)
        );
      }
    });
  }, 120000);

  it('合成样本逐面健全(不符报 Warning 在位/未知不报/语义闸不报,防双侧同错空转)', async () => {
    await withRustGate(async () => {
      const findingsOf = async (sample: Sample) =>
        computeRpcArgCountFindingsAsync(sample.text, mappingWithMethods(sample.methods));
      // 数量不符:1 条,actualCount/declaredCount/定位逐项
      const mismatch = await findingsOf(SYNTHETIC_SAMPLES[0]);
      expect(mismatch).toHaveLength(1);
      expect(mismatch[0].actualCount).toBe(2);
      expect(mismatch[0].declaredCount).toBe(1);
      expect(mismatch[0].methodName).toBe('login');
      expect(mismatch[0].line).toBe(0);
      // 相符/尾随逗号/跨行相符:不报
      expect(await findingsOf(SYNTHETIC_SAMPLES[1])).toEqual([]);
      expect(await findingsOf(SYNTHETIC_SAMPLES[2])).toEqual([]);
      expect(await findingsOf(SYNTHETIC_SAMPLES[3])).toEqual([]);
      // 星号实参/裸引用/杂 token:计数未知,不报
      expect(await findingsOf(SYNTHETIC_SAMPLES[4])).toEqual([]);
      expect(await findingsOf(SYNTHETIC_SAMPLES[6])).toEqual([]);
      expect(await findingsOf(SYNTHETIC_SAMPLES[8])).toEqual([]);
      // 掩码伪调用(字符串/注释):发现面去伪,不报
      expect(await findingsOf(SYNTHETIC_SAMPLES[5])).toEqual([]);
      // 名后空白合法计数:2 ≠ 1 报 1 条
      expect(await findingsOf(SYNTHETIC_SAMPLES[7])).toHaveLength(1);
      // 声明未就绪/段错配/歧义/声明星号形参:语义闸不报
      expect(await findingsOf(SYNTHETIC_SAMPLES[16])).toEqual([]);
      expect(await findingsOf(SYNTHETIC_SAMPLES[17])).toEqual([]);
      expect(await findingsOf(SYNTHETIC_SAMPLES[18])).toEqual([]);
      expect(await findingsOf(SYNTHETIC_SAMPLES[19])).toEqual([]);
      // 混合接收者:base(1=1 相符)/cell(2≠1 报)/client(0=0 相符)
      const mixed = await findingsOf(SYNTHETIC_SAMPLES[15]);
      expect(mixed).toHaveLength(1);
      expect(mixed[0].receiver).toBe('cell');
      // 零线索/空:全空
      expect(await findingsOf(SYNTHETIC_SAMPLES[20])).toEqual([]);
      expect(await findingsOf(SYNTHETIC_SAMPLES[21])).toEqual([]);
    });
  }, 60000);
});
