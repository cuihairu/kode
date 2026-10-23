import { describe, expect, it } from 'vitest';
import {
  ENGINE_DIGEST_ALGORITHM,
  classifyThreePath,
  compareEngineDigest,
  formatThreePathEcho,
  hashDefContent,
  negotiateEngineDigest,
  verdictFromTempEditOutcome
} from '../src/hotReloadDefHash';
import type { DefContentHash, ThreePathInput } from '../src/hotReloadDefHash';
import type { TempEditReloadOutcome } from '../src/hotReloadTempEdit';

// 书 docs/kode2/KODE_2_COMPLETE_TODO.md §19 委托书 HR-PR-03:.def Hash/Digest
// 三路径(transport_ok / accepted / applied)+ 客户端 sha256 + Digest 协商描桩。
// 铁律:applied 只信引擎明确回执,unknown 即 false;unknown 算法禁止比对。

const makeHash = (digest: string, byteLength = 32): DefContentHash => ({
  algorithm: 'sha256',
  digest,
  byteLength
});

const makeOutcome = (
  phase: TempEditReloadOutcome['phase'],
  transportOk: boolean
): TempEditReloadOutcome => ({
  phase,
  transportOk,
  applied: false,
  detail: 'test',
  dualName: { unsupported: 'test' }
});

describe('hashDefContent(客户端 .def 内容 sha256,现成原语)', () => {
  it('已知向量:空串/hello/最小 .def 与 node:crypto sha256 一致', () => {
    expect(hashDefContent('').digest).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(hashDefContent('hello').digest).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
    expect(hashDefContent('<Root>\n</Root>\n').digest).toBe(
      'a91853a246478374c55abffed155016c89f343adfb447b5d4eb42cd6709bae8c'
    );
  });

  it('算法恒 sha256,byteLength 按 UTF-8 字节计(非字符数)', () => {
    const ascii = hashDefContent('abc');
    expect(ascii.algorithm).toBe('sha256');
    expect(ascii.byteLength).toBe(3);
    // 中文 3 字节/字:长度按字节,不按码点
    const cjk = hashDefContent('武器');
    expect(cjk.byteLength).toBe(6);
    expect(cjk.digest).not.toBe(ascii.digest);
  });

  it('内容敏感:一字之差摘要全变;确定性:同输入同摘要', () => {
    const a = hashDefContent('<Root>\n  <Monster/>\n</Root>\n');
    const b = hashDefContent('<Root>\n  <Monster2/>\n</Root>\n');
    const a2 = hashDefContent('<Root>\n  <Monster/>\n</Root>\n');
    expect(a.digest).not.toBe(b.digest);
    expect(a.digest).toBe(a2.digest);
    // 换行形态差异如实反映在摘要里(归一化 unknown,不擅自 CRLF 折算)
    expect(hashDefContent('<Root>\n</Root>\n').digest).not.toBe(
      hashDefContent('<Root>\r\n</Root>\r\n').digest
    );
  });
});

describe('classifyThreePath(三路径接受判定)', () => {
  const base = (input: ThreePathInput) => classifyThreePath(input);

  it('路径 1 传输 ok:transportOk=true 无回执 → sent-unverified,accepted/applied 均 false', () => {
    const v = base({ transportOk: true });
    expect(v.path).toBe('sent-unverified');
    expect(v.transportOk).toBe(true);
    expect(v.accepted).toBe(false);
    expect(v.applied).toBe(false);
    expect(v.acceptedState).toBe('unknown');
    expect(v.appliedState).toBe('unknown');
    expect(v.detail).toContain('已发送(未确认)');
  });

  it('路径 2 accepted:confirmed → accepted=true,但 applied 仍 false(unknown 不升级)', () => {
    const v = base({ transportOk: true, accepted: 'confirmed' });
    expect(v.path).toBe('accepted-unverified');
    expect(v.accepted).toBe(true);
    expect(v.applied).toBe(false);
    expect(v.detail).toContain('不显示「已热更新」');
  });

  it('路径 3 applied:仅引擎明确回执 confirmed → applied=true', () => {
    const v = base({ transportOk: true, accepted: 'confirmed', applied: 'confirmed' });
    expect(v.path).toBe('applied');
    expect(v.applied).toBe(true);
    expect(v.accepted).toBe(true);
  });

  it('applied 铁律:unknown 与 denied 一律 applied=false,路径不达 applied', () => {
    for (const evidence of ['unknown', 'denied'] as const) {
      const v = base({ transportOk: true, applied: evidence });
      expect(v.applied).toBe(false);
      expect(v.path).not.toBe('applied');
      expect(v.appliedState).toBe(evidence);
    }
  });

  it('证据缺失不因更高层补齐:applied=confirmed 而 accepted=unknown 时 accepted 仍 false', () => {
    const v = base({ transportOk: true, applied: 'confirmed' });
    expect(v.path).toBe('applied');
    expect(v.applied).toBe(true);
    expect(v.accepted).toBe(false);
    expect(v.acceptedState).toBe('unknown');
  });

  it('传输失败:路径 transport-failed,accepted/applied 不误报 true', () => {
    const v = base({ transportOk: false, accepted: 'unknown', applied: 'unknown' });
    expect(v.path).toBe('transport-failed');
    expect(v.transportOk).toBe(false);
    expect(v.accepted).toBe(false);
    expect(v.applied).toBe(false);
    expect(v.detail).toContain('传输失败');
  });

  it('上层回执反证传输成功:accepted/applied confirmed 时 transportOk 升为 true', () => {
    expect(base({ transportOk: false, accepted: 'confirmed' }).transportOk).toBe(true);
    expect(base({ transportOk: false, applied: 'confirmed' }).path).toBe('applied');
  });

  it('非法证据值容错归 unknown:不猜不抛', () => {
    const v = base({
      transportOk: true,
      accepted: 'yes' as unknown as ThreePathInput['accepted'],
      applied: true as unknown as ThreePathInput['applied']
    });
    expect(v.acceptedState).toBe('unknown');
    expect(v.appliedState).toBe('unknown');
    expect(v.path).toBe('sent-unverified');
  });
});

describe('negotiateEngineDigest / compareEngineDigest(引擎 Digest 描桩)', () => {
  it('协商恒返回 unknown/未协商:HR-AUDIT-008 仓库内零证据,不猜算法', () => {
    const h = negotiateEngineDigest();
    expect(h.algorithm).toBe('unknown');
    expect(h.algorithm).toBe(ENGINE_DIGEST_ALGORITHM);
    expect(h.negotiated).toBe(false);
    expect(h.reason).toContain('HR-AUDIT-008');
    expect(h.reason).toContain('unknown');
  });

  it('unknown 算法禁止与客户端 hash 比对:comparable 恒 false', () => {
    const h = negotiateEngineDigest();
    const cmp = compareEngineDigest(h, hashDefContent('<Root/>\n'));
    expect(cmp.comparable).toBe(false);
    expect(cmp.reason).toContain('拒绝比对');
  });

  it(' negotiated=false 时即便算法字段异常也拒绝比对(双闸门)', () => {
    const h = { ...negotiateEngineDigest(), algorithm: 'sha256' as never };
    const cmp = compareEngineDigest(h, hashDefContent('x'));
    expect(cmp.comparable).toBe(false);
  });
});

describe('verdictFromTempEditOutcome(接入 HR-PR-02 回执链路)', () => {
  it('HR-PR-02 sent-unverified → 三路径 sent-unverified,applied=false(回显链路同口径)', () => {
    const v = verdictFromTempEditOutcome(makeOutcome('sent-unverified', true));
    expect(v.path).toBe('sent-unverified');
    expect(v.transportOk).toBe(true);
    expect(v.applied).toBe(false);
  });

  it('HR-PR-02 失败 phase(restore-failed 等)→ transport-failed,不进入上两层', () => {
    for (const phase of [
      'sent-failed',
      'missing-action',
      'read-failed',
      'edit-write-failed',
      'restore-failed'
    ] as const) {
      const v = verdictFromTempEditOutcome(makeOutcome(phase, false));
      expect(v.path).toBe('transport-failed');
      expect(v.transportOk).toBe(false);
    }
  });

  it('outcome.phase 未达 sent-unverified 时,transportOk 字面量 true 也不采信(以 phase 为准)', () => {
    const v = verdictFromTempEditOutcome(makeOutcome('sent-failed', true));
    expect(v.path).toBe('transport-failed');
  });

  it('外部引擎回执透传:applied confirmed 才允许 applied=true;映射自身永不造 confirmed', () => {
    const withReceipt = verdictFromTempEditOutcome(makeOutcome('sent-unverified', true), {
      accepted: 'confirmed',
      applied: 'confirmed'
    });
    expect(withReceipt.path).toBe('applied');
    expect(withReceipt.applied).toBe(true);
    const noReceipt = verdictFromTempEditOutcome(makeOutcome('sent-unverified', true));
    expect(noReceipt.applied).toBe(false);
    expect(noReceipt.appliedState).toBe('unknown');
  });
});

describe('formatThreePathEcho(复用 HR-PR-02 符号口径的回显行)', () => {
  it('三样例:sent-unverified / applied / transport-failed 文案与状态同源', () => {
    const hash = makeHash('a'.repeat(64), 15);
    const sent = formatThreePathEcho('Monster.def', hash, classifyThreePath({ transportOk: true }));
    expect(sent).toContain('● .def 判定[Monster.def]');
    expect(sent).toContain('sha256=aaaaaaaaaaaa…(15B)');
    expect(sent).toContain('传输✓ 已发送(未确认)');
    expect(sent).toContain('accepted=unknown');
    expect(sent).toContain('applied=unknown');

    const applied = formatThreePathEcho(
      'Avatar.def',
      hash,
      classifyThreePath({ transportOk: true, applied: 'confirmed' })
    );
    expect(applied).toContain('引擎明确回执已应用');
    expect(applied).toContain('applied=confirmed');

    const failed = formatThreePathEcho(
      'NPC.def',
      hash,
      classifyThreePath({ transportOk: false })
    );
    expect(failed).toContain('✗ .def 判定[NPC.def]');
    expect(failed).toContain('传输失败');
  });

  it('unknown 边界声明:sent-unverified 回显不出现「已热更新」字样', () => {
    const sent = formatThreePathEcho(
      'Monster.def',
      makeHash('b'.repeat(64)),
      classifyThreePath({ transportOk: true })
    );
    expect(sent).not.toContain('已热更新');
  });
});
