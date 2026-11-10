/**
 * propertyDirection 诊断收编 Rust(AUDIT-005 B2 车道批 7):`$/kode/lint/analyzePropertyDirection`
 * 的 TS 装配面。词法三扫描(self.<path> 访问/def __init__ 赋值+cellData 拷贝键/
 * cellData 键访问,全原文口径)在 Rust;**影子/cellData 两流完整保留**——判定核
 * (方向分类/影子抑制/两流分派)与 def 解析、消息渲染全留 TS 单一来源,Rust 只
 * 供给扫描束(与本地 scanBundleOf 同形),判定核零分叉。零 `self.` 线索返回合法
 * 空束不发 RPC;失败/畸形返回 null(调用方回本地扫描束)——禁止部分采用
 * (静默丢能力)。
 */
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  scanBundleOf,
  type InitAssignedSelfProperties,
  type InitAssignmentSite,
  type PropertyDirectionScanBundle
} from './propertyDirectionDiagnostics';
import type { CellDataKeyAccess } from './propertyDirectionDiagnostics';
import type { PythonSelfPropertyAccess } from './propertyCodeLens';

const PROPERTY_DIRECTION_RUST_METHOD = '$/kode/lint/analyzePropertyDirection';

const PATH_PATTERN = /^\w+(?:\.\w+)*$/;
const NAME_PATTERN = /^\w+$/;
const KEY_PATTERN = /^[^"'\])]+$/;

const emptyBundle = (): PropertyDirectionScanBundle => ({
  accesses: [],
  initAssigned: { names: new Set(), sites: new Map(), cellDataCopyKeys: new Map() },
  cellDataAccesses: []
});

/** 非负整数校验;畸形 true */
const badInt = (value: unknown): boolean =>
  typeof value !== 'number' || !Number.isInteger(value) || value < 0;

/** Rust 扫描束 → 本地同形束;任一面畸形返回 null(整面作废,不部分采用) */
function convertScanBundle(raw: unknown): PropertyDirectionScanBundle | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const scan = raw as Record<string, unknown>;
  const accesses: PythonSelfPropertyAccess[] = [];
  const rawAccesses = scan.accesses;
  if (!Array.isArray(rawAccesses)) {
    return null;
  }
  for (const item of rawAccesses) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    const fullPath = record.fullPath;
    if (typeof fullPath !== 'string' || !PATH_PATTERN.test(fullPath)) {
      return null;
    }
    if (badInt(record.line) || badInt(record.character)) {
      return null;
    }
    accesses.push({
      line: record.line as number,
      character: record.character as number,
      rootSymbol: fullPath.split('.')[0],
      fullPath
    });
  }
  const rawNames = scan.initNames;
  if (!Array.isArray(rawNames)) {
    return null;
  }
  const names = new Set<string>();
  for (const name of rawNames) {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      return null;
    }
    names.add(name);
  }
  const sites = new Map<string, InitAssignmentSite>();
  const rawSites = scan.initSites;
  if (!Array.isArray(rawSites)) {
    return null;
  }
  for (const item of rawSites) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      return null;
    }
    if (badInt(record.line) || badInt(record.character)) {
      return null;
    }
    sites.set(name, { line: record.line as number, character: record.character as number });
  }
  const cellDataCopyKeys = new Map<string, string>();
  const rawKeys = scan.initCellDataKeys;
  if (!Array.isArray(rawKeys)) {
    return null;
  }
  for (const item of rawKeys) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    const name = record.name;
    const key = record.key;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      return null;
    }
    if (typeof key !== 'string' || key === '' || !KEY_PATTERN.test(key)) {
      return null;
    }
    cellDataCopyKeys.set(name, key);
  }
  const cellDataAccesses: CellDataKeyAccess[] = [];
  const rawCellData = scan.cellDataAccesses;
  if (!Array.isArray(rawCellData)) {
    return null;
  }
  for (const item of rawCellData) {
    if (item === null || typeof item !== 'object') {
      return null;
    }
    const record = item as Record<string, unknown>;
    const key = record.key;
    if (typeof key !== 'string' || key === '' || !KEY_PATTERN.test(key)) {
      return null;
    }
    if (badInt(record.line) || badInt(record.character) || badInt(record.length) || badInt(record.accessEnd)) {
      return null;
    }
    cellDataAccesses.push({
      line: record.line as number,
      character: record.character as number,
      length: record.length as number,
      accessEnd: record.accessEnd as number,
      key
    });
  }
  const initAssigned: InitAssignedSelfProperties = { names, sites, cellDataCopyKeys };
  return { accesses, initAssigned, cellDataAccesses };
}

/**
 * Rust-first 扫描束:gate.runInRust 跑 `$/kode/lint/analyzePropertyDirection`,
 * 结构束经 convertScanBundle 转本地同形(调用方 propertyDirectionDiagnosticItems
 * Async / propertyDirectionShadowHintItemsAsync 的 bundle 入参,判定核与兜底
 * 完全同一份);无门/零线索/失败/畸形返回 null(零线索合法空束,不空发 RPC)。
 */
export async function buildPropertyDirectionScanBundleWithRust(
  text: string
): Promise<PropertyDirectionScanBundle | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  if (!text.includes('self.')) {
    return emptyBundle();
  }
  const response = await gate.runInRust<unknown>(PROPERTY_DIRECTION_RUST_METHOD, { text });
  if (!response.ok) {
    return null;
  }
  const scan = (response.result as { scan?: unknown } | undefined)?.scan;
  if (scan === undefined) {
    return null;
  }
  return convertScanBundle(scan);
}

/** 测试面:空束(零线索语义,与 scanBundleOf('') 同输出) */
export const emptyPropertyDirectionScanBundleForTest = emptyBundle;

/** 测试面:本地扫描束直查(对拍兜底侧共用) */
export const localScanBundleForTest = scanBundleOf;
