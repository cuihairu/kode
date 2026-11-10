/**
 * readOnlyWrite 诊断收编 Rust(AUDIT-005 B2 车道批 5):`$/kode/lint/analyzeReadOnlyWrite`
 * 的 TS 装配面。写入形态分类/掩码扫描/只读名成员闸在 Rust(readonly_write.rs,
 * 掩码与逐语义同 TS),本模块只做:廉价预检(零 `self.` 线索零产出,不发 RPC)→
 * 面解析(与内建属性 hover 同源:目录域优先,判不出经 fetchDefFaces 取 def 归属)
 * → 只读名集供给(getEntityBuiltinPropertiesForFace(face) 表 readonly 名集,
 * 引擎属性表不过 Rust 单一来源留 TS)→ gate.runInRust → 结构面经
 * renderRustReadOnlyWriteItems 渲染(属性表重解析完整性校验,矛盾整面作废)。
 * 不可用/失败/畸形返回 null,调用方(diagnostics.ts readOnlyWrite 臂)回 TS 兜底
 * ——禁止部分采用(静默丢能力)。
 */
import {
  getEntityBuiltinPropertiesForFace,
  resolveEntityComponentFaceFromPath,
  type EntityComponentFace
} from './entityBuiltinProperties';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  renderRustReadOnlyWriteItems,
  type ReadOnlyWriteDiagnosticItem
} from './readOnlyWriteDiagnostics';

const READ_ONLY_WRITE_RUST_METHOD = '$/kode/lint/analyzeReadOnlyWrite';

/**
 * Rust-first readOnlyWrite 产物:gate.runInRust 跑 `$/kode/lint/analyzeReadOnlyWrite`,
 * 结构面经 renderRustReadOnlyWriteItems 渲染;无门/非实体脚本(路径面无 def
 * 归属)/失败/畸形返回 null(非实体合法空面 [],与 TS 兜底同输出,不空发 RPC)。
 */
export async function buildReadOnlyWriteItemsWithRust(
  text: string,
  filePath: string,
  fetchDefFaces: () => Promise<readonly EntityComponentFace[] | null>
): Promise<ReadOnlyWriteDiagnosticItem[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  // 面解析(与内建属性 hover/inlay 同一底座同口径)
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
  // 只读名集 = face 表 readonly 集(引擎属性表单一来源留 TS)
  const readonlyNames = getEntityBuiltinPropertiesForFace(face)
    .filter(property => property.readonly)
    .map(property => property.name);
  const response = await gate.runInRust<unknown>(READ_ONLY_WRITE_RUST_METHOD, {
    text,
    readonlyNames
  });
  if (!response.ok) {
    return null;
  }
  const items = (response.result as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  return renderRustReadOnlyWriteItems(items, pathFace, defFaces);
}
