/**
 * 机器人(bots 进程)控制编排(IDE-BOT-001,A 案:本地单机闭环)。
 *
 * 引擎事实(调研 2026-11-06,~/workspaces/kbengine@f85ad81):
 * - bots = kbe/src/server/tools/bots 独立进程,模拟客户端批量登录压测;
 *   scripts/bots Python 驱动(kbemain 入口+客户端侧 Entity)。
 * - 加人只有 KBEngine.addBots(total[, tickCount, tickTime]);查询只有
 *   KBEngine.bots 只读字典(len/get/entities);**无逐个销毁 API**
 *   (PyBots 只读;bot 减员 = 停止 bots 进程,如实告知,不假装支持)。
 * - bots 进程自带 telnet_service(默认 51000,python 命令层),运行时操控
 *   不需重启进程;kode telnet 目标表已含 bots 组件。
 *
 * 本文件只做编排(UI/进程/会话全经 deps 注入,无 vscode import):
 * - 白名单闸不绕:addBots 是写操作(批量登录),命令必须已在
 *   kbengine.telnet.enableCommands 白名单内,缺项如实报出该加哪条;
 * - 会话就绪等待有界(connect 后轮询 ready,超时如实报);
 * - 结果读取诚实:len 查询发送后读输出尾行,读不到就说读不到。
 */

import { BUILTIN_QUICK_COMMANDS, isCommandAllowed } from './backend/telnetClient';
import { l10nText } from './nlsRuntime';

export const BOTS_COUNT_COMMAND = 'len(KBEngine.bots)';
/** 白名单建议项(错误信息里亮给用户,与引擎 python 层命令同串) */
export const BOTS_ADD_WHITELIST_ENTRY = 'KBEngine.addBots';

export interface BotsTelnetTarget {
  key: string;
  component: string;
  host: string;
  port: number;
  enableCommands: readonly string[];
}

/** addBots 命令串(镜像引擎文档示例形态:一次性=单参,分批=三参)。 */
export function buildAddBotsCommand(total: number, tickCount?: number, tickTime?: number): string {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(l10nText('total must be an integer ≥1, got {value}', { value: total }));
  }
  if (tickCount === undefined && tickTime === undefined) {
    return `KBEngine.addBots(${total})`;
  }
  const count = tickCount ?? 0;
  const interval = tickTime ?? 0;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(l10nText('tickCount must be an integer ≥1, got {value}', { value: tickCount ?? 'undefined' }));
  }
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error(l10nText('tickTime must be a number ≥0, got {value}', { value: tickTime ?? 'undefined' }));
  }
  return `KBEngine.addBots(${total}, ${count}, ${interval})`;
}

/** 解析输入框文本:空串/纯空白=undefined;整数文本=number;否则 null(非法)。 */
export function parseOptionalInt(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (/^[+-]?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return null;
}

export interface BotsControlDeps {
  /** bots telnet 目标(派生链已含 bots 组件;null=telnet 未配置)。 */
  getBotsTarget(): BotsTelnetTarget | null;
  /** 建立会话(幂等);会话状态轮询经 getSessionState。 */
  connectTarget(key: string): void;
  getSessionState(key: string): string | null;
  sendCommand(key: string, command: string): boolean;
  getOutput(key: string): string[];
  /** 睡眠毫秒(测试替身可缩短)。 */
  sleep(ms: number): Promise<void>;
  withInput(prompt: string, placeholder: string, validate: (text: string) => string | null): Thenable<string | undefined>;
  showInformationMessage(message: string): Thenable<unknown>;
  showErrorMessage(message: string): Thenable<unknown>;
  channel: { appendLine(line: string): void; show(preserveFocus?: boolean): void };
}

/**
 * 白名单允许判定:直接复用服务层 isCommandAllowed(精确 / `项+空格` /
 * `项+(` 前缀),白名单并上内置只读快捷命令——与 TelnetService.isAllowed
 * 同一语义同一实现,编排层不另立口径(双重闸:此处预检 + 服务层 sendCommand
 * 再检)。
 */
export function commandAllowed(command: string, whitelist: readonly string[]): boolean {
  return isCommandAllowed(command, [
    ...whitelist,
    ...BUILTIN_QUICK_COMMANDS.map(entry => entry.command)
  ]);
}

/** 会话就绪等待:100ms×50 次 ≈ 5 秒上限(有界尝试数,测试替身可瞬时跑完)。 */
const CONNECT_ATTEMPTS = 50;
const CONNECT_POLL_MS = 100;
/** bot 数结果读取:150ms×14 次 ≈ 2 秒上限。 */
const COUNT_ATTEMPTS = 14;
const COUNT_POLL_MS = 150;

/** 连接并等到会话 ready;无会话才 connect(connectTarget 会先断旧,握手在途
 * 时重复调用会反复重启握手);超时返回 false(如实,不重试不止损)。 */
async function ensureSessionReady(deps: BotsControlDeps, key: string): Promise<boolean> {
  let state = deps.getSessionState(key);
  if (state !== 'ready') {
    if (state === null) {
      deps.connectTarget(key);
    }
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
      await deps.sleep(CONNECT_POLL_MS);
      state = deps.getSessionState(key);
      if (state === 'ready') {
        return true;
      }
    }
    return false;
  }
  return true;
}

function noTargetMessage(): string {
  return l10nText(
    'No telnet target found for bots: kbengine.xml must enable the <telnet_service> section (without an explicit port the component default port table derives it; bots defaults to 51000); with a single explicit port only the custom target exists and the bots component is not included.'
  );
}

/**
 * `kbengine.bots.add`:问数量(可选分批)→ 经 bots 进程 telnet python 层发
 * addBots。白名单缺项/会话未就绪都如实报;成功后附带 bot 数查询(若白名单
 * 允许)并把结果落输出通道。返回结果摘要行(供测试断言)。
 */
export async function runBotsAddCommand(deps: BotsControlDeps): Promise<string> {
  const target = deps.getBotsTarget();
  if (!target) {
    await deps.showErrorMessage(noTargetMessage());
    return l10nText('No bots telnet target found; nothing executed.');
  }

  const totalText = await deps.withInput(
    l10nText('Total bots (≥1)'),
    l10nText('e.g. 100'),
    text => (/^[+-]?\d+$/.test(text.trim()) && Number(text.trim()) >= 1 ? null : l10nText('must be an integer ≥1'))
  );
  if (totalText === undefined) {
    return l10nText('Cancelled; nothing executed.');
  }
  const total = Number(totalText.trim());

  const tickText = await deps.withInput(
    l10nText('Per-batch count (empty = all at once)'),
    l10nText('e.g. 5'),
    text => {
      const parsed = parseOptionalInt(text);
      if (parsed === null) {
        return l10nText('empty or an integer ≥1');
      }
      return parsed === undefined || parsed >= 1 ? null : l10nText('must be an integer ≥1');
    }
  );
  if (tickText === undefined) {
    return l10nText('Cancelled; nothing executed.');
  }
  // 校验闭包已拒非法文本(shift 出来的只会是空或整数),此处 ?? undefined 只做
  // null→undefined 的类型归一
  const tickCount = parseOptionalInt(tickText) ?? undefined;

  let tickTime: number | undefined;
  if (tickCount !== undefined) {
    const intervalText = await deps.withInput(
      l10nText('Seconds between batches (≥0)'),
      l10nText('e.g. 10'),
      text => {
        const parsed = parseOptionalInt(text);
        if (parsed === null) {
          return l10nText('empty means 0; or an integer ≥0');
        }
        return parsed === undefined || parsed >= 0 ? null : l10nText('must be an integer ≥0');
      }
    );
    if (intervalText === undefined) {
      return l10nText('Cancelled; nothing executed.');
    }
    tickTime = parseOptionalInt(intervalText) ?? 0;
  }

  const command = buildAddBotsCommand(total, tickCount, tickTime);
  if (!commandAllowed(command, target.enableCommands)) {
    const hint = l10nText(
      'Command is not in the telnet whitelist: add "{entry}" to the kbengine.telnet.enableCommands setting (Command Palette → Preferences: Open Settings, search enableCommands).',
      { entry: BOTS_ADD_WHITELIST_ENTRY }
    );
    await deps.showErrorMessage(hint);
    return l10nText('Whitelist is missing "{entry}"; nothing executed.', { entry: BOTS_ADD_WHITELIST_ENTRY });
  }

  if (!(await ensureSessionReady(deps, target.key))) {
    await deps.showErrorMessage(
      l10nText(
        'bots telnet session is not ready ({host}:{port}): confirm the bots process is running and telnet_service is enabled (default port 51000).',
        { host: target.host, port: target.port }
      )
    );
    return l10nText('Telnet session not ready; nothing executed.');
  }

  if (!deps.sendCommand(target.key, command)) {
    await deps.showErrorMessage(l10nText('addBots command failed to send (the session dropped while sending).'));
    return l10nText('Send failed.');
  }
  deps.channel.appendLine(l10nText('[bots] Sent {command} (target {host}:{port}).', { command, host: target.host, port: target.port }));
  deps.channel.appendLine(l10nText('[bots] The engine has no per-bot removal API: reducing bots means stopping the bots process.'));

  if (commandAllowed(BOTS_COUNT_COMMAND, target.enableCommands)) {
    await queryBotsCount(deps, target);
    return l10nText('Sent {command}; current bot count queried (see the output channel).', { command });
  }
  deps.channel.show(true);
  return l10nText('Sent {command}; querying the bot count requires "{countCmd}" in the whitelist (optional).', { command, countCmd: BOTS_COUNT_COMMAND });
}

async function queryBotsCount(deps: BotsControlDeps, target: BotsTelnetTarget): Promise<string | null> {
  const before = deps.getOutput(target.key).length;
  if (!deps.sendCommand(target.key, BOTS_COUNT_COMMAND)) {
    deps.channel.appendLine(l10nText('[bots] {countCmd} failed to send.', { countCmd: BOTS_COUNT_COMMAND }));
    return null;
  }
  let lines: string[] = [];
  for (let attempt = 0; attempt < COUNT_ATTEMPTS; attempt++) {
    await deps.sleep(COUNT_POLL_MS);
    const all = deps.getOutput(target.key);
    if (all.length > before) {
      lines = all.slice(before).map(line => line.trim()).filter(line => line.length > 0);
      if (lines.length > 0 && /^\d+$/.test(lines[lines.length - 1])) {
        break;
      }
    }
  }
  if (lines.length === 0) {
    deps.channel.appendLine(l10nText('[bots] No bot-count result line read (no new output within 2s); raw output above.'));
    deps.channel.show(true);
    return null;
  }
  const last = lines[lines.length - 1];
  deps.channel.appendLine(l10nText('[bots] current bot count (len(KBEngine.bots))={count}', { count: last }));
  deps.channel.show(true);
  return last;
}

/**
 * `kbengine.bots.count`:查询当前 bot 数(len(KBEngine.bots)),读输出尾行,
 * 读不到如实说。返回读到的数字串或 null(供测试断言)。
 */
export async function runBotsCountCommand(deps: BotsControlDeps): Promise<string | null> {
  const target = deps.getBotsTarget();
  if (!target) {
    await deps.showErrorMessage(noTargetMessage());
    return null;
  }
  if (!commandAllowed(BOTS_COUNT_COMMAND, target.enableCommands)) {
    await deps.showErrorMessage(
      `命令未在 telnet 白名单内:请在设置 kbengine.telnet.enableCommands 加入 "${BOTS_COUNT_COMMAND}"。`
    );
    return null;
  }
  if (!(await ensureSessionReady(deps, target.key))) {
    await deps.showErrorMessage(
      l10nText(
        'bots telnet session is not ready ({host}:{port}): confirm the bots process is running and telnet_service is enabled (default port 51000).',
        { host: target.host, port: target.port }
      )
    );
    return null;
  }
  return queryBotsCount(deps, target);
}
