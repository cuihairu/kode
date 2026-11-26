/**
 * Orchestration for bot (bots process) control (IDE-BOT-001, case A: local
 * single-machine closed loop).
 *
 * Engine facts (researched 2026-11-06, ~/workspaces/kbengine@f85ad81):
 * - bots = kbe/src/server/tools/bots, a separate process that simulates a batch
 *   of client logins for load testing; scripts/bots is the Python driver
 *   (kbemain entry point + client-side Entities).
 * - Adding bots only has KBEngine.addBots(total[, tickCount, tickTime]);
 *   querying only has the read-only KBEngine.bots dictionary
 *   (len/get/entities); there is **no per-bot destruction API** (PyBots is
 *   read-only; reducing bots = stopping the bots process — say so honestly,
 *   do not pretend to support it).
 * - The bots process ships its own telnet_service (default 51000, the python
 *   command layer), so runtime control needs no process restart; the kode
 *   telnet target table already includes the bots component.
 *
 * This file only orchestrates (UI/process/session all injected via deps, no
 * vscode import):
 * - the whitelist gate is not bypassable: addBots is a write operation (batch
 *   login), the command must already be in the kbengine.telnet.enableCommands
 *   whitelist, and a missing entry is reported honestly with the entry to add;
 * - the wait for session readiness is bounded (poll for ready after connect,
 *   and report a timeout honestly);
 * - result reading is honest: after sending the len query, read the tail lines
 *   of the output; if nothing can be read, say nothing was read.
 */

import { BUILTIN_QUICK_COMMANDS, isCommandAllowed } from './telnetClient';
import { l10nText } from '../nlsRuntime';

export const BOTS_COUNT_COMMAND = 'len(KBEngine.bots)';
/** Whitelist suggestion entry (surfaced to the user in error messages, the same string as the engine python-layer command) */
export const BOTS_ADD_WHITELIST_ENTRY = 'KBEngine.addBots';

export interface BotsTelnetTarget {
  key: string;
  component: string;
  host: string;
  port: number;
  enableCommands: readonly string[];
}

/** addBots command string (mirroring the engine docs' example shape: one-shot = single argument, batched = three arguments). */
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

/** Parses input-box text: empty string / pure whitespace = undefined; integer text = number; otherwise null (invalid). */
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
  /** bots telnet target (the derivation chain already includes the bots component; null = telnet not configured). */
  getBotsTarget(): BotsTelnetTarget | null;
  /** Establishes the session (idempotent); session-state polling goes through getSessionState. */
  connectTarget(key: string): void;
  getSessionState(key: string): string | null;
  sendCommand(key: string, command: string): boolean;
  getOutput(key: string): string[];
  /** Sleeps for milliseconds (a test stand-in can shorten it). */
  sleep(ms: number): Promise<void>;
  withInput(prompt: string, placeholder: string, validate: (text: string) => string | null): Thenable<string | undefined>;
  showInformationMessage(message: string): Thenable<unknown>;
  showErrorMessage(message: string): Thenable<unknown>;
  channel: { appendLine(line: string): void; show(preserveFocus?: boolean): void };
}

/**
 * Whitelist allowance decision: reuses the service layer's isCommandAllowed
 * directly (exact match / `entry+space` / `entry+(` prefixes) with the
 * whitelist unioned with the built-in read-only quick commands — the same
 * semantics and the same implementation as TelnetService.isAllowed, so the
 * orchestration layer does not set up its own contract (double gate: precheck
 * here + re-check by the service layer's sendCommand).
 */
export function commandAllowed(command: string, whitelist: readonly string[]): boolean {
  return isCommandAllowed(command, [
    ...whitelist,
    ...BUILTIN_QUICK_COMMANDS.map(entry => entry.command)
  ]);
}

/** Session-readiness wait: 100ms x 50 attempts ≈ 5 second upper bound (bounded attempt count; a test stand-in can finish instantly). */
const CONNECT_ATTEMPTS = 50;
const CONNECT_POLL_MS = 100;
/** Bot-count result reading: 150ms x 14 attempts ≈ 2 second upper bound. */
const COUNT_ATTEMPTS = 14;
const COUNT_POLL_MS = 150;

/** Connects and waits until the session is ready; only connects when there is no session (connectTarget tears the old one down first, so repeated
 * calls while a handshake is in flight would keep restarting the handshake); returns false on timeout (reported as-is, no retry and no cut-loss). */
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
 * `kbengine.bots.add`: asks for the count (optional batching) -> sends addBots
 * through the bots process's telnet python layer. A missing whitelist entry or
 * a session not ready is reported honestly; on success it also runs a bot-count
 * query (if the whitelist allows it) and writes the result to the output
 * channel. Returns a summary line of the result (for test assertions).
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
  // The validation closure already rejects invalid text (the only values left
  // after the shift are empty or an integer); the ?? undefined here just
  // normalizes null -> undefined for typing
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
 * `kbengine.bots.count`: queries the current bot count (len(KBEngine.bots)),
 * reading the tail lines of the output, and says honestly when nothing can be
 * read. Returns the number string read, or null (for test assertions).
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
