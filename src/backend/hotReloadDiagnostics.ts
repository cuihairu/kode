// RUST-341:热更保存流水线诊断呈现面(HR-WATCH-017 的用户可审查出口)。
// 八型诊断事件(trigger/filtered/debounced/deduped/blocked/scheduled/
// preview/flushed)由纯核如实注入,这里只做格式化与通道落账——零 IO、
// 零 vscode 导入,通道与时钟由装配注入(与 hotReloadSavePipeline 同边界)。
// 「KBEngine 热更诊断」通道一行一事件,不聚合不筛除:呈现即全量,用户按
// 时间线复查每次保存的完整判定链(触发→去抖/滤除→闸门→排窗→发出);
// kbengine.hotReload.showDiagnostics 命令打开通道,是唯一交互面。

import type { SavePipelineDiagnostic, SavePipelineDiagnosticType } from './hotReloadSavePipeline';

export const HOT_RELOAD_DIAGNOSTICS_CHANNEL_NAME = 'KBEngine 热更诊断';
export const HOT_RELOAD_SHOW_DIAGNOSTICS_COMMAND = 'kbengine.hotReload.showDiagnostics';

/** 八型诊断的用户脸面标签(与 SavePipelineDiagnosticType 一一对应) */
export const SAVE_PIPELINE_DIAGNOSTIC_LABELS: Record<SavePipelineDiagnosticType, string> = {
  trigger: '触发',
  filtered: '滤除',
  debounced: '去抖合并',
  deduped: '去重跳过',
  blocked: '闸门拦下',
  scheduled: '排窗',
  preview: '批量预览滞留',
  flushed: '成批发出'
};

/** 最小通道面(vscode.OutputChannel 的结构子集,测试替身同形) */
export interface HotReloadDiagnosticsChannelFace {
  appendLine(line: string): void;
  show(): void;
  dispose?(): void;
}

/**
 * 一条诊断 → 一行可审查文本:`[时间] 标签 文件: 明细`。
 * 文件/明细缺省如实省略,不猜不补;标签取自全量标签表,任何新增诊断型
 * 缺标签会在构造 Record 时被 TS 卡住( exhaustiveness 由类型保证)。
 */
export function formatHotReloadDiagnosticLine(
  diagnostic: SavePipelineDiagnostic,
  formatTime: (ms: number) => string
): string {
  const label = SAVE_PIPELINE_DIAGNOSTIC_LABELS[diagnostic.type];
  const uri = diagnostic.uri ? ` ${diagnostic.uri}` : '';
  const detail = diagnostic.detail ? `: ${diagnostic.detail}` : '';
  return `[${formatTime(diagnostic.time)}] ${label}${uri}${detail}`;
}

/** 诊断面板:push 全量落通道;show 打开通道(命令入口);dispose 随装配释放 */
export class HotReloadDiagnosticsPanel {
  private readonly channel: HotReloadDiagnosticsChannelFace;
  private readonly formatTime: (ms: number) => string;
  private disposedFlag = false;

  constructor(deps: { channel: HotReloadDiagnosticsChannelFace; formatTime: (ms: number) => string }) {
    this.channel = deps.channel;
    this.formatTime = deps.formatTime;
  }

  get disposed(): boolean {
    return this.disposedFlag;
  }

  /** 全量落账:不筛除、不聚合——被闸门拦下的事件同样要在面板可见 */
  push(diagnostic: SavePipelineDiagnostic): void {
    if (this.disposedFlag) {
      return;
    }
    this.channel.appendLine(formatHotReloadDiagnosticLine(diagnostic, this.formatTime));
  }

  /** 打开通道(kbengine.hotReload.showDiagnostics 命令体) */
  show(): void {
    this.channel.show();
  }

  dispose(): void {
    if (this.disposedFlag) {
      return;
    }
    this.disposedFlag = true;
    this.channel.dispose?.();
  }
}
