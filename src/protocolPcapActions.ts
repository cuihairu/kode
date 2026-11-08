//! PA-007 第三增量:一键开 PCAP(Wireshark GUI)与跑 TShark(kode-kbengine
//! capture analyze,tshark 零 ABI 面)(todo PA-007)。
//!
//! 与检测面(protocolTooling defaultRunBinary 5s 超时)的分工:GUI 打开不能
//! 套 5s 超时(超时会杀掉刚拉起的 GUI),抓包分析在大 pcap 上 5s 也不够——
//! 本模块自带 runner 工厂(open 面无超时、analyze 面长超时),检测面语义不动。
//!
//! 诚实边界:
//! - 对话框取消 = 什么都不做(不起进程不出通知);
//! - Wireshark GUI 未检出/启动失败如实警告(GUI 可见本身就是成功反馈,成功
//!   不刷通知);启动记录落「KBEngine Protocol Tooling」通道;
//! - CLI 未检出/探测失败/分析失败如实警告并归因(stderr→stdout→退出码),
//!   报告原文落通道——不摘要不美化,CLI 报什么用户看什么。

import { execFile } from 'child_process';
import * as vscode from 'vscode';
import {
  ensureProtocolChannel,
  readProtocolToolingConfig,
  resolveCliPath,
  type ProtocolToolingDeps,
  type RunBinary
} from './protocolTooling';

export const OPEN_PCAP_COMMAND = 'kbengine.protocol.openPcap';
export const ANALYZE_PCAP_COMMAND = 'kbengine.protocol.analyzePcap';
/** 抓包文件对话框过滤(pcap/pcapng/cap;Wireshark 读面三者通用)。 */
const PCAP_FILE_FILTER = { 'Packet capture': ['pcap', 'pcapng', 'cap'] };
/** 分析面长超时 ms(用户显式发起,大 pcap + tshark 两跳;检测面 5s 不适用)。 */
const ANALYZE_TIMEOUT_MS = 120_000;

/**
 * runner 工厂:与 defaultRunBinary 同收敛语义(退出码>ENOENT=-1>其它=1),
 * 超时可调;timeoutMs 缺省 = 不传 timeout(GUI 打开不能被超时杀)。
 */
export function createPcapRunBinary(timeoutMs?: number): RunBinary {
  return (file, args) =>
    new Promise((resolve) => {
      const options = timeoutMs === undefined ? {} : { timeout: timeoutMs };
      execFile(file, args, options, (error, stdout, stderr) => {
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
}

/** 文件选取(注入点;默认打开对话框,单选抓包文件)。 */
export type PickPcap = () => Thenable<readonly vscode.Uri[] | undefined>;

const defaultPickPcap: PickPcap = () =>
  vscode.window.showOpenDialog({
    title: '选择抓包文件(PCAP)',
    canSelectMany: false,
    filters: PCAP_FILE_FILTER
  });

/** 一键开 PCAP:对话框 → Wireshark GUI 拉起(无超时)。启动失败(未检出/
 * 非零)如实警告;GUI 正常打开不刷通知(可见即反馈),启动记录落通道。 */
export async function runOpenPcap(
  deps: ProtocolToolingDeps,
  pickFiles: PickPcap,
  run: RunBinary,
  log: (line: string) => void
): Promise<void> {
  const picked = await pickFiles();
  const file = picked?.[0]?.fsPath;
  if (!file) {
    return; // 取消:零动作,不起进程不出通知
  }
  log(`[pcap] launching ${deps.wiresharkPath} ${file}`);
  void run(deps.wiresharkPath, [file]).then((outcome) => {
    if (outcome.code !== 0) {
      const reason =
        outcome.code === -1
          ? `Wireshark 未检出(${deps.wiresharkPath};可用 kbengine.protocol.wiresharkPath 指向 GUI 可执行)`
          : `Wireshark 启动失败(code ${outcome.code}):${firstLine(outcome.stderr || outcome.stdout)}`;
      log(`[pcap] open failed: ${reason}`);
      void vscode.window.showWarningMessage(`KBEngine 协议 PCAP 未打开:${reason}`);
    }
  });
}

/** 跑 TShark(CLI 同源):对话框 → kode-kbengine capture analyze(--tshark
 * 用配置面路径)→ 报告原文落通道。CLI 未检出/失败如实警告并归因。 */
export async function runAnalyzePcap(
  deps: ProtocolToolingDeps,
  pickFiles: PickPcap,
  run: RunBinary,
  log: (line: string) => void
): Promise<void> {
  const picked = await pickFiles();
  const file = picked?.[0]?.fsPath;
  if (!file) {
    return; // 取消:零动作,不起进程不出通知
  }
  const cli = await resolveCliPath(deps);
  if (cli.path === '') {
    const reason = 'kode-kbengine CLI 未检出(未配置且 target/{debug,release} 自动发现落空)';
    log(`[pcap] analyze unavailable: ${reason}`);
    void vscode.window.showWarningMessage(`KBEngine 协议分析未执行:${reason}`);
    return;
  }
  if (cli.outcome.code !== 0) {
    const reason = `kode-kbengine CLI 探测失败(code ${cli.outcome.code}):${firstLine(cli.outcome.stderr ?? cli.outcome.stdout)}`;
    log(`[pcap] analyze unavailable: ${reason}`);
    void vscode.window.showWarningMessage(`KBEngine 协议分析未执行:${reason}`);
    return;
  }
  log(`[pcap] analyzing ${file} via ${cli.path} (tshark: ${deps.tsharkPath})`);
  const outcome = await run(cli.path, [
    'capture',
    'analyze',
    '--pcap',
    file,
    '--tshark',
    deps.tsharkPath
  ]);
  if (outcome.stdout.trim() !== '') {
    log(outcome.stdout.trimEnd());
  }
  if (outcome.code === 0) {
    log(`[pcap] analyze ok: ${file}`);
    return;
  }
  const reason =
    outcome.code === -1
      ? `kode-kbengine CLI 未检出(${cli.path} 不可执行)`
      : `分析失败(code ${outcome.code}):${firstLine(outcome.stderr || outcome.stdout) || '无输出'}`;
  log(`[pcap] analyze failed: ${reason}`);
  void vscode.window.showErrorMessage(`KBEngine 协议分析失败:${reason}`);
}

/** 装配入口:两条命令入 context.subscriptions;通道懒取(命令触发面才建,
 * 激活零开销面与 showStatus 同款)。run 二进制由工厂给(open 无超时/analyze
 * 长超时),测试注入 pickFiles 驱动对话框面。 */
export function setupProtocolPcapActions(
  context: vscode.ExtensionContext,
  opts: { pickFiles?: PickPcap; analyzeTimeoutMs?: number } = {}
): void {
  const channel = (): vscode.OutputChannel => ensureProtocolChannel(context);
  const deps = (): ProtocolToolingDeps => readProtocolToolingConfig(context.extensionUri.fsPath);
  const pickFiles = opts.pickFiles ?? defaultPickPcap;
  const log = (line: string): void => channel().appendLine(line);

  const open = vscode.commands.registerCommand(OPEN_PCAP_COMMAND, async () => {
    await runOpenPcap(deps(), pickFiles, createPcapRunBinary(), log);
  });
  const analyze = vscode.commands.registerCommand(ANALYZE_PCAP_COMMAND, async () => {
    await runAnalyzePcap(
      deps(),
      pickFiles,
      createPcapRunBinary(opts.analyzeTimeoutMs ?? ANALYZE_TIMEOUT_MS),
      log
    );
  });
  context.subscriptions.push(open, analyze);
}

// ---------------------------------------------------------------- text utils

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}
