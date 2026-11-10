/**
 * rpcArgCount 诊断收编 Rust(AUDIT-005 B2 车道批 8):`$/kode/lint/analyzeRpcArgCount`
 * 的 TS 装配面。调用点发现面(findPythonReceiverCalls 走掩码文本,列偏移不变)
 * 与语义闸(mapping.methods 声明对账/段匹配/星号形参)与消息渲染全留 TS 单一
 * 来源;Rust 只做实参计数面(countCallArguments 逐字移植,原文自持字符串/注释
 * 词法态,括号栈跨行)。counts 与 calls 序对齐,null=未知合法槽位;响应缺失/
 * 长度不齐/槽位非「非负整数或 null」整面作废返回 null(调用方回本地计数)——
 * 禁止部分采用。
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import type { PythonReceiverCall } from './pythonLanguageUtils';

const RPC_ARG_COUNT_RUST_METHOD = '$/kode/lint/analyzeRpcArgCount';

/** 计数槽位:非负整数或 null(未知);畸形 true */
const badSlot = (value: unknown): boolean =>
  value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0);

/**
 * Rust-first 实参计数:gate.runInRust 跑 `$/kode/lint/analyzeRpcArgCount`,
 * params = {text(原文), calls(发现面坐标,结构子集)},响应 counts 与 calls
 * 序对齐;无门/失败/畸形返回 null(calls 空不发 RPC,合法空数组)。
 */
export async function buildRpcArgCountsFromRust(
  text: string,
  calls: readonly PythonReceiverCall[]
): Promise<Array<number | null> | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  if (calls.length === 0) {
    return [];
  }
  const response = await gate.runInRust<unknown>(RPC_ARG_COUNT_RUST_METHOD, {
    text,
    calls: calls.map(call => ({
      line: call.line,
      character: call.character,
      methodName: call.methodName
    }))
  });
  if (!response.ok) {
    return null;
  }
  const counts = (response.result as { counts?: unknown } | undefined)?.counts;
  if (!Array.isArray(counts) || counts.length !== calls.length) {
    return null;
  }
  for (const slot of counts) {
    if (badSlot(slot)) {
      return null;
    }
  }
  return counts as Array<number | null>;
}
