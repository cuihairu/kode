// C-18:引擎官方 def MD5 的 Rust 权威实现接线面——`$/kode/def/md5`。
//
// 边界(镜像 IDE-RUST-008「输入收集留 TS、推导归 Rust」):def 遍历与复合 MD5
// 归 Rust(引擎 EntityDef::md5() 唯一实现),TS 只负责收集输入(types.xml /
// entities.xml / def 原文 / alias.xml / 组件脚本存在性)并封装 RPC。Rust
// 不可用(无门 / 未配 serverPath / 调用失败 / 形状不合规)返回 null,调用方
// 回落到「不协商引擎 Digest」(未知标 unknown 不猜,见 hotReloadDefHash)。
//
// 与 IDE 内部 hash 体系的边界:hashDefContent(sha256 原文指纹)/
// structuralFingerprintHash(semanticHash) 属 IDE 本地对账,与本模块的引擎
// 复合 MD5 是**不同输入、不同算法**,跨类永不互比。

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

/** Rust `$/kode/def/md5` 入参(镜像 md5_handler 的 JSON 形态) */
export interface DefMd5RustParams {
  /** entity_defs/types.xml 原文 */
  typesXml: string;
  /** scripts/entities.xml 原文 */
  entitiesXml: string;
  /** 实体/接口/组件名 → def 原文(不含目录前缀) */
  defs: Record<string, string>;
  /** entity_defs/alias.xml 原文(可选,空串即无) */
  aliasXml: string;
  /** 组件脚本存在性:"base:Inventory" / "cell:Inventory" 形 */
  componentScripts: string[];
}

/** 溯源踪迹段:每个字节段的字段名 + kbengine 源 file:line + hex */
export interface DefMd5TraceEntry {
  field: string;
  source: string;
  bytes: string;
}

/** Rust 引擎复合 MD5 输出(算法恒 'md5':引擎 EntityDef::md5) */
export interface DefMd5RustResult {
  /** 大写 32-hex,引擎 getDigestStr() 格式 */
  md5: string;
  algorithm: 'md5';
  /** 全字节流 hex(供审计/排错) */
  streamHex: string;
  trace: DefMd5TraceEntry[];
}

/**
 * 引擎复合 MD5 计算(经 Rust):收集完成调用,返回引擎 EntityDef::md5() 逐
 * 字节一致的结果;Rust 不可用/失败/形状不合规返回 null。这是客户端侧计算
 * 引擎格式 MD5 的唯一入口(引擎算法唯一实现,Rust 权威,无 TS 镜像)。
 */
export async function computeDefMd5InRust(
  params: DefMd5RustParams
): Promise<DefMd5RustResult | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  const response = await gate.runInRust<DefMd5RustResult>('$/kode/def/md5', {
    typesXml: params.typesXml,
    entitiesXml: params.entitiesXml,
    defs: params.defs,
    aliasXml: params.aliasXml,
    componentScripts: params.componentScripts
  });
  if (!response.ok) {
    return null;
  }
  if (!shapeCheckDefMd5Result(response.result)) {
    return null;
  }
  return response.result;
}

function shapeCheckDefMd5Result(value: unknown): value is DefMd5RustResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (typeof result.md5 !== 'string' || result.algorithm !== 'md5') {
    return false;
  }
  // 引擎 getDigestStr() 格式:恰好 32 个 hex 字符。
  if (!/^[0-9a-fA-F]{32}$/.test(result.md5)) {
    return false;
  }
  if (typeof result.streamHex !== 'string' || result.streamHex.length % 2 !== 0) {
    return false;
  }
  if (!Array.isArray(result.trace)) {
    return false;
  }
  return true;
}
