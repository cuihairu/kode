import { describe, expect, it } from 'vitest';
import { hashDefContent, compareEngineDigest, negotiateEngineDigest } from '../src/backend/hotReloadDefHash';
import {
  classifyDefChange,
  semanticFingerprintReport
} from '../src/backend/hotReloadDefStructure';
import { compareFingerprints, resolveFingerprintProfile } from '../src/backend/hotReloadFingerprintCompare';
import { analyzeTypesImpact } from '../src/backend/hotReloadTypesImpact';
import {
  evaluateDefFingerprint,
  type DefFingerprintSnapshot
} from '../src/backend/hotReloadDefFingerprintLedger';

// RUST-402(旧 HR-HASH-015)指纹六维单测:同内容路径不同/换行/注释/语义/
// 依赖/Profile。口径:fileHash 逐字节敏感(不做归一化),语义指纹只看结构
// (换行/注释/空白不进指纹);依赖影响不进本文件指纹(file-only,归影响
// 分析账);本地指纹与引擎 Profile 正交(客户端恒 sha256,Profile 只决定
// 引擎 Digest 面可不可比)。unknown 一律点名原因,不猜。

const BASE = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type> UINT32 </Type>',
  '      <Flags> CELL_PUBLIC </Flags>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

const crlf = BASE.replace(/\n/g, '\r\n');
const withComment = BASE.replace('</root>', '  <!-- 只是注释 -->\n</root>');
const typeChanged = BASE.replace('UINT32', 'UINT64');

/** 快照面:内容直接给(不经读面),计时固定 */
const snapshotOf = (text: string, source: 'document' | 'disk' = 'document'): DefFingerprintSnapshot => {
  const hash = hashDefContent(text);
  return {
    fileHash: hash.digest,
    byteLength: hash.byteLength,
    semanticHash: semanticFingerprintReport(text).hash,
    source,
    at: 1000,
    durationMs: 0
  };
};

describe('维度① 同内容路径不同:指纹只看内容,与路径无关', () => {
  it('同内容两路径:fileHash/语义指纹逐位相等(路径不进指纹输入)', () => {
    const rootA = snapshotOf(BASE);
    const rootB = snapshotOf(BASE);
    expect(rootA.fileHash).toBe(rootB.fileHash);
    expect(rootA.semanticHash).toBe(rootB.semanticHash);
    expect(rootA.byteLength).toBe(rootB.byteLength);
  });

  it('内容一字之差:摘要全变(内容敏感兜底,防路径维度偷换内容)', () => {
    expect(hashDefContent(BASE).digest).not.toBe(hashDefContent(typeChanged).digest);
  });

  it('台账侧两路径各自独立存底(键区分度在装配,指纹值相等≠串册)', () => {
    // 指纹值相等是「内容相同」的如实反映;台账判定按文件键各走各的:
    // 两个不同键、同指纹值 → 各自 last 判 unchanged,不互相覆盖。
    const a = snapshotOf(BASE);
    const verdictA = evaluateDefFingerprint(a, snapshotOf(BASE));
    const verdictB = evaluateDefFingerprint(a, snapshotOf(typeChanged));
    expect(verdictA.fileChanged).toBe('unchanged');
    expect(verdictB.fileChanged).toBe('changed');
  });
});

describe('维度② 换行变化:fileHash 如实变,语义指纹不变,非结构性', () => {
  it('CRLF vs LF:fileHash 不同(逐字节敏感,不擅自折算)', () => {
    expect(hashDefContent(BASE).digest).not.toBe(hashDefContent(crlf).digest);
    expect(hashDefContent(crlf).byteLength).toBeGreaterThan(hashDefContent(BASE).byteLength);
  });

  it('CRLF vs LF:语义指纹相同(结构未变)', () => {
    expect(semanticFingerprintReport(crlf).hash).toBe(semanticFingerprintReport(BASE).hash);
  });

  it('classifyDefChange:换行变化 → 非结构性零原因', () => {
    const verdict = classifyDefChange(BASE, crlf);
    expect(verdict.structural).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it('三路判定:file=changed + semantic=unchanged(分路如实,不并路)', () => {
    const verdict = evaluateDefFingerprint(snapshotOf(BASE), snapshotOf(crlf));
    expect(verdict.fileChanged).toBe('changed');
    expect(verdict.semanticChanged).toBe('unchanged');
  });
});

describe('维度③ 注释变化:fileHash 如实变,语义指纹不变,非结构性', () => {
  it('加注释:fileHash 不同,byteLength 增加', () => {
    expect(hashDefContent(withComment).digest).not.toBe(hashDefContent(BASE).digest);
    expect(hashDefContent(withComment).byteLength).toBeGreaterThan(hashDefContent(BASE).byteLength);
  });

  it('加注释:语义指纹相同(注释不进结构指纹)', () => {
    expect(semanticFingerprintReport(withComment).hash).toBe(semanticFingerprintReport(BASE).hash);
  });

  it('classifyDefChange:注释变化 → 非结构性;三路判定 file=changed+semantic=unchanged', () => {
    expect(classifyDefChange(BASE, withComment).structural).toBe(false);
    const verdict = evaluateDefFingerprint(snapshotOf(BASE), snapshotOf(withComment));
    expect(verdict.fileChanged).toBe('changed');
    expect(verdict.semanticChanged).toBe('unchanged');
  });
});

describe('维度④ 语义改变:两路都变,结构性拦下', () => {
  it('Type 改 UINT32→UINT64:fileHash 与语义指纹都变(等字节长也逃不掉)', () => {
    expect(hashDefContent(BASE).byteLength).toBe(hashDefContent(typeChanged).byteLength);
    expect(hashDefContent(BASE).digest).not.toBe(hashDefContent(typeChanged).digest);
    expect(semanticFingerprintReport(BASE).hash).not.toBe(semanticFingerprintReport(typeChanged).hash);
  });

  it('classifyDefChange:Type 改 → 结构性点名 hp,需重启', () => {
    const verdict = classifyDefChange(BASE, typeChanged);
    expect(verdict.structural).toBe(true);
    expect(verdict.restartRequired).toBe(true);
    expect(verdict.reasons.join('\n')).toContain('hp');
  });

  it('三路判定:file=changed + semantic=changed(语义变化两路如实)', () => {
    const verdict = evaluateDefFingerprint(snapshotOf(BASE), snapshotOf(typeChanged));
    expect(verdict.fileChanged).toBe('changed');
    expect(verdict.semanticChanged).toBe('changed');
  });

  it('语义指纹解析失败一侧:null 如实,不造值(unknown 点名)', () => {
    const bad = semanticFingerprintReport('not a def document');
    expect(bad.hash).toBeNull();
    const verdict = compareFingerprints({
      lastSemanticHash: semanticFingerprintReport(BASE).hash,
      currentSemanticHash: null
    });
    expect(verdict.semanticChanged).toBe('unknown');
    expect(verdict.reasons.some(reason => reason.includes('解析失败'))).toBe(true);
  });
});

describe('维度⑤ 依赖变更:本文件指纹稳定,影响归影响分析账', () => {
  const DEF_REF = [
    '<root>',
    '  <Properties>',
    '    <skill>',
    '      <Type> SKILL_SLOT </Type>',
    '    </skill>',
    '  </Properties>',
    '</root>'
  ].join('\n');
  const TYPES_BEFORE = [
    '<types>',
    '  <SKILL_SLOT>',
    '    <of> ARRAY </of>',
    '  </SKILL_SLOT>',
    '</types>'
  ].join('\n');
  const TYPES_AFTER = TYPES_BEFORE.replace('ARRAY', 'FIXED_DICT');

  it('语义指纹 scope=file-only:types.xml 变化不改 .def 自身指纹', () => {
    const before = semanticFingerprintReport(DEF_REF);
    const after = semanticFingerprintReport(DEF_REF); // .def 文本未变
    expect(before.scope).toBe('file-only-semantic');
    expect(before.hash).toBe(after.hash);
    // note 点名依赖核验义务(依赖影响在别账,不静默并入本文件指纹)
    expect(before.note).toContain('依赖');
  });

  it('影响分析侧:SKILL_SLOT 形状变 → 引用它的 .def 受影响(依赖影响如实入账)', () => {
    const report = analyzeTypesImpact({
      beforeTypesXml: TYPES_BEFORE,
      afterTypesXml: TYPES_AFTER,
      defs: [{ name: 'Avatar.def', text: DEF_REF }]
    });
    expect(report.changedTypes).toEqual([
      expect.objectContaining({ name: 'SKILL_SLOT', change: 'changed' })
    ]);
    expect(report.affectedDefs.some(def => def.name === 'Avatar.def')).toBe(true);
    expect(report.anyAffected).toBe(true);
  });

  it('分工口径:依赖变不改本文件 classifyDefChange 结论(文件级无变化=非结构性)', () => {
    // .def 文本一个字没动:文件级判定必须非结构性;需重启的判定来自
    // 影响分析(anyAffected),不由文件指纹越权代判。
    const verdict = classifyDefChange(DEF_REF, DEF_REF);
    expect(verdict.structural).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });
});

describe('维度⑥ Profile 不同:本地指纹与引擎 Profile 正交', () => {
  it('本地指纹恒 sha256:引擎算法协商成败都不改本地摘要', () => {
    const negotiated = resolveFingerprintProfile('d41d8cd98f00b204e9800998ecf8427e');
    expect(negotiated).toEqual({ digestAlgorithm: 'md5', negotiated: true, label: 'md5' });
    const notAvailable = resolveFingerprintProfile();
    expect(notAvailable).toEqual({
      digestAlgorithm: 'unknown',
      negotiated: false,
      label: 'not available'
    });
    // 两个 Profile 下本地指纹逐位同值:Profile 只影响引擎 Digest 面
    const local = hashDefContent(BASE);
    expect(local.algorithm).toBe('sha256');
    expect(local).toEqual(hashDefContent(BASE));
  });

  it('未协商 Profile:applied 路 unknown 点名,不猜引擎算法', () => {
    const verdict = compareFingerprints({
      localRecomputedMd5: 'm1',
      serverAppliedDigest: 'm1'
      // 无 engineMd5 → 未协商
    });
    expect(verdict.appliedConsistency).toBe('unknown');
    expect(verdict.reasons.some(reason => reason.includes('未协商'))).toBe(true);
  });

  it('md5 协商 Profile 仍拒绝与客户端 sha256 跨类比对(不同算法不冒充)', () => {
    const negotiated = negotiateEngineDigest('7D30F640C07CD601D0E5B4083EFC6E40');
    expect(negotiated.negotiated).toBe(true);
    const cmp = compareEngineDigest(negotiated, hashDefContent(BASE));
    expect(cmp.comparable).toBe(false);
    expect(cmp.reason).toContain('sha256');
  });

  it('同 Profile 内 applied 路可比:md5 三环齐 → consistent', () => {
    const ENGINE_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
    const verdict = compareFingerprints({
      engineMd5: ENGINE_MD5,
      localRecomputedMd5: 'm1',
      serverAppliedDigest: 'm1'
    });
    expect(verdict.appliedConsistency).toBe('consistent');
  });
});
