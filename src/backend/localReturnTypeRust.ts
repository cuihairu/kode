/**
 * 局部变量返回注解接收者定型收编 Rust(精确性主车道批 D):`$/kode/python/localReturnType`
 * 的 TS 装配面。引擎本体=kode-python local_return.rs(TS
 * pythonReturnTypeInference.ts 级联兜底删除后的同文件可推导子集:同文件 def
 * 调用/self 方法/类限定/链式/别名链,matchingAssignments 同域口径);TS 链
 * 保留 import 绑定路径为兜底(kbengine.core.backend=ts 杀开关语义不变)。
 * 入参 lines 为调用方行数组原样,hoverLine 0 基,versionKey 为
 * flowVersionKeyForDocument 产物的不透明缓存键。响应 ret 缺失/畸形
 * (target/annotation/methodName 任一非串)整面弃用返回 null(hover 回落
 * TS 链)——禁止部分采用;Rust ret:null 与 TS 链 miss 同判据。装配面预检
 * (词空/全大写常量/行越界)与 TS Impl 守卫同判据先行短路不发 RPC。
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

const LOCAL_RETURN_RUST_METHOD = '$/kode/python/localReturnType';

/** Rust 局部返回注解面(与 TS LocalVariableReturnType 字段同形) */
export interface LocalReturnTypeFace {
  target: string;
  annotation: string;
  methodName: string;
}

/**
 * Rust-first 局部变量返回注解:无门/失败/畸形/非法入参一律 null(纯函数回退
 * 面)。词空/全大写常量/行越界与 TS 链判据一致,不发 RPC。
 */
export async function inferLocalReturnTypeFromRust(
  lines: readonly string[],
  hoverLine: number,
  word: string,
  versionKey?: string
): Promise<LocalReturnTypeFace | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  // TS Impl 同款守卫(全大写/下划线常量名不查询)
  if (!word || hoverLine < 0 || hoverLine >= lines.length || /^[A-Z_][A-Z0-9_]*$/.test(word)) {
    return null;
  }
  const params: Record<string, unknown> = { lines, hoverLine, word };
  if (versionKey !== undefined) {
    params.versionKey = versionKey;
  }
  const response = await gate.runInRust<unknown>(LOCAL_RETURN_RUST_METHOD, params);
  if (!response.ok) {
    return null;
  }
  const ret = (response.result as { ret?: unknown } | undefined)?.ret;
  if (ret === null || typeof ret !== 'object') {
    return null;
  }
  const face = ret as Record<string, unknown>;
  if (
    typeof face.target !== 'string' ||
    typeof face.annotation !== 'string' ||
    typeof face.methodName !== 'string'
  ) {
    return null;
  }
  return {
    target: face.target,
    annotation: face.annotation,
    methodName: face.methodName
  };
}
