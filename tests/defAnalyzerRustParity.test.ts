/**
 * def.analyze Rust↔TS 行为对拍(AUDIT-002 结论 #4「双路径对拍测试」)。
 *
 * 用真实 kode-server 二进制跑 `$/kode/lint/analyzeDef`,与 TS `analyzeDefDocument`
 * 兜底对同一 def 输入比对。断言两条:
 *
 * 1. **无能力丢失(硬断言)**:每条 TS finding 都存在 Rust finding 同
 *    `check`/`severity`/`offset`/`length`/`name`(位置身份,不含 line)——Rust 侧
 *    忠实复现 TS 全部分析建议,切换/回退无静默丢能力(AUDIT-002「禁止静默丢能力」)。
 * 2. **超额有界(硬断言)**:Rust-only findings 只出自 Rust 额外的两条规则
 *    (`missing-flags`/`unknown-type-reference`)——Rust 比 TS 更严,属受控超集,
 *    新规则加入会红此测试促人工复核,防静默漂移。
 *
 * 已知设计差异(不视为丢失,偏移/长度已一致,仅 line 锚点不同):
 * - `heavy-sync-broadcast`:TS 锚属性节点行,Rust 锚 <Flags> 节点行(更精确指向
 *   被标旗标)。offset/length 一致,仅 line 不同,故位置身份断言不含 line。
 *
 * 与 kodeCoreE2E 同口径:二进制缺失(未构建 Rust)则整套 skip,不破坏
 * 纯 TS 门禁;二进制在场则跑真实 RPC(对拍语义=双实现同输入同输出)。
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KodeCoreClient } from '../src/kodeCoreClient';
import { analyzeDefDocument } from '../src/defAnalyzer';

const repoRoot = join(__dirname, '..');
const binaryPath = join(repoRoot, 'target', 'debug', 'kode-server');
const binaryReady = existsSync(binaryPath);

const def = (body: string): string => ['<root>', body, '</root>'].join('\n');
const property = (name: string, inner: string): string =>
  `\t<Properties>\n\t\t<${name}>\n${inner}\n\t\t</${name}>\n\t</Properties>`;

const FIXTURE_DEF_DIR = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts', 'entity_defs');

/** def 样本:合成(确定性覆盖各规则)+ 真实 fixture def(现实覆盖)。 */
function loadSamples(): Array<{ label: string; text: string }> {
  const synthetic: Array<{ label: string; text: string }> = [
    { label: 'phantom-type', text: def(property('hp', '      <Type>BOOL</Type>')) },
    { label: 'missing-type', text: def(property('hp', '      <Flags>ALL_CLIENTS</Flags>')) },
    { label: 'duplicate-type-tag', text: def(property('hp', '      <Type>UINT8</Type>\n      <Type>INT8</Type>')) },
    { label: 'heavy-sync-broadcast', text: def(property('memo', '      <Type>UNICODE</Type>\n      <Flags>ALL_CLIENTS</Flags>')) },
    {
      label: 'mixed',
      text: [
        '<root>',
        '\t<Parent><Base/></Parent>',
        '\t<Properties>',
        '\t\t<ghost><Type>BOOL</Type></ghost>',
        '\t\t<memo><Type>UNICODE</Type><Flags>ALL_CLIENTS</Flags></memo>',
        '\t</Properties>',
        '\t<BaseMethods><reqQuest><Exposed/></reqQuest></BaseMethods>',
        '</root>'
      ].join('\n')
    }
  ];
  const fixtures = existsSync(FIXTURE_DEF_DIR)
    ? readdirSync(FIXTURE_DEF_DIR)
        .filter(f => f.endsWith('.def'))
        .map(f => ({
          label: `fixture:${f}`,
          text: readFileSync(join(FIXTURE_DEF_DIR, f), 'utf8')
        }))
    : [];
  return [...synthetic, ...fixtures];
}

interface Finding {
  check: string;
  severity: string;
  line: number;
  offset: number;
  length: number;
  name?: string;
}

/** 位置身份键:不含 line(Rust/TS 对 heavy-sync-broadcast 锚点不同系设计差异)。 */
const posKey = (f: Finding): string => `${f.check}|${f.severity}|${f.offset}|${f.length}|${f.name ?? ''}`;

/** Rust 额外规则(受控超集):超出此集的新 Rust-only 需人工复核。 */
const SUPERSET_RULES = new Set(['missing-flags', 'unknown-type-reference']);

const suite = binaryReady ? describe : describe.skip;

suite('def.analyze Rust↔TS 行为对拍(真实 kode-server)', () => {
  it('Rust findings ⊇ TS findings(无能力丢失,位置身份)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined,
    });
    await client.start();
    try {
      for (const sample of loadSamples()) {
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzeDef',
          params: { text: sample.text }
        })) as { findings: Finding[] };
        const rustFindings = resp.findings ?? [];
        const tsFindings = analyzeDefDocument(sample.text);
        const rustKeys = new Set(rustFindings.map(posKey));
        for (const tsFinding of tsFindings) {
          expect(
            rustKeys.has(posKey(tsFinding)),
            `${sample.label}: TS ${tsFinding.check}@${tsFinding.line} 无 Rust 同位等价(能力丢失)`
          ).toBe(true);
        }
      }
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 30000);

  it('Rust-only findings 只出自受控超集规则(missing-flags/unknown-type-reference)', async () => {
    const client = new KodeCoreClient({
      binaryPath,
      initializeParams: { processId: process.pid, rootUri: 'file:///workspace/demo', capabilities: {} },
      onStderr: () => undefined,
    });
    await client.start();
    try {
      for (const sample of loadSamples()) {
        const resp = (await client.request('$/kode/rpc', {
          method: '$/kode/lint/analyzeDef',
          params: { text: sample.text }
        })) as { findings: Finding[] };
        const rustFindings = resp.findings ?? [];
        const tsFindings = analyzeDefDocument(sample.text);
        const tsKeys = new Set(tsFindings.map(posKey));
        const rustOnly = rustFindings.filter(f => !tsKeys.has(posKey(f)));
        for (const extra of rustOnly) {
          expect(
            SUPERSET_RULES.has(extra.check),
            `${sample.label}: Rust 新增未复核规则 ${extra.check}(超集规则集外),需人工评估是否能力差异`
          ).toBe(true);
        }
      }
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }, 30000);
});
