/**
 * QA-001b:Proxy 会话语义检查面(两个分歧臂)纯检查面单测。
 * 判例源 docs/knowledge/proxy-session-semantics.md §4/§6(引擎头 55a66552):
 * - onLogOnAttempt 返回值矩阵:WAIT_FOR_DESTROY 与 default 同支=同拒绝;
 * - giveClientTo 五前置校验边界:目标是自己=前置校验必败(可证);
 * 其余四前置(源已销毁/源无客户端/目标已销毁/目标已有客户端)非静态可证→不猜。
 * 只对 baseapp 实体脚本(Proxy 会话域)接管。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setL10nBundle } from './fake-vscode/l10n';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';
import {
  PROXY_SESSION_DIAGNOSTIC_CODE,
  findProxySessionFindings,
  proxySessionFindingsToItems
} from '../src/backend/proxySessionSemanticsDiagnostics';

afterEach(() => {
  setL10nBundle(null);
});

const onLogOnAttemptScript = [
  'class Avatar(Base):',
  '    def onLogOnAttempt(self, ip, port, password):',
  '        return KBEngine.LOG_ON_WAIT_FOR_DESTROY',
  ''
].join('\n');

const onLogOnAttemptAcceptScript = [
  'class Avatar(Base):',
  '    def onLogOnAttempt(self, ip, port, password):',
  '        return KBEngine.LOG_ON_ACCEPT',
  ''
].join('\n');

const giveClientToSelfScript = [
  'class Avatar(Base):',
  '    def onLogOnAttempt(self, ip, port, password):',
  '        return KBEngine.LOG_ON_ACCEPT',
  '',
  '    def migrate(self, target):',
  '        self.giveClientTo(self)',
  ''
].join('\n');

const giveClientToOtherScript = [
  'class Avatar(Base):',
  '    def migrate(self, target):',
  '        self.giveClientTo(target)',
  ''
].join('\n');

describe('proxy session semantics diagnostics (pure)', () => {
  it('臂 1:onLogOnAttempt 返回 WAIT_FOR_DESTROY → 分歧臂报', () => {
    const findings = findProxySessionFindings(onLogOnAttemptScript, ['baseapp']);
    expect(findings.map(f => f.kind)).toEqual(['logon-attempt-wait-for-destroy']);
    expect(findings[0].line).toBe(2);
    expect(findings[0].message).toContain('LOG_ON_WAIT_FOR_DESTROY');
    expect(findings[0].message).toContain('4020-4021');
  });

  it('臂 1:返回 LOG_ON_ACCEPT → 不报(稳定返回值)', () => {
    expect(findProxySessionFindings(onLogOnAttemptAcceptScript, ['baseapp'])).toHaveLength(0);
  });

  it('臂 1:非 onLogOnAttempt 方法内的 WAIT_FOR_DESTROY → 不误报', () => {
    const script = [
      'class Avatar(Base):',
      '    def other(self):',
      '        return KBEngine.LOG_ON_WAIT_FOR_DESTROY',
      ''
    ].join('\n');
    expect(findProxySessionFindings(script, ['baseapp'])).toHaveLength(0);
  });

  it('臂 2:giveClientTo(self) → 目标是自己前置校验必败,报', () => {
    const findings = findProxySessionFindings(giveClientToSelfScript, ['baseapp']);
    expect(findings.map(f => f.kind)).toContain('give-client-to-self');
    const give = findings.find(f => f.kind === 'give-client-to-self')!;
    expect(give.line).toBe(5);
    expect(give.message).toContain('giveClientTo(self)');
    expect(give.message).toContain('onGiveClientToFailure');
  });

  it('臂 2:giveClientTo(target) → 不报(非可证前置)', () => {
    expect(findProxySessionFindings(giveClientToOtherScript, ['baseapp'])).toHaveLength(0);
  });

  it('面闸:非 baseapp(cellapp/client)零产出', () => {
    expect(findProxySessionFindings(onLogOnAttemptScript, ['cellapp'])).toHaveLength(0);
    expect(findProxySessionFindings(onLogOnAttemptScript, ['client'])).toHaveLength(0);
  });

  it('面闸:面不明(null)零产出,不猜', () => {
    expect(findProxySessionFindings(onLogOnAttemptScript, null)).toHaveLength(0);
  });

  it('注释/字符串里的 WAIT_FOR_DESTROY/giveClientTo(self) 被掩码,不误报', () => {
    const script = [
      'class Avatar(Base):',
      '    def onLogOnAttempt(self, ip, port, password):',
      '        # return KBEngine.LOG_ON_WAIT_FOR_DESTROY  (comment)',
      '        x = "giveClientTo(self)"',
      '        return KBEngine.LOG_ON_ACCEPT',
      ''
    ].join('\n');
    expect(findProxySessionFindings(script, ['baseapp'])).toHaveLength(0);
  });

  it('诊断项:纯数据带 code/Warning/kbengine,免 vscode', () => {
    const items = proxySessionFindingsToItems(findProxySessionFindings(onLogOnAttemptScript, ['baseapp']));
    expect(items).toHaveLength(1);
    expect(items[0].code).toBe(PROXY_SESSION_DIAGNOSTIC_CODE);
    expect(items[0].severity).toBe('Warning');
    expect(items[0].source).toBe('kbengine');
  });

  it('zh-cn 文案:注入 bundle 后渲染中文', () => {
    setL10nBundle(zhCnBundle);
    const give = findProxySessionFindings(giveClientToSelfScript, ['baseapp'])
      .find(f => f.kind === 'give-client-to-self')!;
    expect(give.message).toContain('onGiveClientToFailure');
    const logon = findProxySessionFindings(onLogOnAttemptScript, ['baseapp'])[0];
    expect(logon.message).toContain('等待');
  });
});
