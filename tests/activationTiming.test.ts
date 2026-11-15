import { describe, expect, it } from 'vitest';

import { parseActivationLog } from '../src/backend/activationTiming';

// RUST-022 extension activation 段:纯解析核单测(离线合成宿主日志,
// 不起宿主)。日志行格式取自真实 exthost.log 的 info 级激活行。

const EXT = 'cuihairu.kode-kbengine';

const row = (offsetMs: number, level: string, message: string): string => {
  const at = new Date(Date.UTC(2026, 10, 15, 13, 16, 0, 0) + offsetMs);
  return `${at.toISOString().slice(0, 23).replace('T', ' ')} [${level}] ${message}`;
};

const logWith = (rows: Array<[number, string, string]>): string =>
  rows
    .map(([offset, level, message]) => row(offset, level, message))
    .join('\n') + '\n';

describe('parseActivationLog', () => {
  it('宿主起→激活入口→eager 完成,派生时延相减正确', () => {
    const text = logWith([
      [0, 'info', 'Extension host with pid 92203 started'],
      [100, 'info', 'ExtensionService#_doActivateExtension vscode.git, startup: true, activationEvent: \'*\''],
      [2838, 'info', `ExtensionService#_doActivateExtension ${EXT}, startup: true, activationEvent: 'workspaceContains:**/*.def'`],
      [5107, 'info', 'Eager extensions activated'],
      [23214, 'info', 'Extension host with pid 92203 exiting with code 0']
    ]);

    const report = parseActivationLog(text, EXT);
    expect(report).not.toBeNull();
    if (!report) { return; }
    expect(report.activationEvent).toBe('workspaceContains:**/*.def');
    expect(report.derived.hostStartToActivateMs).toBe(2838);
    expect(report.derived.activateToEagerMs).toBe(2269);
    expect(report.derived.hostStartToEagerMs).toBe(5107);
    expect(report.segments.hostExitMs).toBe(
      new Date(Date.UTC(2026, 10, 15, 13, 16, 0, 0) + 23214).getTime()
    );
    // 本扩展是最后一个启动期激活者:v 行之后没有其他 startup 激活排队
    expect(report.derived.trailingStartupActivations).toBe(0);
  });

  it('本扩展之后还有启动期激活者时如实披露(激活窗是混合窗口)', () => {
    // 真实形态:git/git-base/github → 本扩展 → ms-python.envs → Eager。
    // activateToEager 这一段含 python.envs 的激活体,必须同时给尾随计数,
    // 否则报告会把别人的耗时算成本扩展的。
    const text = logWith([
      [0, 'info', 'Extension host with pid 1 started'],
      [309, 'info', "ExtensionService#_doActivateExtension vscode.git-base, startup: true, activationEvent: '*', root cause: vscode.git"],
      [370, 'info', "ExtensionService#_doActivateExtension vscode.git, startup: true, activationEvent: '*'"],
      [694, 'info', `ExtensionService#_doActivateExtension ${EXT}, startup: true, activationEvent: 'workspaceContains:x.def'`],
      [1499, 'info', 'ExtensionService#_doActivateExtension ms-python.vscode-python-envs, startup: true, activationEvent: \'workspaceContains:**/*.py\''],
      [1784, 'info', 'Eager extensions activated']
    ]);

    const report = parseActivationLog(text, EXT);
    expect(report?.derived.hostStartToActivateMs).toBe(694);
    expect(report?.derived.activateToEagerMs).toBe(1090);
    expect(report?.derived.trailingStartupActivations).toBe(1);
  });

  it('尾随计数只数 startup 激活者,启动期激活全完成后(含懒激活)不计数', () => {
    const text = logWith([
      [0, 'info', 'Extension host with pid 1 started'],
      [100, 'info', `ExtensionService#_doActivateExtension ${EXT}, startup: true, activationEvent: 'workspaceContains:x.def'`],
      [300, 'info', 'Eager extensions activated'],
      // 懒激活发生在 eager 之后,不在启动激活窗内
      [900, 'info', 'ExtensionService#_doActivateExtension vscode.emmet, startup: false, activationEvent: \'onLanguage\''],
      [1000, 'info', `ExtensionService#_doActivateExtension ${EXT}, startup: false, activationEvent: 'onCommand:kbengine.other'`]
    ]);

    const report = parseActivationLog(text, EXT);
    expect(report?.derived.trailingStartupActivations).toBe(0);
    // 懒激活(第二次)不覆盖首次入口
    expect(report?.derived.hostStartToActivateMs).toBe(100);
  });

  it('没有 eager 行时 eager 派生诚实为 null(不造数)', () => {
    const text = logWith([
      [0, 'info', 'Extension host with pid 1 started'],
      [900, 'info', `ExtensionService#_doActivateExtension ${EXT}, startup: false, activationEvent: 'onCommand:kbengine.ping'`],
      [1200, 'trace', 'ExtHostCommands#registerCommand kbengine.ping']
    ]);

    const report = parseActivationLog(text, EXT);
    expect(report).not.toBeNull();
    if (!report) { return; }
    expect(report.derived.hostStartToActivateMs).toBe(900);
    expect(report.derived.activateToEagerMs).toBeNull();
    expect(report.derived.hostStartToEagerMs).toBeNull();
    expect(report.segments.eagerActivatedMs).toBeNull();
    expect(report.segments.hostExitMs).toBeNull();
    expect(report.activationEvent).toBe('onCommand:kbengine.ping');
  });

  it('没有本扩展激活行时整份报告 null(不误归因到其他扩展)', () => {
    const text = logWith([
      [0, 'info', 'Extension host with pid 1 started'],
      [500, 'info', 'ExtensionService#_doActivateExtension vscode.git, startup: true, activationEvent: \'*\''],
      [600, 'info', 'Eager extensions activated']
    ]);
    expect(parseActivationLog(text, EXT)).toBeNull();
  });

  it('没有宿主起行时 null(时间轴缺基准)', () => {
    const text = logWith([
      [500, 'info', `ExtensionService#_doActivateExtension ${EXT}, startup: true`],
      [600, 'info', 'Eager extensions activated']
    ]);
    expect(parseActivationLog(text, EXT)).toBeNull();
  });

  it('重复激活取首次入口,且忽略空行与无法解析的行', () => {
    const text = logWith([
      [0, 'info', 'Extension host with pid 1 started'],
      [1000, 'info', `ExtensionService#_doActivateExtension ${EXT}, startup: true, activationEvent: 'workspaceContains:**/*.def'`],
      [1500, 'info', `ExtensionService#_doActivateExtension ${EXT}, startup: false, activationEvent: 'onCommand:kbengine.other'`],
      [1600, 'info', 'Eager extensions activated']
    ])
      + '\nnot a log line\n   \n';

    const report = parseActivationLog(text, EXT);
    expect(report?.derived.hostStartToActivateMs).toBe(1000);
    expect(report?.activationEvent).toBe('workspaceContains:**/*.def');
  });

  it('宿主日志级别不是 info 也能解析(如 trace 行)', () => {
    const text = logWith([
      [0, 'trace', 'Extension host with pid 1 started'],
      [300, 'trace', `ExtensionService#_doActivateExtension ${EXT}, startup: true`],
      [700, 'trace', 'Eager extensions activated']
    ]);
    const report = parseActivationLog(text, EXT);
    expect(report?.derived.activateToEagerMs).toBe(400);
    expect(report?.activationEvent).toBeNull();
  });

  it('eager 早于本扩展激活入口时不谎称负预算(如实相减,可能为负)', () => {
    const text = logWith([
      [0, 'info', 'Extension host with pid 1 started'],
      [2000, 'info', `ExtensionService#_doActivateExtension ${EXT}, startup: true`],
      [1000, 'info', 'Eager extensions activated']
    ]);
    const report = parseActivationLog(text, EXT);
    // 该形态在真实宿主里不出现(eager 是全量完成信号,必晚于任一启动激活),
    // 解析核按时间戳如实相减,不夹带语义判断——诚实优于粉饰。
    expect(report?.derived.activateToEagerMs).toBe(-1000);
  });
});
