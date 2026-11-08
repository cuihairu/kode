//! PA-007(todo.md Phase 5)第一增量:协议工具链检测与状态报告。
//!
//! 职责:探测 Wireshark/TShark 宿主、KBEngine Wireshark 插件(PA-006
//! 交付面)与 kode-kbengine CLI(PA-004 交付面)的安装/版本状态,渲染
//! 纯文本报告。采集层(run)与 CLI 发现(findCli)全部注入,本模块可在
//! 无 vscode 环境单测;解析规则在 protocolToolingDetect.ts。
//! 检测面宁报未检出,不猜不抛(spawn 失败=未检出)。

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { discoverNativeBinary } from './nativeBinary';
import { discoverNativeBinary } from './nativeBinary';

import {
  findKbengineDissector,
  parseCliVersion,
  parseTsharkFolders,
  parseTsharkPlugins,
  parseTsharkVersion,
  parseWiresharkVersion,
  pluginFolderMatchesHost,
  type TsharkPluginEntry,
} from './protocolToolingDetect';

export const PROTOCOL_CHANNEL_NAME = 'KBEngine Protocol Tooling';
export const SHOW_PROTOCOL_STATUS_COMMAND = 'kbengine.protocol.showStatus';

/** 一次二进制调用的结果;任何失败(ENOENT/超时/非零退出)都收敛为可渲染值。 */
export interface RunOutcome {
  code: number;
  stdout: string;
  /** stderr 原文(错误面归因用;老消费方不读,可缺省)。 */
  stderr?: string;
}

export type RunBinary = (file: string, args: string[]) => Promise<RunOutcome>;

/**
 * 默认 spawn:5s 超时(检测不卡 UI);错误(未安装/超时)按空输出收敛,
 * 非零退出仍取 stdout(tshark 各子命令退出码口径不一,解析面自负)。
 * 收敛码:进程退出码(number)> ENOENT=-1(未安装)> 其它(超时等)=1。
 */
export const defaultRunBinary: RunBinary = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        const err = error as NodeJS.ErrnoException;
        const code =
          typeof err.code === 'number' ? err.code : err.code === 'ENOENT' ? -1 : 1;
        resolve({
          code,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : ''
        });
        return;
      }
      resolve({
        code: 0,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : ''
      });
    });
  });

/**
 * 自动发现 kode-kbengine CLI(与 kodeCoreGateWiring.discoverKodeServerBinary
 * 同形状:随包 bin 优先,源码 target/debug、target/release 兜底)。
 */
export function discoverKodeCliBinary(
  extensionRoot: string,
  binaryName: string
): string {
  return discoverNativeBinary(extensionRoot, binaryName);
}

/** PA-007 第一增量的采集输入(run 注入 → 测试全驱动)。 */
export interface ProtocolToolingDeps {
  run: RunBinary;
  /** tshark 可执行名/路径(配置 kbengine.protocol.tsharkPath,默认 'tshark')。 */
  tsharkPath: string;
  /** wireshark GUI 名/路径(配置 kbengine.protocol.wiresharkPath,默认 'wireshark')。 */
  wiresharkPath: string;
  /** kode-kbengine CLI 路径(''=按 extensionRoot 自动发现)。 */
  cliPath: string;
  extensionRoot: string;
}

export interface ProtocolToolingStatus {
  tsharkPath: string;
  tsharkVersion: string | null;
  wiresharkPath: string;
  /** null = GUI 未检出(如实,不猜)。 */
  wiresharkVersion: string | null;
  personalPlugins: string | null;
  globalPlugins: string | null;
  /** KBEngine dissector 插件(未装 null)。 */
  plugin: TsharkPluginEntry | null;
  /** 插件落盘版本线 vs 宿主版本线;true/false/null(未知)三态。 */
  pluginHostMatch: boolean | null;
  /** '' = CLI 未发现(自动发现落空且未配置)。 */
  cliPath: string;
  cliVersion: string | null;
}

/** 三方探测并装配状态;单方失败不影响他方(各探测独立收敛)。 */
export async function collectProtocolToolingStatus(
  deps: ProtocolToolingDeps
): Promise<ProtocolToolingStatus> {
  const tshark = await deps.run(deps.tsharkPath, ['-v']);
  const tsharkVersion = parseTsharkVersion(tshark.stdout.split('\n')[0] ?? '');

  const [foldersOut, pluginsOut, gui, cli] = await Promise.all([
    deps.run(deps.tsharkPath, ['-G', 'folders']),
    deps.run(deps.tsharkPath, ['-G', 'plugins']),
    deps.run(deps.wiresharkPath, ['-v']),
    resolveCliPath(deps),
  ]);

  const folders = parseTsharkFolders(foldersOut.stdout);
  const plugin = findKbengineDissector(parseTsharkPlugins(pluginsOut.stdout));
  const cliVersion = cli.path !== '' ? parseCliVersion(cli.outcome.stdout) : null;

  return {
    tsharkPath: deps.tsharkPath,
    tsharkVersion,
    wiresharkPath: deps.wiresharkPath,
    wiresharkVersion: parseWiresharkVersion(gui.stdout.split('\n')[0] ?? ''),
    personalPlugins: folders.personalPlugins,
    globalPlugins: folders.globalPlugins,
    plugin,
    pluginHostMatch:
      plugin !== null && tsharkVersion !== null
        ? pluginFolderMatchesHost(plugin.path, tsharkVersion)
        : null,
    cliPath: cli.path,
    cliVersion,
  };
}

/** CLI 路径解析(配置优先,空走 target/{debug,release} 自动发现)+ `--version`
 * 探测;PA-007 schema 建图面复用。 */
export async function resolveCliPath(
  deps: ProtocolToolingDeps
): Promise<{ path: string; outcome: RunOutcome }> {
  const configured = deps.cliPath;
  if (configured !== '') {
    return { path: configured, outcome: await deps.run(configured, ['--version']) };
  }
  const discovered = discoverKodeCliBinary(deps.extensionRoot, 'kode-kbengine');
  if (discovered === '') {
    return { path: '', outcome: { code: -1, stdout: '' } };
  }
  return { path: discovered, outcome: await deps.run(discovered, ['--version']) };
}

/** 纯文本报告(中文,与仓库命令文案同风格;逐行可单测断言)。 */
export function renderProtocolToolingStatus(status: ProtocolToolingStatus): string {
  const lines: string[] = [];
  lines.push('KBEngine 协议工具链检测(PA-007)');
  lines.push(
    `tshark: ${status.tsharkVersion ?? '未检出'} — ${status.tsharkPath}`
  );
  lines.push(
    status.wiresharkVersion === null
      ? `Wireshark GUI: 未检出(${status.wiresharkPath})`
      : `Wireshark GUI: ${status.wiresharkVersion} — ${status.wiresharkPath}`
  );
  lines.push(
    `插件目录(个人): ${status.personalPlugins ?? '未检出'}`,
    `插件目录(全局): ${status.globalPlugins ?? '未检出'}`
  );
  if (status.plugin === null) {
    lines.push('KBEngine Wireshark 插件: 未安装');
  } else {
    lines.push(
      `KBEngine Wireshark 插件: ${status.plugin.name} ${status.plugin.version} — ${status.plugin.path}`
    );
    if (status.tsharkVersion === null) {
      lines.push('宿主版本线核对: 跳过(tshark 版本未检出)');
    } else {
      lines.push(`宿主版本线核对: ${describeHostMatch(status.pluginHostMatch)}`);
    }
  }
  lines.push(
    status.cliPath === ''
      ? 'kode-kbengine CLI: 未发现(target/{debug,release} 自动发现落空且未配置 kbengine.protocol.cliPath)'
      : `kode-kbengine CLI: ${status.cliVersion ?? '版本未知'} — ${status.cliPath}`
  );
  lines.push(
    '兜底:插件未装/版本不匹配时,`kode-kbengine capture analyze` 可直接分析 pcap(零 ABI 耦合,PA-004)。'
  );
  return lines.join('\n');
}

function describeHostMatch(match: boolean | null): string {
  if (match === true) {
    return '匹配(插件落盘目录版本线 = 宿主版本线)';
  }
  if (match === false) {
    return '不匹配(插件与宿主 Wireshark 版本线不同,宿主不会加载)';
  }
  return '未知(插件路径无 plugins/<maj.min> 形态,无法核对)';
}

/** 读 kbengine.protocol.* 当前配置(每次现读,与 core 门同口径)。 */
export function readProtocolToolingConfig(extensionRoot: string): ProtocolToolingDeps {
  const config = vscode.workspace.getConfiguration('kbengine');
  return {
    run: defaultRunBinary,
    tsharkPath: config.get<string>('protocol.tsharkPath', 'tshark'),
    wiresharkPath: config.get<string>('protocol.wiresharkPath', 'wireshark'),
    cliPath: config.get<string>('protocol.cliPath', ''),
    extensionRoot,
  };
}

const protocolChannels = new WeakMap<vscode.ExtensionContext, vscode.OutputChannel>();

/** 协议面共享输出通道(showStatus 与 PA-007 schema 建图面同通道;按 context
 * 键控,同一扩展实例只建一次;通道惰性建,激活零开销)。 */
export function ensureProtocolChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  let channel = protocolChannels.get(context);
  if (!channel) {
    channel = vscode.window.createOutputChannel(PROTOCOL_CHANNEL_NAME);
    context.subscriptions.push(channel);
    protocolChannels.set(context, channel);
  }
  return channel;
}

/**
 * 命令接线:kbengine.protocol.showStatus → 采集 → 输出通道展示。
 * 通道惰性建(命令触发面,激活零开销);全部句柄进 context.subscriptions。
 */
export function setupProtocolTooling(context: vscode.ExtensionContext): void {
  const ensureChannel = (): vscode.OutputChannel => ensureProtocolChannel(context);
  const command = vscode.commands.registerCommand(
    SHOW_PROTOCOL_STATUS_COMMAND,
    () => {
      // 返回 promise:调用方(vscode/fake)可 await 到渲染完成。
      return collectProtocolToolingStatus(
        readProtocolToolingConfig(context.extensionUri.fsPath)
      ).then((status) => {
        const output = ensureChannel();
        output.clear();
        output.appendLine(renderProtocolToolingStatus(status));
        output.show(true);
      });
    }
  );
  context.subscriptions.push(command);
}
