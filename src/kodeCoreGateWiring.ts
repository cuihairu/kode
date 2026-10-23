import * as vscode from 'vscode';

import { KodeCoreGate, type KodeCoreGateConfig, ShadowDiffEntry } from './kodeCoreGate';

// kode2 PR-012:双轨切流门的扩展装配(设置项默认关,装配零行为差异)。
// 职责:读 kbengine.core.* 配置 → 门状态同步;shadow 时建输出通道接差异
// 日志;kill-switch(ts/非法值)即停 Rust 进程并撤通道;注册差异日志查看
// 命令。任何模式下都不改 provider 服务路径 —— Rust 结果只进日志。

export const CORE_SHADOW_CHANNEL_NAME = 'KBEngine Core Shadow';
export const SHOW_SHADOW_DIFF_LOG_COMMAND = 'kbengine.core.showShadowDiffLog';

function formatDiffEntry(entry: ShadowDiffEntry): string {
  const parts = [`#${entry.seq}`, entry.timestamp, entry.verdict, entry.method];
  if (entry.uri) {
    parts.push(entry.uri);
  }
  if (entry.detail) {
    parts.push(entry.detail);
  }
  return parts.join(' | ');
}

/** 读 kbengine.core.* 当前配置(每次现读,不做缓存失效) */
export function readCoreGateConfig(): KodeCoreGateConfig {
  const config = vscode.workspace.getConfiguration('kbengine');
  return {
    backend: config.get<string>('core.backend', 'ts'),
    serverPath: config.get<string>('core.serverPath', ''),
    shadowTimeoutMs: config.get<number>('core.shadow.timeoutMs', 2000),
  };
}

export function setupKodeCoreGate(context: vscode.ExtensionContext): KodeCoreGate {
  const gate = new KodeCoreGate();
  gate.setConfig(readCoreGateConfig());

  // 输出通道只在 shadow 模式存在(默认 ts 下用户不可见任何新面板)
  let channel: vscode.OutputChannel | null = null;
  const syncChannel = (): void => {
    if (gate.servingMode === 'shadow') {
      if (!channel) {
        channel = vscode.window.createOutputChannel(CORE_SHADOW_CHANNEL_NAME);
        context.subscriptions.push(channel);
      }
      return;
    }
    channel?.dispose();
    channel = null;
  };
  syncChannel();

  const unsubscribe = gate.diffLog.subscribe(entry => {
    channel?.appendLine(formatDiffEntry(entry));
  });

  const showDiffLogCommand = vscode.commands.registerCommand(SHOW_SHADOW_DIFF_LOG_COMMAND, () => {
    if (channel) {
      channel.show(true);
      return;
    }
    const summary = gate.diffLog.summary();
    void vscode.window.showInformationMessage(
      summary.total > 0
        ? `KBEngine Core 差异日志:${summary.total} 条(一致 ${summary.match}/差异 ${summary.diff}/失败 ${summary.failure});当前 backend=${gate.mode},输出通道未开启`
        : `双轨影子比对未启用(kbengine.core.backend=${gate.mode});差异日志为空`
    );
  });

  const configWatcher = vscode.workspace.onDidChangeConfiguration(event => {
    if (
      event.affectsConfiguration('kbengine.core.backend') ||
      event.affectsConfiguration('kbengine.core.serverPath') ||
      event.affectsConfiguration('kbengine.core.shadow')
    ) {
      gate.setConfig(readCoreGateConfig());
      syncChannel();
    }
  });

  context.subscriptions.push(
    gate,
    configWatcher,
    showDiffLogCommand,
    unsubscribe
  );
  return gate;
}
