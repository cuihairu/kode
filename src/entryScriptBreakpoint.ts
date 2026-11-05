// KODE-CFG-006:entryScriptFile 自动断点。
//
// attach/端口模式调试目标启动时,按配置派生(CFG-004 推导链,经
// configDerive 缓存)的 entryScriptFile 模块文件预填初始断点——调试目标
// 自动生成带该断点,免去手点。入口文件不存在 → 不预填并如实出诊断
// (派生 debug.reasons 已含「entry script missing」),绝不崩、绝不假填。
//
// 派生真源在 Rust core(CFG-004 `$/kode/config/derive`);本模块只消费
// configDerive 的缓存状态,不重推推导、不碰 launch 参数——断点是派生
// 目标,不是启动命令参数。预填只在派生结果可用(ok)时进行;RPC 失败/
// 未刷新 → 如实不预填(状态 unavailable),消费端无副作用。
import * as vscode from 'vscode';
import { getConfigDerivedScanRootState } from './configDerive';

export type EntryScriptPrefillStatus = 'prefilled' | 'missing' | 'unavailable';

export interface EntryScriptPrefillResult {
  status: EntryScriptPrefillStatus;
  /** 预填断点的入口脚本路径(仅 prefilled 非空) */
  path: string | null;
  /** 未预填原因(缺失/不可用),供诊断面读 */
  reason: string | null;
}

/** 入口缺失时的诊断出口(测试可注入记录器,生产走 warning 消息) */
export function defaultReportMissing(reason: string): void {
  void vscode.window.showWarningMessage(`入口脚本缺失,未预填初始断点:${reason}`);
}

/**
 * 按配置派生结果预填入口脚本断点(幂等:读缓存状态,不触发 RPC)。
 *
 * - 派生结果可用且入口脚本存在 → 在该文件第 0 行加断点,返回 prefilled。
 * - 入口脚本不存在 → 零断点 + 出诊断(reportMissing),返回 missing。
 * - 派生未就绪/RPC 失败 → 零断点,返回 unavailable(消费端无副作用)。
 */
export function prefillEntryScriptBreakpoints(
  onMissing: (reason: string) => void = defaultReportMissing
): EntryScriptPrefillResult {
  const state = getConfigDerivedScanRootState();
  if (!state || !state.ok) {
    return {
      status: 'unavailable',
      path: null,
      reason: state ? state.reason : 'no derived state'
    };
  }
  const target = state.entryScripts.find(s => s.path && s.exists);
  if (target && target.path) {
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(
        new vscode.Location(vscode.Uri.file(target.path), new vscode.Position(0, 0))
      )
    ]);
    return { status: 'prefilled', path: target.path, reason: null };
  }
  // 入口脚本缺失:派生 debug.reasons 已含「entry script missing: p/m」。
  const reason =
    state.debug.reasons.find(r => r.startsWith('entry script missing')) ??
    'entry script not resolved';
  onMissing(reason);
  return { status: 'missing', path: null, reason };
}
