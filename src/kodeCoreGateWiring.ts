import * as vscode from 'vscode';
import { discoverNativeBinary } from './backend/nativeBinary';

import { KodeCoreGate, type KodeCoreGateConfig, ShadowDiffEntry } from './backend/kodeCoreGate';
import { cancelCorpusMirrorRuns, mirrorCorpusToRust } from './kodeCoreCorpusMirror';
import {
  KodeCoreHealthLightController,
  type CoreHealthGateSnapshot,
} from './kodeCoreHealthLight';
import { writeCoreBackendMode } from './kodeCoreBackendSwitch';
import { l10nText } from './nlsRuntime';
import { getIndexScanRoots, resetScanRootCache } from './scanRoots';
import { setKodeCoreShadowGate } from './backend/kodeCoreShadowFaces';

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

/**
 * 自动发现 kode-server 二进制(2026-11-08 用户令:插件不应让用户手填服务器
 * 路径,serverPath 未显式配置时先查随包 bin,再查源码构建路径)。命中即返回绝对
 * 路径;全落空返回 ''(调用方回落 ts,不误伤)。
 */
export function discoverKodeServerBinary(extensionRoot: string): string {
  return discoverNativeBinary(extensionRoot, 'kode-server');
}

/** 读 kbengine.core.* 当前配置(每次现读,不做缓存失效);serverPath 未配
 * 时按 extensionRoot 自动发现(留空 = 自动发现也落空)。 */
export function readCoreGateConfig(extensionRoot?: string): KodeCoreGateConfig {
  const config = vscode.workspace.getConfiguration('kbengine');
  const configured = config.get<string>('core.serverPath', '');
  let serverPath = configured;
  if (!serverPath && extensionRoot) {
    serverPath = discoverKodeServerBinary(extensionRoot);
  }
  return {
    backend: config.get<string>('core.backend', 'rust'),
    serverPath,
    shadowTimeoutMs: config.get<number>('core.shadow.timeoutMs', 2000),
  };
}

/**
 * RUST-069-W:扫描根集差量(上次同步快照 → 当前)——folder 增删 /
 * assetsRoot 切换统一走这一面,新增 registerRoot、移除 removeRoot。
 * 纯函数(单测面);路径为规范 fsPath,集合语义不做大小写归一。
 */
export function diffScanRoots(
  previous: ReadonlySet<string>,
  current: readonly string[]
): { added: string[]; removed: string[] } {
  const currentSet = new Set(current);
  const removed = [...previous].filter(root => !currentSet.has(root));
  const added = current.filter(root => !previous.has(root));
  return { added, removed };
}

/**
 * RUST-149 批 2:根差量→gate 动作序列(可测纯逻辑)——移除扇出清理先于
 * 注册,新增根补镜像;返回新快照作为下次差量基准(setup 内每次事件后以
 * 返回值滚动 lastSyncedRoots)。
 */
export function syncRootDiffToGate(
  gate: Pick<KodeCoreGate, 'removeRoot' | 'registerRoot'>,
  lastSyncedRoots: ReadonlySet<string>,
  current: readonly string[],
  remirror: () => void
): Set<string> {
  const { added, removed } = diffScanRoots(lastSyncedRoots, current);
  for (const root of removed) {
    void gate.removeRoot(root);
  }
  for (const root of added) {
    void gate.registerRoot(root);
  }
  if (added.length > 0) {
    // 新根就位后补镜像该根语料(镜像入口先注册根再镜像;账内已镜像
    // 文件按账跳过,新根文件走 didOpen 入库)。
    remirror();
  }
  return new Set(current);
}

/** 当前扫描根全集(缓存先失效防拿到切换前旧值;异常回空数组不外抛) */
function currentScanRootsSafe(): string[] {
  try {
    resetScanRootCache();
    return getIndexScanRoots();
  } catch {
    return [];
  }
}

/** 删除事件载荷:真 API 带 files;fake 桩 delete 臂历史形状为 uris,
 * 双形并读(processOwnership 同口径)保持桩/真机同一条事件链。 */
function deletedEventUris(
  event: { files?: ReadonlyArray<{ toString(): string }>; uris?: ReadonlyArray<{ toString(): string }> }
): Array<{ toString(): string }> {
  return [...(event.files ?? []), ...(event.uris ?? [])];
}

export function setupKodeCoreGate(context: vscode.ExtensionContext): KodeCoreGate {
  const gate = new KodeCoreGate();
  const extensionRoot = context.extensionUri.fsPath;
  gate.setConfig(readCoreGateConfig(extensionRoot));
  // KBUG-ROOT 根归属:把多工作区文件夹作为 LSP initialize.workspaceFolders
  // 注册给 kode-server(逐个成为资源根),跨根同名实体不再首见借路径。
  // 必须在首次语料镜像(ensureClient)之前设置,握手即携带。
  gate.setInitializeParams({
    processId: process.pid,
    capabilities: {},
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({
      uri: folder.uri.toString(),
      name: folder.name,
    })),
  });
  // 2026-11-08 用户令「直接切」:服务轨道生效时把工作区语料全量镜像给 Rust
  // (类型/实体/别名/继承链只由已镜像文档入库)。fire-and-forget,不阻塞
  // 激活;非服务轨道零开销。(镜像入口先注册扫描根再镜像,见 corpusMirror。)
  void mirrorCorpusToRust(gate);

  // RUST-069-W:工作区根生命周期接入 Rust 唯一根注册表——folder 增删 /
  // assetsRoot 切换的根集差量(rootAdded/rootRemoved)同步给 Rust,移除
  // 扇出共享缓存清理(镜像/符号/解析候选)。快照对账,不依赖各处 reset
  // 顺序;gate 内账去重 + server 幂等兜底。
  let lastSyncedRoots = new Set<string>(currentScanRootsSafe());
  const syncRootsToRust = (): void => {
    lastSyncedRoots = syncRootDiffToGate(gate, lastSyncedRoots, currentScanRootsSafe(), () => {
      void mirrorCorpusToRust(gate);
    });
  };
  const foldersWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    syncRootsToRust();
  });

  // RUST-131-W:生产文件事件(重命名/删除)直传 rust。VS Code 只对打开
  // 缓冲区发 didOpen/didClose——未打开依赖被移动/删除时语料侧旧 URI 残留
  // (符号/解析缓存/待执行刷新),由此面兜底撤销;gate 内仅存活 client 才
  // 发(未启动静默忽略)。LSP 形状:didRenameFiles {files:[{oldUri,newUri}]},
  // didDeleteFiles {files:[{uri}]}。
  const renamedFilesWatcher = vscode.workspace.onDidRenameFiles(event => {
    gate.notifyWorkspaceFileEvent(
      'workspace/didRenameFiles',
      {
        files: event.files.map(f => ({
          oldUri: f.oldUri.toString(),
          newUri: f.newUri.toString(),
        })),
      }
    );
  });
  const deletedFilesWatcher = vscode.workspace.onDidDeleteFiles(event => {
    gate.notifyWorkspaceFileEvent(
      'workspace/didDeleteFiles',
      { files: deletedEventUris(event).map(uri => ({ uri: uri.toString() })) }
    );
  });

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

  // RUST-221(旧 UI-004)Core 重启:停当前 Rust 进程并清冷却/镜像账/快照,
  // 下次语义请求按当前配置重建(与换 serverPath 自动重启同一路径);重启后
  // 补镜像语料(新进程空库)。backend=ts 时如实说明无 Rust 进程可重启。
  const restartCoreCommand = vscode.commands.registerCommand('kbengine.core.restart', () => {
    if (gate.mode === 'ts') {
      void vscode.window.showInformationMessage(
        `当前 kbengine.core.backend=ts(纯 TS 轨道),没有 Rust Core 进程可重启;切到 rust/shadow 后本命令才有作用。`
      );
      return;
    }
    gate.restartCore();
    // KODE-RESP-006:停进程后先掐在途镜像轮——旧轮的 mirrorDocument 会把
    // 被杀的 client 重新拉起(僵尸复活),晚到的旧语料也不得进新进程。
    cancelCorpusMirrorRuns();
    void mirrorCorpusToRust(gate);
    void vscode.window.showInformationMessage(
      `Kode Core 已重启:旧进程已停止,镜像账与快照已清;下次语义请求按当前配置重建(冷启动短暂变慢)。backend=${gate.mode}。`
    );
  });

  // Core 健康灯(2026-11-24 用户令「server 死了我怎么去判断,这个问题不
  // 解决,这个插件根本没有办法使用」):状态栏常驻 kode-server 活性灯,
  // 10s 探针(2s 预算,探针永不悬挂);点击 = 诊断详情 + 可选重启。灯面
  // 只观测不驱动回落;off 态(backend=ts)整灯隐藏零噪音。
  const healthLight = new KodeCoreHealthLightController({
    createStatusBarItem: (alignment, priority) =>
      vscode.window.createStatusBarItem(alignment, priority),
    registerCommand: (command, handler) => vscode.commands.registerCommand(command, handler),
    timers: {
      set: (callback, delayMs) => setTimeout(callback, delayMs),
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    snapshot: (): CoreHealthGateSnapshot => ({
      backendMode: gate.mode,
      serverPathPresent: gate.state.serverPath !== '',
      clientAlive: gate.state.clientAlive,
      commandCircuit: gate.commandCircuitState(),
    }),
    probe: () => gate.probeHealth(),
    showMessage: text => {
      void vscode.window.showInformationMessage(text);
    },
    pickAction: async labels =>
      await vscode.window.showQuickPick([...labels], {
        placeHolder: l10nText('Core health light actions')
      }),
    restartCore: () => {
      void vscode.commands.executeCommand('kbengine.core.restart');
    },
    // 点击灯切轨:写配置面(不是内存开关)——既有 onDidChangeConfiguration →
    // gate.setConfig 即时重装配轨道,不必重载窗口;写后未生效如实报错上报
    // (作用域被覆盖压住时不谎报成功)
    setBackend: mode => {
      void writeCoreBackendMode(mode).catch(error => {
        void vscode.window.showErrorMessage(
          l10nText('Failed to switch the Core track: {error}', {
            error: error instanceof Error ? error.message : String(error)
          })
        );
      });
    },
  });

  const configWatcher = vscode.workspace.onDidChangeConfiguration(event => {
    if (
      event.affectsConfiguration('kbengine.core.backend') ||
      event.affectsConfiguration('kbengine.core.serverPath') ||
      event.affectsConfiguration('kbengine.core.shadow')
    ) {
      gate.setConfig(readCoreGateConfig(extensionRoot));
      syncChannel();
      // 配置变更可能切进服务轨道(或换 serverPath 重启空库):补镜像语料。
      void mirrorCorpusToRust(gate);
    }
    if (event.affectsConfiguration('kbengine.assetsRoot')) {
      // RUST-069-W:assetsRoot 切换 = 根集输入变化,差量同步给 Rust
      // (旧外部根移除扇出清理,新外部根注册)。
      syncRootsToRust();
    }
  });

  context.subscriptions.push(
    gate,
    configWatcher,
    restartCoreCommand,
    foldersWatcher,
    renamedFilesWatcher,
    deletedFilesWatcher,
    showDiffLogCommand,
    healthLight,
    unsubscribe
  );
  // Phase2 首片:把门交给定义/诊断 provider 的影子对拍入口(默认 ts 下
  // 全部入口零开销直通;gate dispose 时撤引用)。
  setKodeCoreShadowGate(gate);
  const originalDispose = gate.dispose.bind(gate);
  gate.dispose = async () => {
    setKodeCoreShadowGate(null);
    await originalDispose();
  };
  return gate;
}
