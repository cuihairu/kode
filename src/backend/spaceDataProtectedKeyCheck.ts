/**
 * KSEM-DATA-06(SEM-047)spaceData 保护键写入诊断 — 纯核(零 vscode 依赖)。
 *
 * 事实源(kbengine fork kbe/src/server/cellapp/spacememory.cpp):set 与 del
 * 对 `_mapping` 键大小写不敏感拒(kbe_stricmp)→ AssertionError
 * "key{_mapping} is protected!"(set:740-742 / del:862-864);**get 放行**
 * ——_mapping 即空间几何映射路径,引擎经 addSpaceGeometryMapping 自写
 * (:543-554),getSpaceGeometryMapping 读它。诊断是引擎契约的静态呈现,
 * 非发明规则;get 写位不发(引擎允许读)。
 *
 * 键保护与 spaceID 可解性正交(引擎先 spaceID 后键序检查,但键拒在
 * spaceID 存在时必然发生):动态 spaceID 的 set/del(_mapping) 照报。
 */
import { l10nText } from '../nlsRuntime';
import { findSpaceDataProtectedKeyFindings, type SpaceDataProtectedKeyFinding } from './spaceDataIndexCore';

export const SPACE_DATA_PROTECTED_KEY_DIAGNOSTIC_CODE = 'kbengine.spaceDataProtectedKey';
export const SPACE_DATA_PROTECTED_KEY_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 消息模板单一来源(引擎 AssertionError 契约,大小写不敏感拒)。 */
export function renderSpaceDataProtectedKeyMessage(
  fn: 'setSpaceData' | 'delSpaceData',
  key: string
): string {
  return l10nText(
    '{fn}("{key}") raises AssertionError at runtime — "{key}" is a protected spaceData key (space geometry mapping; engine rejects it case-insensitively; reading it via getSpaceData is allowed)',
    { fn, key }
  );
}

/** 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖)。 */
export interface SpaceDataProtectedKeyDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Error';
  source: 'kbengine';
  code: string;
}

export function spaceDataProtectedKeyFindingToItem(
  finding: SpaceDataProtectedKeyFinding
): SpaceDataProtectedKeyDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.keyStart },
      end: { line: finding.line, character: finding.keyEnd }
    },
    message: renderSpaceDataProtectedKeyMessage(finding.fn, finding.keyText),
    severity: 'Error',
    source: 'kbengine',
    code: SPACE_DATA_PROTECTED_KEY_DIAGNOSTIC_CODE
  };
}

/** 全文分析入口(别名由调用方解析传入;掩码剔注释/字符串伪调用在纯核内)。 */
export function analyzeSpaceDataProtectedKeys(
  text: string,
  aliases: ReadonlySet<string>
): SpaceDataProtectedKeyDiagnosticItem[] {
  return findSpaceDataProtectedKeyFindings(text, aliases).map(spaceDataProtectedKeyFindingToItem);
}
