// SRC-001 L9:console 层(KODE-ARCH-002 纯移动)。区域含 KB-GC-001
// guiconsole 期一三面:machined 发现共享链 hub、日志实时 tail(702 注册 →
// 65501 长连推流进 Output)、组件状态面板(负载/存活,异常红色);两面共用
// 一个 hub 不建两套链。装配顺序由组合根调用点保持;注册面直推
// context.subscriptions(销毁所有权不变);区域仅依赖 context 与模块导入,
// 无共享句柄消费也无后向消费者。

import * as vscode from 'vscode';
import { resolveExceptionSource } from '../backend/exceptionSourceLocator';
import { ConsoleHub } from '../kbengineConsoleHub';
import { ConsoleLogTailController } from '../backend/consoleLogTail';
import { ComponentStatusTreeProvider, resolveThresholds } from '../componentStatusPanel';

export interface ConsoleDeps {
  context: vscode.ExtensionContext;
}

export function activateConsole(deps: ConsoleDeps): void {
  const { context } = deps;
  // KB-GC-001 guiconsole 期一:machined 发现共享链(hub)+ 日志实时 tail(702
  // 注册 → 65501 长连推流进 Output)+ 组件状态面板(负载/存活,异常红色)。
  // 两个面共用一个 hub,不建两套链(design docs/design/
  // kbengine-guiconsole-integration.md §4;协议解码陷阱见同文档 §1.4)。
  const consoleConfig = vscode.workspace.getConfiguration('kbengine');
  const consoleRefreshSeconds = Math.max(1, consoleConfig.get<number>('componentStatusPanel.refreshSeconds', 5));
  const consoleHub = new ConsoleHub({
    pollIntervalMs: consoleRefreshSeconds * 1000,
    // 默认 127.0.0.1(链路 localhost-only,设计文档 §5);跨机须显式配置
    // kbengine.console.discoveryHost(见配置说明安全边界)
    discovery: { host: consoleConfig.get<string>('console.discoveryHost', '127.0.0.1') }
  });
  consoleHub.start();
  context.subscriptions.push(consoleHub);

  const tailOutput = vscode.window.createOutputChannel('KBEngine Console 日志');
  // 优先级 95:低于 server 100/telnet 99/热更 98/解释器 97/热更通道灯 96
  // (HOT_RELOAD_CHANNEL_STATUS_PRIORITY),不与任何既有灯同优先级。
  const tailStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
  const tailController = new ConsoleLogTailController({
    hub: consoleHub,
    workspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
    // IDE-LIV-007 同源:错误行 traceback → 工作区真实文件落点
    resolveSource: (roots, location) => resolveExceptionSource(roots, location),
    output: tailOutput,
    statusItem: tailStatusItem,
    // 配置访问器:每次重读,组件过滤/开关「下次重连生效」而非激活期快照
    getConfig: () => ({
      // 默认开:配置缺失也开,显式 false 才关(用户令,热更/门控同类口径)
      enabled: consoleConfig.get<boolean>('consoleLogTail.enabled', true),
      components: consoleConfig.get<string[]>('consoleLogTail.components', [])
    })
  });
  if (consoleConfig.get<boolean>('consoleLogTail.enabled', true)) {
    tailController.start();
  }
  context.subscriptions.push(tailController, tailOutput, tailStatusItem);
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.consoleLogTail.show', () => tailOutput.show()));
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.consoleLogTail.toggle', () => tailController.toggle()));
  // 开关即时生效:显式 true→start / false→stop(组件过滤即时生效靠注册帧重建,
  // 简化口径:改过滤数组后用 toggle 重连)
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('kbengine.consoleLogTail.enabled')) {
      return;
    }
    const enabled = consoleConfig.get<boolean>('consoleLogTail.enabled', true);
    if (enabled && tailController.getState() === 'disabled') {
      // 显式用户意图开启:force=true 越过激活期快照(off→on 时 deps.config.enabled
      // 仍是激活时的旧值,start() 会误把用户开启当缺省关闭而停在 disabled)
      tailController.start(true);
    } else if (!enabled && tailController.getState() !== 'disabled') {
      tailController.stop();
    }
  }));

  const componentStatusProvider = new ComponentStatusTreeProvider(consoleHub, () => resolveThresholds(key => {
    if (key === 'cpu') {
      return consoleConfig.get<number>('componentStatusPanel.cpuThresholdPercent', 90);
    }
    return consoleConfig.get<number>('componentStatusPanel.memThresholdMb', 1024);
  }));
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kbengine.componentStatus', componentStatusProvider)
  );
  const stopPanelAutoRefresh = componentStatusProvider.startAutoRefresh(
    (intervalMs, fire) => {
      const timer = setInterval(fire, intervalMs);
      return () => clearInterval(timer);
    },
    consoleRefreshSeconds * 1000
  );
  context.subscriptions.push({ dispose: stopPanelAutoRefresh });
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.consoleComponentPanel.refresh', () => {
    void componentStatusProvider.refresh();
  }));
}
