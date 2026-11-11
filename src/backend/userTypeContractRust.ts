/**
 * user_type 三契约探测/收集收编 Rust(RUST-MIGRATION-AUDIT-006 B1 车道批 4):
 * `$/kode/python/userTypeContract` 的 TS 装配面。探测核(implFileHasContract-
 * Method)与缺方法收集核(collectUserTypeContractMissing)逐字移植在 Rust;
 * 注册表半(types.xml/alias.xml 解析、impl 行定位、文件读取=definition-
 * Workspace 宿主绑定)留 TS——本模块只做组装:快照收集(statuses 带 methods
 * 供 TS 兜底,RPC 下发剥 methods 由 Rust 从 sources 原文重探测)→
 * gate.runInRust({file, sources, statuses}) → items 形状校验(message/method
 * ∈三方法/typeName/symbolName/symbolLength 非负整数/line 非负整数/related
 * 双串,畸形整面弃用)→ items(line 已贴)。无绑定本文件的 status → 合法
 * 空面 [](不空发 RPC);无门/失败/畸形 → null → 调用方回 TS
 * collectUserTypeContractMissingByImplFile 兜底——禁止部分采用;杀开关
 * kbengine.core.backend=ts 语义不变。
 */
import { readWorkspaceTextFile } from '../definitionWorkspace';
import {
  USER_TYPE_CONTRACT_METHODS,
  type UserTypeContractMethod,
  type UserTypeContractMissingItem,
  type UserTypeContractStatus
} from './userTypeContract';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

const USER_TYPE_CONTRACT_RUST_METHOD = '$/kode/python/userTypeContract';

const CONTRACT_METHOD_SET = new Set<string>(USER_TYPE_CONTRACT_METHODS);

/** 一条缺方法诊断项(定位行已贴;= TS collectUserTypeContractMissingByImplFile 出参同构) */
export type RustUserTypeContractMissingItem = UserTypeContractMissingItem & { line: number };

/**
 * Rust-first 缺方法收集:无门/失败/畸形 → null(调用方回 TS 兜底);
 * 无绑定目标文件的 status → 合法空面 [](不空发 RPC)。
 */
export async function collectUserTypeContractMissingByImplFileFromRust(
  statuses: readonly UserTypeContractStatus[],
  implFile: string
): Promise<RustUserTypeContractMissingItem[] | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  if (!statuses.some(status => status.implFile === implFile)) {
    return [];
  }
  const sources: Record<string, string> = {};
  for (const status of statuses) {
    if (status.implFile && sources[status.implFile] === undefined) {
      sources[status.implFile] = readWorkspaceTextFile(status.implFile);
    }
  }
  const response = await gate.runInRust<unknown>(USER_TYPE_CONTRACT_RUST_METHOD, {
    file: implFile,
    sources,
    statuses: statuses.map(status => {
      // methods 不下发:探测在 Rust 从 sources 原文重做(TS 快照 methods 仅供兜底)
      const wire: Record<string, unknown> = { name: status.name };
      if (status.implementedBy !== undefined) {
        wire.implementedBy = status.implementedBy;
      }
      if (status.implFile !== undefined) {
        wire.implFile = status.implFile;
      }
      if (status.implLine !== undefined) {
        wire.implLine = status.implLine;
      }
      return wire;
    })
  });
  if (!response.ok) {
    return null;
  }
  const items = (response.result as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  const collected: RustUserTypeContractMissingItem[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.message !== 'string') {
      return null;
    }
    if (typeof record.method !== 'string' || !CONTRACT_METHOD_SET.has(record.method)) {
      return null;
    }
    if (typeof record.typeName !== 'string' || typeof record.symbolName !== 'string') {
      return null;
    }
    if (
      typeof record.symbolLength !== 'number' ||
      !Number.isInteger(record.symbolLength) ||
      record.symbolLength < 0
    ) {
      return null;
    }
    if (typeof record.line !== 'number' || !Number.isInteger(record.line) || record.line < 0) {
      return null;
    }
    const related = record.related;
    if (related === null || typeof related !== 'object') {
      return null;
    }
    const relatedRecord = related as Record<string, unknown>;
    if (
      typeof relatedRecord.targetFile !== 'string' ||
      typeof relatedRecord.label !== 'string'
    ) {
      return null;
    }
    collected.push({
      message: record.message,
      method: record.method as UserTypeContractMethod,
      typeName: record.typeName,
      symbolName: record.symbolName,
      symbolLength: record.symbolLength,
      line: record.line,
      related: { targetFile: relatedRecord.targetFile, label: relatedRecord.label }
    });
  }
  return collected;
}
