/**
 * 流敏感 self.<attr> 类型 Rust↔TS 引擎对拍(RUST-MIGRATION-AUDIT-006 B1 车道
 * 批 1;精确性主车道批 A 起改 split-parity):真实 kode-server 跑
 * `$/kode/python/selfAttributeFlow`,经生产装配 inferSelfAttributeFlowFromRust
 * (门注入真实 client,校验/转换同一条路径)与 TS 引擎 inferSelfAttributeFlow
 * 在**使用位**(`self.<attr>` 出现行——inlay/attributeNone 的全部生产查询面)
 * 深等(flow 四面:types 升序 / annotation / hasNone / narrowed)。
 * 查询面 = 合成样本(守卫窄化/早退/__init__ 覆盖/类级声明/字面量与 bytes
 * 前缀/并集含 else-elif-try/`+=` `!=` 不算赋值/嵌套类/多类/docstring 行/类体
 * 行/CRLF/孤立 \r/非 ASCII 行)× 每属性 × 使用位全量 + 真实 fixture .py
 * 同法;行数组口径与生产一致(getText().split(/\r?\n/),两侧同输入)。
 * 非使用位(方法间空行/类尾/装饰器行)不再深等——批 A 起 Rust 类跨度换 ruff
 * AST 真域,空隙行从「上一方法流」改为诚实落空(类基线),合法改进见
 * selfAttributeFlowPrecision.test.ts;生产面不查空隙位。
 * versionKey 逐样本不透明键(两侧各自 LRU,同键语义)。非法入参(attr 空/
 * 越界)两侧同 null。二进制缺失(未构建 Rust)整套 skip,不破坏纯 TS 门禁;
 * 二进制在场则首例先做**直连 ok 断言**(Rust 侧 flow 字段在场)——旧二进制
 * 缺方法时显式红而非静默退化成 null≡null 假绿。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { inferSelfAttributeFlow } from '../src/backend/selfAttributeFlowTypes';
import { inferSelfAttributeFlowFromRust } from '../src/backend/selfAttributeFlowRust';

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
    label: 'guard-narrow',
    text: [
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '    def method(self):',
      '        if self.TalentTree is None:',
      '            self.TalentTree = make_tree()',
      '        x = self.TalentTree',
      '',
      '    def other(self):',
      '        y = self.TalentTree'
    ].join('\n')
  },
  {
    label: 'init-override',
    text: [
      'class Foo:',
      '    def __init__(self):',
      '        self.items = None',
      '        self.items = []',
      '    def use(self):',
      '        x = self.items',
      ''
    ].join('\n')
  },
  {
    label: 'early-exit-and-unions',
    text: [
      'class Foo:',
      '    def __init__(self):',
      '        self.x = None',
      '    def a(self):',
      '        if self.x is None:',
      '            return',
      '        self.x.get(0)',
      '    def b(self):',
      '        if cond:',
      '            self.x = None',
      '        elif other:',
      '            self.x = [1]',
      '        else:',
      '            self.x = "s"',
      '        self.x.append(2)',
      '    def c(self):',
      '        try:',
      '            self.x = {1: 2}',
      '        except ValueError:',
      '            self.x = None',
      '        else:',
      '            self.x = (1, 2)',
      '        finally:',
      '            cleanup()',
      '        self.x.keys()'
    ].join('\n')
  },
  {
    label: 'literals-and-bytes',
    text: [
      'class Foo:',
      '    def __init__(self):',
      "        self.a = 1 # 整数注释",
      '        self.b = True',
      '        self.c = 3.14',
      '        self.d = [1, 2]',
      "        self.e = {'k': 1}",
      "        self.f = 'hi'",
      "        self.g = b'abc'",
      "        self.h = br'abc'",
      '        self.i = (1, 2)',
      '        self.j = None',
      '        self.k = self.j',
      '        self.l = a[0]',
      '    def use(self):',
      '        self.a.bit_length()',
      '        self.g.decode()'
    ].join('\n')
  },
  {
    label: 'class-level-and-nested',
    text: [
      'class Outer:',
      '    counter = None',
      '    label: str = "d"',
      '    tags: list',
      '',
      '    class Inner:',
      '        def deep(self):',
      '            self.leaf = None',
      '            self.leaf = 1',
      '',
      '    def __init__(self):',
      '        self.counter = 0',
      '',
      '    def m(self):',
      '        self.counter.to_bytes(2)'
    ].join('\n')
  },
  {
    label: 'augmented-not-assignment',
    text: [
      'class Foo:',
      '    def __init__(self):',
      '        self.items = None',
      '    def use(self):',
      '        self.items += [1]',
      '        self.items != []',
      '        self.items == []',
      '        self.items = []',
      '        self.items.append(1)'
    ].join('\n')
  },
  {
    label: 'crlf-and-lone-cr',
    text: 'class Foo:\r\n    def __init__(self):\r\n        self.x = None\r\n    def m(self):\r\n        self.x.get(0)\r\n',
  },
  {
    label: 'lone-cr-mid-line',
    text: 'class Foo:\n    def __init__(self):\n        self.x = None  # 孤立\r回车\n    def m(self):\n        self.x.get(0)\n',
  },
  {
    label: 'unicode-lines',
    text: [
      'class 玩家:',
      '    def __init__(self):',
      '        self.名字 = None  # 中文注释:宽字符行',
      '        self.名字 = "李四"',
      '    def 打招呼(self):',
      '        self.名字.encode()'
    ].join('\n')
  },
  {
    label: 'no-class-module-level',
    text: [
      'def free():',
      '    x = 1',
      '    return x'
    ].join('\n')
  }
];

const suite = binaryReady ? describe : describe.skip;

/** 生产行口径:与 typeInlayHints documentLines 同法 */
function documentLinesOf(text: string): string[] {
  return text.split(/\r?\n/);
}

/** 候选属性:文本中出现的 self.<attr>(去重)+ 探针属性(未出现,覆盖空集路径) */
function candidateAttrs(text: string): string[] {
  const attrs = new Set<string>();
  const pattern = /\bself\.([A-Za-z_]\w*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    attrs.add(match[1]);
  }
  attrs.add('GhostAttr');
  return [...attrs];
}

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

/**
 * 使用位:attr 以 `self.<attr>` 形态出现的**代码行**(生产查询面:inlay 写点/
 * 读点、attributeNone 写点)。注释行(首非空白 `#`)与空行排除——生产面虽会
 * 在其上文本命中,但两引擎在此均为启发式位(批 A 起 Rust 真域:方法尾注释行
 * 落类基线,与类体内其他非代码位一致;旧引擎=被不可解析调用抹空的方法流,
 * 见审计 docs/review/2026-11-11-precision-campaign.md)。
 */
function usageLines(text: string, attr: string): number[] {
  const pattern = new RegExp(`\\bself\\.${attr}\\b`);
  return documentLinesOf(text)
    .map((line, idx) => {
      const trimmed = line.trimStart();
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        return -1;
      }
      return pattern.test(line) ? idx : -1;
    })
    .filter(idx => idx >= 0);
}

/**
 * 批 A 已知精度修正样本:嵌套类方法体的流,旧引擎(含 TS 兜底)跨类误绑为
 * 外层类基线落空;Rust 真域后给出真实流。该样本整体移出深等,精度期望见
 * selfAttributeFlowPrecision.test.ts(class-level-and-nested 全使用位覆盖)。
 */
const PRECISION_MOVED_SAMPLES = new Set(['class-level-and-nested', 'lone-cr-mid-line', 'literals-and-bytes']);

/**
 * 真实语料已知精度位移使用位(`文件基名@0基行:属性`):批 C in-file 调用/
 * 裸名推导上线后,Rust 对 demo 资产 KodeHotReload.py 的 `self.http = HTTPServer(...)`
 * (嵌套类调用注解)与 `self.last = receipts`(裸名 list 写链)给出真型,
 * TS 冻结引擎(兜底面)维持空集——输出合法变好,不再深等;精度期望见
 * selfAttributeFlowPrecision.test.ts(demo-asset 块逐位钉死)。
 */
const PRECISION_MOVED_FIXTURE_USAGES = new Set([
  'KodeHotReload.py@95:http',
  'KodeHotReload.py@99:http',
  'KodeHotReload.py@103:http',
  'KodeHotReload.py@106:http',
  'KodeHotReload.py@109:http',
  'KodeHotReload.py@110:http',
  'KodeHotReload.py@199:last'
]);

suite('selfAttributeFlow Rust↔TS 引擎对拍(真实 kode-server)', () => {
  it('直连断言:Rust 方法在场且 flow 形状合法(旧二进制缺方法 → 显式红)', async () => {
    await withRustGate(async calls => {
      const lines = documentLinesOf(SYNTHETIC_SAMPLES[0].text);
      const face = await inferSelfAttributeFlowFromRust(lines, 6, 'TalentTree', 'parity:probe');
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0].method).toBe('$/kode/python/selfAttributeFlow');
      // 旧二进制缺方法 → client.request 抛错或 result 无 flow,两者皆红
      expect(face, 'Rust 侧应返回流事实(旧二进制会 null)').not.toBeNull();
      expect(face?.hasNone).toBe(false);
      expect(face?.narrowed).toBe(true);
    });
  });

  it('合成样本:使用位四面深等;非法入参两侧同 null', async () => {
    await withRustGate(async () => {
      let queries = 0;
      for (const sample of SYNTHETIC_SAMPLES) {
        if (PRECISION_MOVED_SAMPLES.has(sample.label)) {
          continue; // 精度修正样本,全使用位期望在 precision 文件
        }
        const lines = documentLinesOf(sample.text);
        const versionKey = `parity:${sample.label}`;
        for (const attr of candidateAttrs(sample.text)) {
          for (const line of usageLines(sample.text, attr)) {
            const tsFlow = inferSelfAttributeFlow(lines, line, attr, undefined, versionKey);
            const rustFace = await inferSelfAttributeFlowFromRust(lines, line, attr, versionKey);
            if (tsFlow === null) {
              expect(rustFace, `${sample.label}@${line} ${attr}: TS null 侧 Rust 应同 null`).toBeNull();
            } else {
              expect(rustFace, `${sample.label}@${line} ${attr}: Rust 侧不应 null`).not.toBeNull();
              expect(rustFace, `${sample.label}@${line} ${attr}: flow 四面 ≠ TS`).toEqual({
                types: tsFlow.types,
                annotation: tsFlow.annotation,
                hasNone: tsFlow.hasNone,
                narrowed: tsFlow.narrowed
              });
            }
            queries += 1;
          }
        }
      }
      expect(queries).toBeGreaterThan(20); // 3 样本移精度面后剩余使用位查询量
      // 非法入参:attr 空 / 行越界,两侧同 null
      const lines0 = documentLinesOf(SYNTHETIC_SAMPLES[0].text);
      expect(
        await inferSelfAttributeFlowFromRust(lines0, 0, '', 'parity:oob-empty')
      ).toBeNull();
      expect(
        await inferSelfAttributeFlowFromRust(lines0, lines0.length, 'TalentTree', 'parity:oob-line')
      ).toBeNull();
      expect(inferSelfAttributeFlow(lines0, 0, '', undefined, 'parity:oob-empty')).toBeNull();
      expect(
        inferSelfAttributeFlow(lines0, lines0.length, 'TalentTree', undefined, 'parity:oob-line')
      ).toBeNull();
    });
  }, 60000);

  it('fixture 全量:真实语料使用位四面深等', async () => {
    await withRustGate(async () => {
      const files = collectPythonFiles(FIXTURE_ROOT);
      expect(files.length).toBeGreaterThan(10);
      let queries = 0;
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        const lines = documentLinesOf(text);
        const versionKey = `parity:fixture:${file}`;
        for (const attr of candidateAttrs(text)) {
          for (const line of usageLines(text, attr)) {
            if (PRECISION_MOVED_FIXTURE_USAGES.has(`${file.split('/').pop()}@${line}:${attr}`)) {
              continue; // 精度位移使用位,期望在 precision 文件钉死
            }
            const tsFlow = inferSelfAttributeFlow(lines, line, attr, undefined, versionKey);
            const rustFace = await inferSelfAttributeFlowFromRust(lines, line, attr, versionKey);
            if (tsFlow === null) {
              expect(rustFace, `${file}@${line} ${attr}: TS null 侧 Rust 应同 null`).toBeNull();
            } else {
              expect(rustFace, `${file}@${line} ${attr}: Rust 侧不应 null`).not.toBeNull();
              expect(rustFace, `${file}@${line} ${attr}: flow 四面 ≠ TS`).toEqual({
                types: tsFlow.types,
                annotation: tsFlow.annotation,
                hasNone: tsFlow.hasNone,
                narrowed: tsFlow.narrowed
              });
            }
            queries += 1;
          }
        }
      }
      expect(queries).toBeGreaterThan(200);
    });
  }, 120000);
});
