// KODE-ARCH-002:extension.ts 装配模块——日志收集器/查看器/LogHub 与语言服务面板装配。
// 纯移动:逐行迁出 activate,订阅 push 顺序在装配函数内保持原样。
import * as vscode from 'vscode';
import { l10nText } from './nlsRuntime';
import { KBEngineServerManager } from './serverManager';
import { KBEngineLogCollector, LogCollectorConfig } from './logCollector';
import { LogViewerWebView } from './logWebView';
import { setHoverBudgetLogHub } from './hoverBudget';
import {
  getActiveOperationCounts,
  getLanguageServiceSummaryReport,
  renderActiveTasksReport,
  setDetailedRecordingEnabled,
  setLanguageServiceMetricsLogHub
} from './languageServiceMetrics';
import { renderLintRulesReport } from './lintRuleRegistry';
import { resolveServerComponent } from './serverCommandTarget';
import { getDiagnosticScheduler } from './diagnosticScheduler';
import { setFileReadVerbose } from './fileReadMetrics';
import { setCpuProfileDirectory, startCpuProfile, stopCpuProfile } from './cpuProfileCapture';
import {
  getEventLoopDelayReport,
  getHostVitalsReport,
  startEventLoopDelayMonitor,
  startHostVitalsMonitor,
  stopEventLoopDelayMonitor,
  stopHostVitalsMonitor
} from './hostVitals';

export interface LoggingWiring {
  logCollector: KBEngineLogCollector;
  logViewer: LogViewerWebView;
  logHub: KBEngineServerManager['logHub'];
}

export function wireLogging(context: vscode.ExtensionContext, serverManager: KBEngineServerManager): LoggingWiring {
  const showLogsCommand = vscode.commands.registerCommand(
    'kbengine.server.showLogs',
    (target) => {
      const component = resolveServerComponent(target);
      if (!component) {
        return;
      }

      logViewer.show();
    }
  );
  context.subscriptions.push(showLogsCommand);

  // 初始化日志收集器
  const kbengineConfig = vscode.workspace.getConfiguration('kbengine');
  const logAutoConnect = kbengineConfig.get<boolean>('logAutoConnect', true);
  const logConfig: LogCollectorConfig = {
    host: '127.0.0.1',
    port: kbengineConfig.get<number>('loggerPort', 20022),
    autoReconnect: true,
    reconnectInterval: 5000,
    maxBufferSize: kbengineConfig.get<number>('maxLogEntries', 10000)
  };

  const logCollector = new KBEngineLogCollector(logConfig, context);

  if (logAutoConnect) {
    void logCollector.connect().catch(() => {
      // logger 可能尚未启动，collector 内部会继续按配置重连
    });
  }

  // 初始化日志查看器
  const logViewer = new LogViewerWebView(context, logCollector);
  const logHub = serverManager.logHub;
  // 悬停/异步层预算闸的 LogHub 接线(2026-10-22):超时与耗时记账走同一
  // LogHub,真机在日志查看器过滤 [kode-hover] 即可定位慢层/超时层
  setHoverBudgetLogHub(logHub);

  // PR1:语言服务指标接线——LogHub 时间线(详细记录开启时逐样本 [kode-lsm]),
  // 详细开关默认关(kbengine.metrics.detailed);命令面板 kbengine.metrics.showSummary
  // 输出聚合汇总(P50/P95/P99/命中率/计数)。
  setLanguageServiceMetricsLogHub(logHub);
  setDetailedRecordingEnabled(kbengineConfig.get<boolean>('metrics.detailed', false));
  const metricsChannel = vscode.window.createOutputChannel('Kode Language Service Metrics');
  context.subscriptions.push(metricsChannel);
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.metrics.showSummary', () => {
    metricsChannel.clear();
    metricsChannel.append(getLanguageServiceSummaryReport());
    metricsChannel.append(getEventLoopDelayReport());
    metricsChannel.append(getHostVitalsReport());
    metricsChannel.show();
  }));
  // IDE-LINT-011:lint 规则能力清单——输出通道渲染规则表(单一事实源),
  // 开关启用态按当前 vscode 配置实读(与 Problems 一致)。
  const lintRulesChannel = vscode.window.createOutputChannel('Kode Lint Rules');
  context.subscriptions.push(lintRulesChannel);
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.lintRules.showReport', () => {
    lintRulesChannel.clear();
    lintRulesChannel.append(renderLintRulesReport(key => {
      return kbengineConfig.get<boolean>(key.slice('kbengine.'.length), false);
    }));
    lintRulesChannel.show();
  }));
  // IDE-MET-007:卡顿取证入口——start 开采/stop 落盘(.cpuprofile+.window.txt
  // 关联请求窗口);globalStorage 不可用时回落系统临时目录。
  if (context.globalStoragePath) {
    setCpuProfileDirectory(context.globalStoragePath);
  }
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.metrics.startCpuProfile', async () => {
    if (await startCpuProfile()) {
      vscode.window.showInformationMessage('Kode: CPU profile started');
    } else {
      vscode.window.showWarningMessage('Kode: CPU profile is already running');
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.metrics.stopCpuProfile', async () => {
    const result = await stopCpuProfile();
    if (result) {
      vscode.window.showInformationMessage(`Kode: CPU profile saved: ${result.profilePath}`);
    } else {
      vscode.window.showWarningMessage('Kode: no CPU profile is running');
    }
  }));
  // IDE-MET-008:取消前后活动任务从账面对账,不拿空返回值推断工作已停止
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.metrics.showActiveTasks', () => {
    metricsChannel.clear();
    metricsChannel.append(renderActiveTasksReport({
      operationCounts: getActiveOperationCounts(),
      scheduler: getDiagnosticScheduler().pendingWorkload()
    }));
    metricsChannel.show();
  }));
  // IDE-MET-005/006:宿主事件循环延迟与 CPU/RSS 自激活即采样(showSummary 面)
  startEventLoopDelayMonitor();
  startHostVitalsMonitor();
  context.subscriptions.push({
    dispose: () => {
      stopEventLoopDelayMonitor();
      stopHostVitalsMonitor();
    }
  });
  // IDE-MET-004:读盘明细开关(默认关=只累计计数,明细环形缓冲不启用)
  setFileReadVerbose(kbengineConfig.get<boolean>('metrics.fileReadDetail', false));
  logViewer.subscribeLogHub(logHub);

  const enableWebviewConsoleLogs = kbengineConfig.get<boolean>('webviewConsoleLogs', true);
  if (enableWebviewConsoleLogs) {
    logViewer.attachLogHub(logHub);
  }

  // 注册日志相关命令
  const showLogViewerCommand = vscode.commands.registerCommand(
    'kbengine.logs.showViewer',
    () => logViewer.show()
  );
  context.subscriptions.push(showLogViewerCommand);

  const connectLoggerCommand = vscode.commands.registerCommand(
    'kbengine.logs.connect',
    async () => {
      vscode.window.showWarningMessage(
        KBEngineLogCollector.PROTOCOL_WARNING
      );
      try {
        await logCollector.connect();
      } catch (error) {
        vscode.window.showErrorMessage(
          l10nText('Failed to connect the log collector: {error}', { error: String(error) })
        );
      }
    }
  );
  context.subscriptions.push(connectLoggerCommand);

  const disconnectLoggerCommand = vscode.commands.registerCommand(
    'kbengine.logs.disconnect',
    () => logCollector.disconnect()
  );
  context.subscriptions.push(disconnectLoggerCommand);

  const clearLogsCommand = vscode.commands.registerCommand(
    'kbengine.logs.clear',
    () => logViewer.clearLogs()
  );
  context.subscriptions.push(clearLogsCommand);

  const exportLogsCommand = vscode.commands.registerCommand(
    'kbengine.logs.export',
    () => logViewer.exportLogs()
  );
  context.subscriptions.push(exportLogsCommand);
  return { logCollector, logViewer, logHub };
}
