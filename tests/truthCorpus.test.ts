// KSEM-QA-01 人工真值语料闸:TS/Rust parity(golden.json)只证两侧一致,
// 本闸证「与引擎真值一致」。三道门:
// ①schema——每族 grounding 在场/HEAD 格式/条目结构完备/kind 与 load 一致/unknown 必写缺口;
// ②evidence containment——每条 evidence 逐字出现在该族依据档里(伪造锚点即红);
// ③execution——按族分发实测输出钉死(探针取真值后写进语料, drift 即红)。
// 族注册表:
// - def-property-flags → 分析面(defAnalyzer/flagDomains)+ 验证面(validateDocument);
// - cell-data-snapshot → 键面(cellDataWrongKey)+ 时序面(cellDataCallbackCheck)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { propertyFlagDomainList } from '../src/backend/defAnalyzer';
import { normalizeFlagTokens } from '../src/generated/flagDomains';
import { validateDocument } from '../src/languageProviders';
import { cellDataWrongKeyFindings } from '../src/backend/cellDataWrongKey';
import { trackCellDataKeys, cellDataKeyWorldOpen } from '../src/backend/cellDataKeyTracking';
import { cellDataCallbackFindings } from '../src/backend/cellDataCallbackCheck';
import { cellScriptRoleAndEntity, type CellDataKeyEntry } from '../src/backend/cellDataCompletion';
import { Diagnostic, DiagnosticCollection, makeTextDocument } from './helpers/vscodeStub';

/** 族间公共信封(input/kode 细节由各族执行闸窄化)。 */
interface TruthEntryBase {
  id: string;
  kind: 'positive' | 'negative' | 'unknown';
  engine: { load: 'accept' | 'reject' | 'reject-silent'; truth: string };
  evidence: string[];
  kode: { status: 'pinned' | 'not-analyzed' | 'unverified' };
  finding?: string;
  reason?: string;
}

interface TruthFamily {
  family: string;
  grounding: { doc: string; engineHead: string };
  entries: Record<string, unknown>[];
}

// ---- 族装载:目录内每个 JSON = 一族 ----
const CORPUS_DIR = path.join(__dirname, 'fixtures', 'truth-corpus');
const families = fs
  .readdirSync(CORPUS_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8')) as TruthFamily);
const groundingTextOf = (family: TruthFamily): string =>
  fs.readFileSync(path.join(__dirname, '..', family.grounding.doc), 'utf8');

const PROJECT = path.join(__dirname, 'fixtures', 'parity-project');

// ---- def-property-flags 族形状与鞍具 ----
interface FlagsEntry extends TruthEntryBase {
  input: { spelling: string; path: 'xml' | 'decorator' };
  kode: TruthEntryBase['kode'] & {
    analysis?: { domains: string[]; tokens: string[] };
    validation?: { diagnostic: 'none' | 'pipe' | 'unknown' };
  };
}
const flagsFamily = families.find(f => f.family === 'def-property-flags')!;
const flagsEntries = flagsFamily.entries as unknown as FlagsEntry[];
const flagsGroundingText = groundingTextOf(flagsFamily);

const validationFlagsDiagnostics = (flags: string): Diagnostic[] => {
  const content = [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    `      <Flags>${flags}</Flags>`,
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n');
  const doc = makeTextDocument(content, {
    fileName: path.join(PROJECT, 'scripts', 'entity_defs', 'FlagProbe.def'),
    languageId: 'kbengine-def'
  });
  const collection = new DiagnosticCollection();
  validateDocument(doc, collection);
  return ((collection.get(doc.uri) as Diagnostic[]) ?? []).filter(d => d.message.includes('Flags'));
};

// ---- cell-data-snapshot 族形状与鞍具 ----
interface CellDataEntry extends TruthEntryBase {
  input: {
    path: 'base-script';
    method: string;
    body: string[];
    universe: { defFields: string[]; builtins: string[] };
  };
  kode: TruthEntryBase['kode'] & {
    validation?: {
      wrongKey: { line: number; key: string; kind: string; candidate: string }[];
      lifecycle: { line: number; character: number; length: number }[];
    };
  };
}
const cellDataFamily = families.find(f => f.family === 'cell-data-snapshot')!;
const cellDataEntries = cellDataFamily.entries as unknown as CellDataEntry[];
const cellDataGroundingText = groundingTextOf(cellDataFamily);

/** 键宇宙按 Rust cellDataKeys 契约形构造(CELL-01 def 字段 + CELL-02 内建封闭表;
 * Rust 侧组合面由 cargo cell 测试钉,此处钉的是消费面在给定宇宙下的行为)。 */
const cellDataUniverseOf = (input: CellDataEntry['input']): CellDataKeyEntry[] => [
  ...input.universe.defFields.map(key => ({
    key,
    kind: 'defField' as const,
    typeLabel: 'UINT8',
    sourceFile: 'Avatar.def',
    sourceLine: 4
  })),
  ...input.universe.builtins.map(key => ({
    key,
    kind: 'builtin' as const,
    typeLabel: 'Vector3Like',
    sourceFile: 'server/baseapp/entity.cpp:250',
    sourceLine: null
  }))
];
const cellDataSnippetOf = (input: CellDataEntry['input']): string =>
  ['class Avatar:', `    def ${input.method}(self):`, ...input.body.map(l => `        ${l}`)].join('\n');

// ---- cell-data-role-face 族形状与鞍具 ----
interface RoleFaceEntry extends TruthEntryBase {
  input: { path: string; roleProbes?: string[]; signature?: string };
  kode: TruthEntryBase['kode'] & {
    validation?: { roleGate: ({ role: string; entity: string } | null)[] };
  };
}
const roleFaceFamily = families.find(f => f.family === 'cell-data-role-face')!;
const roleFaceEntries = roleFaceFamily.entries as unknown as RoleFaceEntry[];

// ---- ① schema 门(全族) ----
describe('真值语料 schema 门(KSEM-QA-01)', () => {
  it('每族 grounding 依据档真实存在且带引擎 HEAD', () => {
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) {
      const docPath = path.join(__dirname, '..', family.grounding.doc);
      expect(fs.existsSync(docPath), family.grounding.doc).toBe(true);
      expect(family.grounding.engineHead).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  it('全族条目结构完备:id 唯一/kind 合法且与 engine.load 一致/unknown 必有 reason', () => {
    for (const family of families) {
      expect(family.entries.length).toBeGreaterThan(0);
      const ids = family.entries.map(e => (e as TruthEntryBase).id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const raw of family.entries) {
        const entry = raw as TruthEntryBase;
        expect(['positive', 'negative', 'unknown']).toContain(entry.kind);
        expect(['accept', 'reject', 'reject-silent']).toContain(entry.engine.load);
        expect(['pinned', 'not-analyzed', 'unverified']).toContain(entry.kode.status);
        if (entry.kind === 'positive') {
          expect(entry.engine.load).toBe('accept');
        }
        if (entry.kind === 'negative') {
          expect(['reject', 'reject-silent']).toContain(entry.engine.load);
        }
        if (entry.kind === 'unknown') {
          // 未知例必须写明缺口与下一步(诚实,不用推测填)
          expect(entry.reason?.length ?? 0).toBeGreaterThan(0);
        }
        expect(entry.engine.truth.length).toBeGreaterThan(0);
      }
    }
  });

  it('evidence containment:每条依据逐字出现在该族依据档(伪造锚点即红)', () => {
    for (const family of families) {
      const docText = groundingTextOf(family);
      for (const raw of family.entries) {
        const entry = raw as TruthEntryBase;
        expect(entry.evidence.length).toBeGreaterThan(0);
        for (const fragment of entry.evidence) {
          expect(docText.includes(fragment)).toBe(
            true,
            `evidence 不在 ${family.grounding.doc}: ${JSON.stringify(fragment)} (entry ${entry.id})`
          );
        }
      }
    }
  });
});

// ---- ② def-property-flags 执行门 ----
describe('真值语料 execution 门:def-flags 分析面(defAnalyzer/flagDomains 生成镜像)', () => {
  const pinnedXml = flagsEntries.filter(
    e => e.kode.status === 'pinned' && e.input.path === 'xml'
  );

  it('每条 pinned xml 条目的域位与词元实测等于语料钉值(drift 即红)', () => {
    expect(pinnedXml.length).toBeGreaterThan(0);
    for (const entry of pinnedXml) {
      expect(propertyFlagDomainList(entry.input.spelling)).toEqual(
        entry.kode.analysis?.domains,
        `analysis domains drift: ${entry.id}`
      );
      expect(normalizeFlagTokens(entry.input.spelling)).toEqual(
        entry.kode.analysis?.tokens,
        `normalizeFlagTokens drift: ${entry.id}`
      );
    }
  });
});

describe('真值语料 execution 门:def-flags 验证面(语言侧实时诊断)', () => {
  const pinnedXml = flagsEntries.filter(
    e => e.kode.status === 'pinned' && e.input.path === 'xml'
  );

  it('诊断面按语料钉值出/不出(pipe 组合/未知拼写/静默三类)', () => {
    for (const entry of pinnedXml) {
      const diags = validationFlagsDiagnostics(entry.input.spelling);
      const wanted = entry.kode.validation?.diagnostic ?? 'none';
      if (wanted === 'none') {
        expect(diags, `validation 应静默: ${entry.id}`).toEqual([]);
      } else if (wanted === 'pipe') {
        expect(diags.some(d => d.message.includes("不支持 '|' 组合形态"))).toBe(true);
      } else {
        expect(diags.some(d => d.message.includes('未知的 KBEngine Flags 值'))).toBe(true);
      }
    }
  });
});

// ---- ③ cell-data-snapshot 执行门 ----
describe('真值语料 execution 门:cell-data 键面+时序面(封闭世界双面)', () => {
  const pinned = cellDataEntries.filter(e => e.kode.status === 'pinned');

  it('每条 pinned 条目的 wrongKey/lifecycle 实测等于语料钉值(drift 即红)', () => {
    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      const snippet = cellDataSnippetOf(entry.input);
      const universe = cellDataUniverseOf(entry.input);
      const worldOpen = cellDataKeyWorldOpen(snippet);
      expect(worldOpen, `worldOpen: ${entry.id}`).toBe(false);
      const facts = trackCellDataKeys(snippet, universe);
      const wrongKey = cellDataWrongKeyFindings(facts, universe, worldOpen).map(f => ({
        line: f.line,
        key: f.key,
        kind: f.kind,
        candidate: f.candidate
      }));
      const lifecycle = cellDataCallbackFindings(snippet).map(f => ({
        line: f.line,
        character: f.character,
        length: f.length
      }));
      expect(wrongKey, `wrongKey drift: ${entry.id}`).toEqual(entry.kode.validation?.wrongKey ?? []);
      expect(lifecycle, `lifecycle drift: ${entry.id}`).toEqual(
        entry.kode.validation?.lifecycle ?? []
      );
    }
  });
});

// ---- ④ cell-data-role-face 执行门 ----
describe('真值语料 execution 门:cell-data 角色闸接管矩阵(KR-AUD-74 布局)', () => {
  const pinned = roleFaceEntries.filter(
    e => e.kode.status === 'pinned' && (e.input.roleProbes?.length ?? 0) > 0
  );

  it('每条 pinned 条目的角色闸实测等于语料钉值(drift 即红)', () => {
    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      const actual = entry.input.roleProbes!.map(p => cellScriptRoleAndEntity(p));
      expect(actual, `roleGate drift: ${entry.id}`).toEqual(entry.kode.validation?.roleGate);
    }
  });
});
