/**
 * propertyDirection Rust↔TS 扫描束对拍(AUDIT-005 B2 车道批 7,沿
 * attributeNoneRustParity 先例):真实 kode-server 跑
 * `$/kode/lint/analyzePropertyDirection`(三扫描束,**原文**口径,无掩码),
 * 经生产装配 buildPropertyDirectionScanBundleWithRust(门注入真实 client,
 * 校验/转换同一条路径)与 TS 兜底 scanBundleOf **全量深等**(束面五份:
 * accesses 行·列·路径 / init names·sites·cellDataCopyKeys(Set/Map 结构等)/
 * cellDataAccesses 行·列·长·尾·键);再以同一 resolve 替身驱动判定核
 * findPropertyDirectionFindings **全量深等**——影子抑制/复制属性/cellData
 * 键提示/方向违规/作用域不足两流一次全覆盖(判定核与消息渲染同一份 TS
 * 代码,分歧只可能来自扫描束,影子/cellData 两流完整保留)。
 * 语料 = 合成样本(接收者违规/域内放行/裸访问两侧/作用域不足/影子/复制属性
 * 与赋值位去重/.get 形态/cellData 键提示三态/indexOf 同名键/嵌套路径根回退/
 * CRLF/非 ASCII 列/形态失败/零线索/空)+ 真实 fixture .py 全量。
 * 与 kodeCoreE2E 同口径:二进制缺失(未构建 Rust)则整套 skip,不破坏纯 TS
 * 门禁;二进制在场则跑真实 RPC。versionKey 不入本面(判定核不走流解析缓存)。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { buildPropertyDirectionScanBundleWithRust } from '../src/backend/propertyDirectionRust';
import {
  PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_CELL_DATA_KEY_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_SCOPE_UNKNOWN_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_SHADOW_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE,
  findPropertyDirectionFindings,
  scanBundleOf,
  type PropertyDirectionHit
} from '../src/backend/propertyDirectionDiagnostics';

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

// ---- resolve 替身词汇表(与 propertyDirectionDiagnostics.test.ts 同源) ------

const BASE_FILE = '/ws/scripts/base/Hero.py';
const CELL_FILE = '/ws/scripts/cell/Hero.py';
const AMBIGUOUS_FILE = '/ws/scripts/common/Hero.py';

const hit = (
  domains: Array<'base' | 'cell' | 'client'>,
  extra: Partial<PropertyDirectionHit> = {}
): PropertyDirectionHit => ({
  propertyName: 'hp',
  domains,
  defFile: '/ws/scripts/entity_defs/Hero.def',
  defLine: 10,
  ...extra
});

/** resolve 替身:按 propertyPath 命中,未命中回退 rootSymbol(与
 * findIndexedPropertyIn 的「完整路径 或 根段」双查口径一致) */
const resolver =
  (spec: Record<string, PropertyDirectionHit> = {}) =>
  (propertyPath: string, rootSymbol: string): PropertyDirectionHit | null =>
    spec[propertyPath] ?? spec[rootSymbol] ?? null;

interface Sample {
  label: string;
  text: string;
  filePath: string;
  spec: Record<string, PropertyDirectionHit>;
}

/**
 * 合成样本:接收者违规/域内放行/裸访问两侧/作用域不足降级/影子抑制/复制属性
 * (赋值位+裸访问,赋值位被 emitted 去重)/仅赋值位复制提示/cellData 键三态
 * (def 带 cell/def 不带 cell「不在 cellData」/非 def 跳过)/.get 形态两流/
 * 多规则乱序 + 排序/嵌套路径根回退/CRLF 三扫描切分双口径/非 ASCII 列/
 * indexOf 同名键 quirk/形态失败(数字段起头合法、自.()、双点、伪边界、
 * 内建 receiver)/零线索/空。
 */
const SYNTHETIC_SAMPLES: Sample[] = [
  {
    label: 'receiver-violation',
    text: 'x = self.base.hp\n',
    filePath: BASE_FILE,
    spec: { hp: hit(['cell']) }
  },
  {
    label: 'receiver-in-domain',
    text: 'x = self.cell.hp\n',
    filePath: CELL_FILE,
    spec: { hp: hit(['cell']) }
  },
  {
    label: 'bare-out-domain',
    text: 'x = self.hp\n',
    filePath: BASE_FILE,
    spec: { hp: hit(['cell']) }
  },
  {
    label: 'bare-in-domain',
    text: 'x = self.hp\n',
    filePath: CELL_FILE,
    spec: { hp: hit(['cell']) }
  },
  {
    label: 'scope-unknown',
    text: 'x = self.hp\n',
    filePath: AMBIGUOUS_FILE,
    spec: { hp: hit(['cell']) }
  },
  {
    label: 'shadow-suppression',
    text: 'class A:\n    def __init__(self):\n        self.hp = []\n    def m(self):\n        self.hp.tick()\n',
    filePath: BASE_FILE,
    spec: { hp: hit(['cell']) }
  },
  {
    label: 'celldata-copy-bare-and-site',
    text: 'class A:\n    def __init__(self):\n        self.hp = self.cellData["hp"]\n    def m(self):\n        self.hp.tick()\n',
    filePath: BASE_FILE,
    spec: { hp: hit(['cell'], { typeName: 'UINT16' }) }
  },
  {
    label: 'celldata-copy-site-only',
    text: 'class A:\n    def __init__(self):\n        self.mp = self.cellData[\'mp\']\n',
    filePath: BASE_FILE,
    spec: { mp: hit(['base', 'client'], { typeName: 'INT64' }) }
  },
  {
    label: 'celldata-key-three-states',
    text: 'v1 = self.cellData["hp"]\nv2 = self.cellData[\'mp\']\nv3 = self.cellData["position"]\nv4 = self.cellData.get("ghost")\n',
    filePath: BASE_FILE,
    spec: { hp: hit(['cell'], { typeName: 'UINT16' }), mp: hit(['base'], { typeName: 'INT64' }) }
  },
  {
    label: 'get-form-two-streams',
    text: "class A:\n    def __init__(self):\n        self.k = self.cellData.get('hp')\n    def m(self):\n        self.k.tick()\n",
    filePath: BASE_FILE,
    spec: { hp: hit(['cell']), k: hit(['cell'], { typeName: 'UINT16' }) }
  },
  {
    label: 'multi-rule-sorted',
    text: 'x1 = self.base.mp\nx2 = self.hp\nclass A:\n    def __init__(self):\n        self.sp = self.cellData["sp"]\n    def m(self):\n        self.sp.tick()\n        self.base.hp\n',
    filePath: BASE_FILE,
    spec: { hp: hit(['cell']), mp: hit(['client']), sp: hit(['cell'], { typeName: 'VECTOR3' }) }
  },
  {
    label: 'nested-path-root-fallback',
    text: 'x = self.base.hp.max\n',
    filePath: BASE_FILE,
    spec: { hp: hit(['cell']) }
  },
  {
    label: 'crlf-corpus',
    text: 'class A:\r\n    def __init__(self):\r\n        self.hp = self.cellData["hp"]\r\n    def m(self):\r\n        self.hp.tick()\r\n',
    filePath: BASE_FILE,
    spec: { hp: hit(['cell'], { typeName: 'UINT16' }) }
  },
  {
    label: 'non-ascii-column',
    text: 'log("庆祝"); self.hp\n',
    filePath: BASE_FILE,
    spec: { hp: hit(['cell']) }
  },
  {
    label: 'celldata-key-named-celldata',
    text: 'x = self.cellData["cellData"]\n',
    filePath: BASE_FILE,
    spec: { cellData: hit(['cell']) }
  },
  {
    label: 'shape-fails',
    text: 'self.5x\nself.x.()\nself..a\nmyself.a.b\n_self.a.b\nself.cell.tick()\n',
    filePath: BASE_FILE,
    spec: { hp: hit(['cell']) }
  },
  {
    label: 'zero-clue',
    text: 'print(1)\nd = obj.attr\n',
    filePath: BASE_FILE,
    spec: {}
  },
  { label: 'empty', text: '', filePath: BASE_FILE, spec: {} },
  {
    label: 'js-space-classes',
    text: 'class A:\n\u00a0def __init__(self):\n\u3000\u3000self.hp = 1\n    def m(self):\n        self.hp.tick()\n',
    filePath: BASE_FILE,
    spec: { hp: hit(['cell']) }
  }
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

suite('propertyDirection Rust↔TS 扫描束对拍(真实 kode-server)', () => {
  it('Rust 扫描束 ≡ TS 本地束,判定核产出 ≡ TS(全量深等,合成+fixture)', async () => {
    await withRustGate(async calls => {
      const fixtureTexts = collectPythonFiles(FIXTURE_ROOT).map(file => ({
        label: `fixture:${file.slice(FIXTURE_ROOT.length + 1)}`,
        text: readFileSync(file, 'utf8'),
        filePath: file,
        spec: {} as Record<string, PropertyDirectionHit>
      }));
      const samples = [...SYNTHETIC_SAMPLES, ...fixtureTexts];
      expect(samples.length).toBeGreaterThan(17);
      for (const sample of samples) {
        const callsBefore = calls.length;
        const rustBundle = await buildPropertyDirectionScanBundleWithRust(sample.text);
        // 生产序:零线索短路不发 RPC,直接合法空束;有线索恰好一次 RPC,
        // params.text = 原文(本批口径,无掩码)
        if (!sample.text.includes('self.')) {
          expect(calls.length, `${sample.label}: 零线索不应发 RPC`).toBe(callsBefore);
          expect(rustBundle, `${sample.label}: 零线索应回合法空束`).not.toBeNull();
        } else {
          expect(calls.length, `${sample.label}: 应恰好一次 RPC`).toBe(callsBefore + 1);
          expect(calls[calls.length - 1].params, `${sample.label}: params.text=原文`).toEqual({
            text: sample.text
          });
        }
        // 束面对拍(严格面:五份逐位,Set/Map 结构等)
        expect(rustBundle, `${sample.label}: Rust 束面 ≠ TS 本地束`).toEqual(
          scanBundleOf(sample.text)
        );
        // 判定核对拍(同一 resolve 替身驱动两侧,两流全量深等)
        const tsFindings = findPropertyDirectionFindings(
          sample.text,
          sample.filePath,
          resolver(sample.spec)
        );
        const rustFindings = findPropertyDirectionFindings(
          sample.text,
          sample.filePath,
          resolver(sample.spec),
          rustBundle!
        );
        expect(rustFindings, `${sample.label}: 判定核产出 ≠ TS(两流漂移)`).toEqual(tsFindings);
      }
    });
  }, 120000);

  it('合成样本逐面健全(命中在位/码归类/两流去重,防双侧同错空转)', async () => {
    await withRustGate(async () => {
      const rustFindingsOf = (sample: Sample) =>
        buildPropertyDirectionScanBundleWithRust(sample.text).then(bundle =>
          findPropertyDirectionFindings(sample.text, sample.filePath, resolver(sample.spec), bundle!)
        );
      // 接收者违规:1 条 Warning,码/接收者/路径逐项
      const violation = await rustFindingsOf(SYNTHETIC_SAMPLES[0]);
      expect(violation).toHaveLength(1);
      expect(violation[0].severity).toBe('Warning');
      expect(violation[0].code).toBe(PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE);
      expect(violation[0].receiver).toBe('base');
      expect(violation[0].propertyPath).toBe('hp');
      // 作用域不足降级 Information
      const unknown = await rustFindingsOf(SYNTHETIC_SAMPLES[4]);
      expect(unknown).toHaveLength(1);
      expect(unknown[0].code).toBe(PROPERTY_DIRECTION_SCOPE_UNKNOWN_DIAGNOSTIC_CODE);
      expect(unknown[0].severity).toBe('Information');
      // 影子抑制:同文件 __init__ 赋值 → 不再 Warning,改 Information 影子码
      // (赋值行 LHS 访问与裸访问各一条,propertyPath 分别为 hp / hp.tick)
      const shadow = await rustFindingsOf(SYNTHETIC_SAMPLES[5]);
      expect(shadow).toHaveLength(2);
      expect(shadow.every(f => f.code === PROPERTY_DIRECTION_SHADOW_DIAGNOSTIC_CODE)).toBe(true);
      expect(shadow.every(f => f.severity === 'Information')).toBe(true);
      // CRLF 语料:TS init 扫描 `(.*)$` 尾锚(JS `.` 不匹配行终结符)→ 携 \r
      // 行整匹配失败,影子不生效,裸访问仍出 Warning 违规 + RHS 键提示
      const crlf = await rustFindingsOf(SYNTHETIC_SAMPLES[12]);
      expect(
        crlf.some(
          f => f.code === PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE && f.severity === 'Warning'
        )
      ).toBe(true);
      expect(crlf.some(f => f.code === PROPERTY_DIRECTION_CELL_DATA_KEY_DIAGNOSTIC_CODE)).toBe(true);
      // 复制属性两流:赋值行(裸访问命中,emitted 去重赋值位)+ 裸访问位 +
      // RHS cellData 键提示 = 2 copy + 1 key
      const copy = await rustFindingsOf(SYNTHETIC_SAMPLES[6]);
      expect(copy.filter(f => f.code === PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE)).toHaveLength(2);
      expect(copy.filter(f => f.code === PROPERTY_DIRECTION_CELL_DATA_KEY_DIAGNOSTIC_CODE)).toHaveLength(1);
      expect(copy.every(f => f.severity === 'Information')).toBe(true);
      expect(copy.some(f => f.typeName === 'UINT16')).toBe(true);
      // cellData 键 named 'cellData':indexOf 首现语义(键列 9/长 8)+
      // 裸访问 'cellData' 在 base 文件出违规(同名键不吞方向违规)
      const quirk = await rustFindingsOf(SYNTHETIC_SAMPLES[14]);
      expect(quirk).toHaveLength(2);
      const keyFinding = quirk.find(f => f.code === PROPERTY_DIRECTION_CELL_DATA_KEY_DIAGNOSTIC_CODE);
      expect(keyFinding?.character).toBe(9);
      expect(keyFinding?.length).toBe(8);
      expect(quirk.some(f => f.code === PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE)).toBe(true);
      // 零线索:两侧全空
      expect(await rustFindingsOf(SYNTHETIC_SAMPLES[16])).toEqual([]);
    });
  }, 60000);
});
