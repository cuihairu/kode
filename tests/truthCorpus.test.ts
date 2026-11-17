// KSEM-QA-01 人工真值语料闸:TS/Rust parity(golden.json)只证两侧一致,
// 本闸证「与引擎真值一致」。三道门:
// ①schema——每条样本 id/kind/engine/evidence/kode 结构完备,kind 与 load 一致;
// ②evidence containment——每条 evidence 逐字出现在依据档里(伪造锚点即红);
// ③execution——分析面+验证面实测输出钉死(探针取真值后写进语料, drift 即红)。
// 依据:def-flags 族 grounding docs/knowledge/def-flags.md(fork 3082ab5)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { propertyFlagDomainList } from '../src/backend/defAnalyzer';
import { normalizeFlagTokens } from '../src/generated/flagDomains';
import { validateDocument } from '../src/languageProviders';
import { Diagnostic, DiagnosticCollection, makeTextDocument } from './helpers/vscodeStub';

interface TruthEntry {
  id: string;
  kind: 'positive' | 'negative' | 'unknown';
  input: { spelling: string; path: 'xml' | 'decorator' };
  engine: { load: 'accept' | 'reject' | 'reject-silent'; truth: string };
  evidence: string[];
  kode: {
    analysis?: { domains: string[]; tokens: string[] };
    validation?: { diagnostic: 'none' | 'pipe' | 'unknown' };
    status: 'pinned' | 'not-analyzed' | 'unverified';
  };
  finding?: string;
  reason?: string;
}

interface TruthFamily {
  family: string;
  grounding: { doc: string; engineHead: string };
  entries: TruthEntry[];
}

const CORPUS_DIR = path.join(__dirname, 'fixtures', 'truth-corpus');
const family: TruthFamily = JSON.parse(
  fs.readFileSync(path.join(CORPUS_DIR, 'def-flags.json'), 'utf8')
);
const groundingDocPath = path.join(__dirname, '..', family.grounding.doc);
const groundingDocText = fs.readFileSync(groundingDocPath, 'utf8');

const PROJECT = path.join(__dirname, 'fixtures', 'parity-project');

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

describe('真值语料 schema 门(KSEM-QA-01)', () => {
  it('grounding 依据档真实存在且带引擎 HEAD', () => {
    expect(fs.existsSync(groundingDocPath)).toBe(true);
    expect(family.grounding.engineHead).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('条目结构完备:id 唯一/kind 合法且与 engine.load 一致/kode.status 合法', () => {
    expect(family.entries.length).toBeGreaterThan(0);
    const ids = family.entries.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of family.entries) {
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
  });

  it('evidence containment:每条依据逐字出现在依据档(伪造锚点即红)', () => {
    for (const entry of family.entries) {
      expect(entry.evidence.length).toBeGreaterThan(0);
      for (const fragment of entry.evidence) {
        expect(groundingDocText.includes(fragment)).toBe(
          true,
          `evidence 不在 ${family.grounding.doc}: ${JSON.stringify(fragment)} (entry ${entry.id})`
        );
      }
    }
  });
});

describe('真值语料 execution 门:分析面(defAnalyzer/flagDomains 生成镜像)', () => {
  const pinnedXml = family.entries.filter(e => e.kode.status === 'pinned' && e.input.path === 'xml');

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

describe('真值语料 execution 门:验证面(语言侧实时诊断)', () => {
  const pinnedXml = family.entries.filter(e => e.kode.status === 'pinned' && e.input.path === 'xml');

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
