import * as vscode from 'vscode';
import { discoverNativeBinary } from './backend/nativeBinary';

import { KodeCoreGate, type KodeCoreGateConfig, ShadowDiffEntry } from './backend/kodeCoreGate';
import { mirrorCorpusToRust } from './kodeCoreCorpusMirror';
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
    foldersWatcher,
    renamedFilesWatcher,
    deletedFilesWatcher,
    showDiffLogCommand,
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
