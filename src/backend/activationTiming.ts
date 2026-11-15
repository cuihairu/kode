// 激活分段时延解析(RUST-022 extension activation 段)。
//
// 数据源=宿主自己写的 exthost.log(info 级就有激活行,无需 --verbose 或
// --prof-startup——实测 VS Code 1.141 的 --prof-startup 不额外落盘产物,
// 但日志里 `_doActivateExtension`/`Eager extensions activated` 恒定 info 级)。
// 本模块是纯解析核:输入日志文本,输出分段时刻与派生时延;不读盘、不起宿主,
// 故单测可离线跑(见 tests/activationTiming.test.ts)。
//
// 诚实边界:宿主日志不含 `activate()` 返回时刻。可观测的最早结束标记是
// 「Eager extensions activated」(全部启动期激活完成)。因此本模块给出的
// activate 时长是「激活入口 → eager 全量完成」口径,是宿主侧可证下界,
// 不等于扩展同步 activate 体的精确耗时(后者要扩展内埋点,
// 见 docs/perf/2026-11-07-activation-views-first.md 的阶段计时)。
// 日志里没有目标扩展的激活行时返回 null——不造数字。

/** 一次宿主运行里可观测的激活分段时刻(毫秒,日志时间戳解析值) */
export interface ActivationSegments {
  /** `Extension host with pid N started` —— 扩展宿主进程起 */
  hostStartMs: number;
  /** `ExtensionService#_doActivateExtension <id>` —— 本扩展激活入口 */
  activateEnterMs: number;
  /** `Eager extensions activated` —— 启动期激活全部完成 */
  eagerActivatedMs: number | null;
  /** `Extension host with pid N exiting with code N` —— 宿主退出(可选段) */
  hostExitMs: number | null;
}

/** 派生时延:全部由上面的时刻相减得到,不引入外部时钟 */
export interface ActivationDerived {
  /** 宿主起 → 本扩展激活入口 */
  hostStartToActivateMs: number;
  /** 激活入口 → eager 全量完成 */
  activateToEagerMs: number | null;
  /** 宿主起 → eager 全量完成 */
  hostStartToEagerMs: number | null;
  /**
   * 本扩展激活入口之后、Eager 完成之前**另有排队的启动期激活数**。
   * 非 0 时 `activateToEagerMs` 是混合窗口(含其他扩展的激活体),
   * 不能当成本扩展 activate() 的耗时——报告必须同时给这个数。
   */
  trailingStartupActivations: number;
}

export interface ActivationReport {
  extensionId: string;
  /** 触发激活的事件原文(如 workspaceContains 形态的 glob),无则 null */
  activationEvent: string | null;
  segments: ActivationSegments;
  derived: ActivationDerived;
}

// 宿主日志行:`2026-11-15 13:16:19.842 [info] <消息>`,级别在方括号内
const LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[[a-z]+\] (.*)$/;
const HOST_START_RE = /^Extension host with pid \d+ started$/;
const HOST_EXIT_RE = /^Extension host with pid \d+ exiting with code \d+$/;
const EAGER_RE = /^Eager extensions activated$/;
// `_doActivateExtension cuihairu.kode-kbengine, startup: true, activationEvent: '...'`
const ACTIVATE_RE = /^ExtensionService#_doActivateExtension ([^,]+), startup: (true|false)(?:, activationEvent: (.+))?$/;

/** 剥掉包裹的一对引号(日志里 activationEvent 形态为 'workspaceContains:...')。 */
const stripQuotes = (value: string): string =>
  value.length >= 2
    && ((value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"')))
    ? value.slice(1, -1)
    : value;

interface ActivationRecord {
  at: number;
  id: string;
  isStartup: boolean;
}

/** 解析宿主日志文本为目标扩展的激活分段报告;无目标激活行则 null。 */
export function parseActivationLog(text: string, extensionId: string): ActivationReport | null {
  const hostStartMs: number[] = [];
  const hostExitMs: number[] = [];
  const activations: ActivationRecord[] = [];
  let eagerActivatedMs: number | null = null;
  let activateEnterMs: number | null = null;
  let activationEvent: string | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) { continue; }
    const match = LINE_RE.exec(line);
    if (!match) { continue; }
    const at = Date.parse(`${match[1].replace(' ', 'T')}Z`);
    if (Number.isNaN(at)) { continue; }
    const message = match[2];

    if (HOST_START_RE.test(message)) {
      hostStartMs.push(at);
      continue;
    }
    if (HOST_EXIT_RE.test(message)) {
      hostExitMs.push(at);
      continue;
    }
    if (EAGER_RE.test(message)) {
      if (eagerActivatedMs === null) { eagerActivatedMs = at; }
      continue;
    }
    const activate = ACTIVATE_RE.exec(message);
    if (!activate) { continue; }
    const id = activate[1].trim();
    const isStartup = activate[2] === 'true';
    activations.push({ at, id, isStartup });
    if (id === extensionId && activateEnterMs === null) {
      // 同一扩展若被多事件重复激活,取首次入口
      activateEnterMs = at;
      activationEvent = activate[3] ? stripQuotes(activate[3].trim()) : null;
    }
  }

  if (hostStartMs.length === 0 || activateEnterMs === null) { return null; }
  const start = hostStartMs[0];
  const enter = activateEnterMs;
  const trailingStartupActivations = activations.filter(
    record => record.id !== extensionId
      && record.isStartup
      && record.at > enter
      && (eagerActivatedMs === null || record.at < eagerActivatedMs)
  ).length;
  return {
    extensionId,
    activationEvent,
    segments: {
      hostStartMs: start,
      activateEnterMs: enter,
      eagerActivatedMs: eagerActivatedMs,
      hostExitMs: hostExitMs.length > 0 ? hostExitMs[0] : null
    },
    derived: {
      hostStartToActivateMs: enter - start,
      activateToEagerMs: eagerActivatedMs === null ? null : eagerActivatedMs - enter,
      hostStartToEagerMs: eagerActivatedMs === null ? null : eagerActivatedMs - start,
      trailingStartupActivations
    }
  };
}
