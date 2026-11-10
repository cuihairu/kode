/**
 * postDestroy 诊断收编 Rust(AUDIT-005 B2 车道批 4):`$/kode/lint/analyzePostDestroy`
 * 的 TS 装配面。块/销毁/早退/访问点分析在 Rust(post_destroy.rs,掩码行由 Rust
 * 自行掩码文本,与 TS pythonCodeLines 对拍一致),本模块只做:门可用性 → 动态
 * 分派/实体面短路与 TS 兜底同语义(declared→[]/face 判不出→[])→ 语句面供给
 * (pythonStatements 是共享上游,parsePythonFile 亦建于其上,掩码拼接文本原样
 * 直传)→ gate.runInRust → 结构面经 renderRustPostDestroyItems 渲染。不可用/
 * 失败/畸形返回 null,调用方(diagnostics.ts postDestroy 臂)回 TS 兜底——禁止
 * 部分采用(静默丢能力)。
 */
import type { EntityComponentFace } from './entityBuiltinProperties';
import { resolveEntityComponentFaceFromPath } from './entityBuiltinProperties';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { pythonStatements } from './pythonParser';
import {
  renderRustPostDestroyItems,
  type PostDestroyDiagnosticItem
} from './postDestroyDiagnostics';

const POST_DESTROY_RUST_METHOD = '$/kode/lint/analyzePostDestroy';

/**
 * Rust-first postDestroy 产物:gate.runInRust 跑 `$/kode/lint/analyzePostDestroy`,
 * 结构面经 renderRustPostDestroyItems 渲染;无门/动态分派(def 声明 destroy)/
 * 非实体脚本(路径面无 def 归属)/失败/畸形按语义返回 null 或合法空面 []
 * ([] 与 TS 兜底同输出,不空发 RPC)。
 */
export async function buildPostDestroyItemsWithRust(
  text: string,
  filePath: string,
  fetchDefFaces: () => Promise<readonly EntityComponentFace[] | null>,
  isDestroyDeclared: () => boolean
): Promise<PostDestroyDiagnosticItem[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  // 动态分派边界:def 声明 destroy → 不冒充引擎销毁(≡ TS 兜底 [],不发 RPC)
  const destroyDeclared = isDestroyDeclared();
  if (destroyDeclared) {
    return [];
  }
  // 非实体脚本不接管(普通 Python 类不猜);角色不明不猜(≡ TS 兜底 [])
  const pathFace = resolveEntityComponentFaceFromPath(filePath);
  let defFaces: readonly EntityComponentFace[] | null = null;
  if (!pathFace) {
    try {
      defFaces = await fetchDefFaces();
    } catch {
      defFaces = null;
    }
  }
  const isEntityScript = pathFace !== null || (defFaces !== null && defFaces.length > 0);
  if (!isEntityScript) {
    return [];
  }
  const face = pathFace ?? (defFaces !== null && defFaces.length === 1 ? defFaces[0] : null);
  if (face === null) {
    return [];
  }
  // 语句面(掩码拼接文本)由 TS 供给,Rust 只做文本分析
  const statements = pythonStatements(text);
  const response = await gate.runInRust<unknown>(POST_DESTROY_RUST_METHOD, {
    text,
    destroyDeclared,
    statements
  });
  if (!response.ok) {
    return null;
  }
  const items = (response.result as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  return renderRustPostDestroyItems(items);
}
