/**
 * 返回注解逐文件提取收编 Rust(RUST-MIGRATION-AUDIT-006 B1 车道批 3):
 * `$/kode/python/returnAnnotations` 的 TS 装配面。提取核(pythonReturnType-
 * Inference.ts 的 maskCodeLine/collectFileAnnotationFacts/extractFileImports/
 * parseLocalAssignmentCall 逐字移植,含单行掩码与首定义优先语义)在 Rust,
 * 本模块只做:廉价预检(原文无 `def` 子串 → 零事实不发 RPC)→ gate.runInRust
 * ({text: 原文}) → facts 形状校验(数组/名字非空串/注解 null 或串,畸形整面
 * 弃用)→ 事实序列。导入绑定/逐行调用面随同 RPC 下发,对拍测试直连消费;
 * 生产消费面=注解事实桶(cold build),查询级联(matchingAssignments/导入
 * 绑定)留 TS。不可用/失败/畸形返回 null → 调用方回 TS 让出式提取兜底——
 * 禁止部分采用;杀开关 kbengine.core.backend=ts 语义不变。
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

const RETURN_ANNOTATIONS_RUST_METHOD = '$/kode/python/returnAnnotations';

/** 一条注解事实(name=方法名;annotation=null = def 在而 `->` 缺) */
export interface RustReturnAnnotationFact {
  name: string;
  annotation: string | null;
}

/**
 * Rust-first 注解事实:无门/原文零 `def` 线索/失败/畸形 → null 或合法空面
 * (零线索 [] 与兜底同输出,不空发 RPC)。
 */
export async function extractFileReturnAnnotationFactsFromRust(
  source: string
): Promise<RustReturnAnnotationFact[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  if (!source.includes('def')) {
    return [];
  }
  const response = await gate.runInRust<unknown>(RETURN_ANNOTATIONS_RUST_METHOD, {
    text: source
  });
  if (!response.ok) {
    return null;
  }
  const facts = (response.result as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) {
    return null;
  }
  for (const fact of facts) {
    if (fact === null || typeof fact !== 'object') {
      return null;
    }
    const record = fact as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.length === 0) {
      return null;
    }
    if (record.annotation !== null && typeof record.annotation !== 'string') {
      return null;
    }
  }
  return facts.map(fact => {
    const record = fact as { name: string; annotation: string | null };
    return { name: record.name, annotation: record.annotation };
  });
}
