/**
 * 返回注解提取 Rust↔TS 对拍(RUST-MIGRATION-AUDIT-006 B1 车道批 3,沿
 * selfAttributeFlowRustParity 先例):真实 kode-server 跑
 * `$/kode/python/returnAnnotations`,三事实与 TS 提取核**全量深等**——
 * - facts(首定义优先含无注解 null 事实)≡ collectFileAnnotationFacts 记录序;
 * - imports(from/bare 绑定)≡ extractFileImports Map(键→值深等,含别名绑
 *   完整点分路径/通配跳过/相对点剥除);
 * - localAssignmentCalls(全文掩码后逐行单跳调用)≡ maskPythonNonCode →
 *   split('\n') → parseLocalAssignmentCall 逐行(行内孤立 \r 同判失配)。
 * 语料 = 合成样本(注解全族/导入全族/调用全族/CRLF/孤立 \r)+ 真实 fixture
 * .py 全量。二进制缺失(未构建 Rust)整套 skip;二进制在场则首例先做直连
 * ok 断言(旧二进制缺方法显式红而非静默假绿)。生产装配切换另例:门注入
 * 真实 client 后 extractFileReturnAnnotationsAsync ≡ TS extractFileReturnAnnotations。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { maskPythonNonCode } from '../src/backend/pythonLexicalMask';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import {
  collectFileAnnotationFacts,
  extractFileImports,
  extractFileReturnAnnotations,
  extractFileReturnAnnotationsAsync,
  parseLocalAssignmentCall
} from '../src/backend/pythonReturnTypeInference';

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const binaryReady = existsSync(binaryPath);

const FIXTURE_ROOT = join(repoRoot, 'tests', 'fixtures');

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

const SYNTHETIC_SAMPLES: Array<{ label: string; text: string }> = [
  {
    label: 'annotations-family',
    text: [
      'def annotated() -> JSONDATA:',
      '    return load()',
      'def unannotated():',
      '    return 1',
      'def first_wins() -> int:',
      '    return 1',
      'def first_wins() -> str:',
      '    return "x"',
      'def multiline(a: int,',
      '        b: str) -> list:',
      '    return []'
    ].join('\n')
  },
  {
    label: 'truncated-and-shadowed',
    text: [
      'def a(',
      '    p1,',
      '    p2,',
      'def b() -> int:',
      '    pass',
      'def in_string_masked():',
      '    s = "def fake() -> Ghost:"',
      '    return s'
    ].join('\n')
  },
  {
    label: 'imports-family',
    text: [
      'import base',
      'import pkg.good as g',
      'import a.b.c',
      'from .rel.path import thing as t, other',
      'from mods import *',
      'from mods import x # note',
      'import time # as note',
      'broken = 1'
    ].join('\n')
  },
  {
    label: 'calls-family',
    text: [
      'data = activity_data.get_data()',
      'x = f().g()',
      'y == 5',
      'z = make()',
      'w = obj . m ()',
      'q = f("s")',
      'r = f() # note',
      'dotted = svc.item.load(1)'
    ].join('\n')
  },
  {
    label: 'crlf-and-lone-cr',
    text: 'def a() -> int:\r\n    pass\r\nx = f()\r\nbroken = g(\rh)\r\n'
  },
  {
    label: 'triple-quote-body',
    text: 's = """\ninner = fake()\n"""\nok = real()\n'
  },
  { label: 'empty', text: '' },
  { label: 'no-defs', text: 'x = 1\nprint(x)\n' }
];

const suite = binaryReady ? describe : describe.skip;

interface RustFact {
  name: string;
  annotation: string | null;
}

/** TS 事实 → 与 Rust 出参同形数组(记录序) */
function tsFactsOf(text: string): RustFact[] {
  const facts: RustFact[] = [];
  collectFileAnnotationFacts(text, (name, annotation) => {
    facts.push({ name, annotation });
  });
  return facts;
}

function documentLinesOf(text: string): string[] {
  return text.split(/\r?\n/);
}

suite('returnAnnotations Rust↔TS 提取核对拍(真实 kode-server)', () => {
  it('直连断言:Rust 方法在场且三事实形状合法(旧二进制缺方法 → 显式红)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined
    });
    await client.start();
    try {
      const resp = (await client.request('$/kode/rpc', {
        method: '$/kode/python/returnAnnotations',
        params: { text: 'def a() -> int:\n    pass\n' }
      })) as { facts?: unknown; imports?: unknown; localAssignmentCalls?: unknown };
      expect(Array.isArray(resp.facts), '旧二进制缺方法/畸形 → 显式红').toBe(true);
      const facts = resp.facts as RustFact[];
      expect(facts).toEqual([{ name: 'a', annotation: 'int' }]);
      expect(resp.imports).toBeDefined();
      expect(resp.localAssignmentCalls).toEqual([]);
    } finally {
      await client.dispose().catch(() => undefined);
    }
  });

  it('三事实全量深等:合成样本 + fixture .py 全量', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined
    });
    await client.start();
    try {
      const fixtureTexts = collectPythonFiles(FIXTURE_ROOT).map(file => ({
        label: `fixture:${file.slice(FIXTURE_ROOT.length + 1)}`,
        text: readFileSync(file, 'utf8')
      }));
      const samples = [...SYNTHETIC_SAMPLES, ...fixtureTexts];
      expect(samples.length).toBeGreaterThan(8);
      for (const sample of samples) {
        // facts:记录序数组深等(含无注解 null 事实)
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/python/returnAnnotations',
          params: { text: sample.text }
        })) as {
          facts: RustFact[];
          imports: {
            names: Array<{ local: string; module: string; symbol: string }>;
            receivers: Array<{ local: string; module: string }>;
          };
          localAssignmentCalls: Array<{
            line: number;
            target: string;
            receiver: string | null;
            methodName: string;
          }>;
        };
        expect(
          resp.facts,
          `${sample.label}: facts ≠ TS(记录序/注解/null 遮蔽漂移)`
        ).toEqual(tsFactsOf(sample.text));
        // imports:键→值 Map 深等(local 绑定;symbol 保留原始符号)
        const tsImports = extractFileImports(documentLinesOf(sample.text));
        const rustNames = new Map(
          resp.imports.names.map(binding => [
            binding.local,
            { module: binding.module, symbol: binding.symbol }
          ])
        );
        expect(rustNames, `${sample.label}: from 绑定 ≠ TS`).toEqual(tsImports.names);
        const rustReceivers = new Map(
          resp.imports.receivers.map(binding => [binding.local, binding.module])
        );
        expect(rustReceivers, `${sample.label}: import 接收者绑定 ≠ TS`).toEqual(
          tsImports.receivers
        );
        // localAssignmentCalls:全文掩码 → '\n' 切分 → 逐行单跳(行序数组)
        const maskedLines = maskPythonNonCode(sample.text).split('\n');
        const tsCalls = [];
        for (let line = 0; line < maskedLines.length; line += 1) {
          const call = parseLocalAssignmentCall(maskedLines[line]);
          if (call) {
            tsCalls.push({
              line,
              target: call.target,
              receiver: call.receiver,
              methodName: call.methodName
            });
          }
        }
        expect(
          resp.localAssignmentCalls,
          `${sample.label}: 逐行单跳调用 ≠ TS(掩码/形态/终止符漂移)`
        ).toEqual(tsCalls);
      }
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 120000);

  it('生产装配切换:门注入真实 client,async 桶构建 ≡ TS 提取(全量)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined
    });
    await client.start();
    setKodeCoreShadowGate({
      runInRust: async (method: string, params: unknown) => {
        const result = await client.request('$/kode/rpc', { method, params });
        return { ok: true as const, result };
      }
    } as unknown as KodeCoreGate);
    try {
      const samples = [
        ...SYNTHETIC_SAMPLES,
        ...collectPythonFiles(FIXTURE_ROOT).map(file => ({
          label: `fixture:${file.slice(FIXTURE_ROOT.length + 1)}`,
          text: readFileSync(file, 'utf8')
        }))
      ];
      for (const sample of samples) {
        const rustIndex = await extractFileReturnAnnotationsAsync(sample.text);
        const tsIndex = extractFileReturnAnnotations(sample.text);
        expect(
          [...rustIndex.entries()],
          `${sample.label}: 生产桶构建 ≠ TS(插入序/遮蔽漂移)`
        ).toEqual([...tsIndex.entries()]);
      }
    } finally {
      setKodeCoreShadowGate(null);
      await client.dispose().catch(() => undefined);
    }
  }, 120000);
});
