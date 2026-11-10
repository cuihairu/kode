/**
 * trap 三规则 Rust↔TS 行为对拍(AUDIT-005 B2 车道首批,沿
 * defAnalyzerRustParity 先例):用真实 kode-server 二进制跑
 * `$/kode/lint/analyzeTraps`,把 Rust 结构面经 renderRustTrapItems 渲染,
 * 与 TS 兜底 buildTrapDiagnosticItems 对同一语料**全量深等**(有序数组
 * toEqual:code/line/character/length/severity/message 逐条一致)。
 *
 * 语料 = 合成样本(逐规则命中/误报面)+ 真实 fixture .py 全量
 * (现实文本覆盖);FIXED_DICT 属性表用合成表(fixtures 未必命中,对拍
 * 语义是双实现同输入同输出,不是命中保证)。enabled 开两组(全开/关一)
 * 覆盖 handler 的开关面。
 *
 * 与 kodeCoreE2E 同口径:二进制缺失(未构建 Rust)则整套 skip,不破坏
 * 纯 TS 门禁;二进制在场则跑真实 RPC。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import {
  buildTrapDiagnosticItems,
  renderRustTrapItems,
  type TrapLintComputeDeps
} from '../src/trapDiagnosticsWiring';
import { FIXED_DICT_MUTATION_DIAGNOSTIC_CODE } from '../src/backend/fixedDictMutationDiagnostics';
import { DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE } from '../src/backend/destroyedEntityCaptureDiagnostics';
import { TIMER_CLEANUP_ON_DESTROY_DIAGNOSTIC_CODE } from '../src/backend/timerCleanupDiagnostics';

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

/** 合成样本:三规则逐面(命中/边界/误报)确定性覆盖 */
const SYNTHETIC_SAMPLES: Array<{ label: string; text: string }> = [
  {
    label: 'fixeddict-attr',
    text: [
      "self.profile.name = 'x'",
      'self.profile = {}',
      "self.other.name = 'y'",
      "self.profile.name += 'x'",
      "'self.profile.name = inside string'",
      '# self.profile.name = comment',
      'self.profile.name == y',
      'self.profile.a.b = 1',
      "self.profile['slot'] = 1",
      'self.profile.name ='
    ].join('\n')
  },
  {
    label: 'fixeddict-subscript',
    text: [
      `self.bag['slot'] = 1`,
      `self.bag["slot"] = 1`,
      `self.bag['a.b'] = 1`,
      `self.bag[slot] = 1`,
      `self.bag[] = 1`,
      `xself.bag['slot'] = 1`,
      `_self.bag['slot'] = 1`,
      `self.bag['slot'] += 1`,
      `self.bag['slot'] == 1`
    ].join('\n')
  },
  {
    label: 'destroyed-capture',
    text: [
      'REGISTRY = []',
      'CACHE = {}',
      'SEEN = set()',
      'NOT_CONTAINER = 1',
      'class Avatar:',
      '    def register(self):',
      '        REGISTRY.append(self)',
      '        CACHE["a"] = self',
      '        SEEN.add(self)',
      '        NOT_CONTAINER.append(self)',
      '        CACHE["b"] = self.id',
      '        REGISTRY.append(self.other)',
      '        if self in REGISTRY:',
      '            pass',
      '        LOCAL = []',
      '        LOCAL.append(self)'
    ].join('\n')
  },
  {
    label: 'timer-cleanup',
    text: [
      'class Avatar:',
      '    def onDestroy(self):',
      '        pass',
      '        self.delTimer(self.tid)',
      '        # self.delTimer(x)',
      '    async def onDestroy(self, a):',
      '        self . delTimer(1)',
      '        self.delTimer (2)',
      '    def tick(self):',
      '        self.delTimer(self.tid)',
      'def onDestroy(self):',
      '    self.delTimer(self.tid)'
    ].join('\n')
  },
  {
    label: 'combined',
    text: [
      'REGISTRY = []',
      '',
      'class Avatar:',
      '    def __init__(self):',
      '        self.timerID = self.addTimer(1, 0, 0)',
      '',
      '    def rename(self):',
      '        self.profile.name = "abc"',
      '',
      '    def register(self):',
      '        REGISTRY.append(self)',
      '',
      '    def onDestroy(self):',
      '        self.delTimer(self.timerID)',
      ''
    ].join('\n')
  }
];

/** FIXED_DICT 属性表(合成证据面;判定只用键存在性) */
const FIXED_DICT_TABLE = new Map<string, readonly string[]>([
  ['profile', ['name', 'slot']],
  ['bag', ['slot', 'a.b']]
]);

const ALL_ON: TrapLintComputeDeps['enabled'] = {
  fixedDictMutation: true,
  destroyedEntityReference: true,
  timerCleanup: true
};
const MIXED: TrapLintComputeDeps['enabled'] = {
  fixedDictMutation: true,
  destroyedEntityReference: false,
  timerCleanup: true
};

const suite = binaryReady ? describe : describe.skip;

suite('trap lints Rust↔TS 行为对拍(真实 kode-server)', () => {
  it('Rust 结构面渲染 ≡ TS 兜底(全量深等,合成+fixture,开关两组)', async () => {
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
      expect(samples.length).toBeGreaterThan(5);
      for (const enabled of [ALL_ON, MIXED]) {
        const deps: TrapLintComputeDeps = { fixedDictProperties: FIXED_DICT_TABLE, enabled };
        for (const sample of samples) {
          const resp = (await client.request('$/kode/rpc', {
            method: '$/kode/lint/analyzeTraps',
            params: {
              text: sample.text,
              fixedDictProperties: Object.fromEntries(deps.fixedDictProperties),
              enabled: deps.enabled
            }
          })) as { items?: unknown[] };
          const rustItems = resp.items ?? [];
          const rendered = renderRustTrapItems(rustItems);
          expect(
            rendered,
            `${sample.label}: Rust 结构面含畸形条目(整面作废语义)`
          ).not.toBeNull();
          const tsItems = buildTrapDiagnosticItems(sample.text, deps);
          expect(
            rendered,
            `${sample.label}: Rust ≠ TS(能力丢失/漂移)`
          ).toEqual(tsItems);
        }
      }
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 60000);

  it('合成样本逐规则断言面健全(命中在位,防双侧同错空转)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined,
    });
    await client.start();
    try {
      const deps: TrapLintComputeDeps = { fixedDictProperties: FIXED_DICT_TABLE, enabled: ALL_ON };
      for (const sample of SYNTHETIC_SAMPLES) {
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzeTraps',
          params: {
            text: sample.text,
            fixedDictProperties: Object.fromEntries(FIXED_DICT_TABLE),
            enabled: deps.enabled
          }
        })) as { items?: Array<{ code: string }> };
        const codes = (resp.items ?? []).map(item => item.code);
        if (sample.label === 'fixeddict-attr' || sample.label === 'fixeddict-subscript') {
          expect(codes, sample.label).toContain(FIXED_DICT_MUTATION_DIAGNOSTIC_CODE);
        } else if (sample.label === 'destroyed-capture') {
          expect(codes, sample.label).toContain(DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE);
        } else if (sample.label === 'timer-cleanup') {
          expect(codes, sample.label).toContain(TIMER_CLEANUP_ON_DESTROY_DIAGNOSTIC_CODE);
        } else {
          expect(codes.length, sample.label).toBeGreaterThan(0);
        }
      }
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 30000);
});
