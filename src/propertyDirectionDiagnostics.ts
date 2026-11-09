// GEN-DEF-1e ④:方向违规诊断(属性面)——python 脚本里对 def 属性的访问,
// 若访问位置(进程作用域 / 接收者段)不在属性 Flags 推导的三域位内,标 Warning;
// 进程作用域按 py 文件所在段已知信息推断,不足则降级标 Information(不标
// Error,用户令「不足则标 info 不标 error」)。
//
// 方法面方向违规已由 receiverNoneDiagnostics 的 sectionMismatch
// (kbengine.sectionMismatch)覆盖;本模块只补属性面(属性 Flags 域位)。
//
// 纯逻辑层,不 import vscode:扫 self.<属性路径> / self.<role>.<属性路径> 访问,
// 属性域位经外部解析器回包(与属性 CodeLens 同索引同口径——provider 层把
// EntityMappingManager.resolvePropertyDefinitionInfo 回包装配成
// PropertyDirectionHit),本层不自己读 def 文件。

import { findPythonSelfPropertyAccesses } from './propertyCodeLens';
import { l10nText } from './nlsRuntime';
import { inferMethodSectionFromPythonFile } from './entityMapping';
import type { PropertyFlagDomain } from './backend/defAnalyzer';

export const PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE = 'kbengine.propertyDirectionViolation';
export const PROPERTY_DIRECTION_SCOPE_UNKNOWN_DIAGNOSTIC_CODE = 'kbengine.propertyDirectionScopeUnknown';
export const PROPERTY_DIRECTION_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 进程作用域三域(与属性域位同名词) */
export type PropertyDirectionScope = 'base' | 'cell' | 'client';

/**
 * 进程作用域推断:按 py 文件所在段已知信息(scripts/base|cell|client)。
 * 与 inferMethodSectionFromPythonFile 同口径(同源路径规则),仅把 def 方法段
 * 映射回作用域名;非角色目录(scripts/common/、根级)返回 undefined = 不足。
 */
export function inferProcessScopeFromPythonFile(
  filePath: string
): PropertyDirectionScope | undefined {
  switch (inferMethodSectionFromPythonFile(filePath)) {
    case 'BaseMethods':
      return 'base';
    case 'CellMethods':
      return 'cell';
    case 'ClientMethods':
      return 'client';
    default:
      return undefined;
  }
}

/** 一处属性访问的 def 声明面(方向判定所需的最小面;domains 由 Flags 推导) */
export interface PropertyDirectionHit {
  propertyName: string;
  domains: PropertyFlagDomain[];
  defFile: string;
  defLine: number;
}

export interface PropertyDirectionFinding {
  /** 访问行(0 起) */
  line: number;
  /** 属性名在访问行内的起始列(0 起;接收者限定已跳过 self.<role>.) */
  character: number;
  /** 属性名长度(高亮区间) */
  length: number;
  /** 属性路径(已剥接收者前缀,如 cell.hp → hp) */
  propertyPath: string;
  /** self.<role>.<prop> 的接收者(有则访问域=接收者) */
  receiver?: PropertyDirectionScope;
  /** 文件作用域(无接收者时访问域=文件作用域) */
  fileScope?: PropertyDirectionScope;
  domains: PropertyFlagDomain[];
  message: string;
  severity: 'Warning' | 'Information';
  code: string;
}

/** 接收者段 → 属性域位(与 PYTHON_RECEIVER_SECTIONS 段名一一对应) */
const RECEIVER_SCOPE: Record<string, PropertyDirectionScope> = {
  cell: 'cell',
  base: 'base',
  client: 'client'
};

const domainLabel = (domains: readonly PropertyFlagDomain[]): string =>
  domains.length > 0 ? domains.join('|') : l10nText('(Flags not configured)');

/**
 * 属性方向违规判定(纯函数):每处 self.<prop> / self.<role>.<prop> 访问,
 * 属性在 def 有声明(解析器命中)且访问域不在 Flags 域位内 → Warning;
 * 无接收者的裸 self.<prop> 且文件作用域不足 → Information(降级,不标 Error)。
 * 解析器未命中(非 def 属性/纯 python 属性)一律跳过,不诊断。
 */
export function findPropertyDirectionFindings(
  text: string,
  filePath: string,
  resolve: (propertyPath: string, rootSymbol: string) => PropertyDirectionHit | null | undefined
): PropertyDirectionFinding[] {
  const fileScope = inferProcessScopeFromPythonFile(filePath);
  const findings: PropertyDirectionFinding[] = [];

  for (const access of findPythonSelfPropertyAccesses(text)) {
    const segments = access.fullPath.split('.');
    const root = segments[0] ?? '';
    let receiver: PropertyDirectionScope | undefined;
    let propertyPath = access.fullPath;
    if (RECEIVER_SCOPE[root] && segments.length >= 2) {
      receiver = RECEIVER_SCOPE[root];
      propertyPath = segments.slice(1).join('.');
    }

    const hit = resolve(propertyPath, propertyPath.split('.')[0]);
    if (!hit) {
      continue; // 非 def 属性,不诊断
    }
    const domains = hit.domains;
    // 属性名 token 列:裸 self.<prop> 从 root 起;接收者限定跳过 self.<role>.
    const charStart = receiver
      ? access.character + root.length + 1
      : access.character;

    const accessedDomain = receiver ?? fileScope;
    if (!accessedDomain) {
      // 无接收者且文件作用域不足(不在 scripts/base|cell|client):降级为参考信息
      findings.push({
        line: access.line,
        character: charStart,
        length: propertyPath.length,
        propertyPath,
        receiver,
        fileScope,
        domains,
        severity: 'Information',
        code: PROPERTY_DIRECTION_SCOPE_UNKNOWN_DIAGNOSTIC_CODE,
        message: l10nText(
          'Cannot determine the process scope of {path} (file not under scripts/base|cell|client); direction check downgraded to reference info (not Error)',
          { path: propertyPath }
        )
      });
      continue;
    }

    if (domains.length === 0) {
      continue; // Flags 未配置 → 无域位可判,不发明方向
    }
    if (!domains.includes(accessedDomain)) {
      const detail = receiver
        ? l10nText('not reachable via the {receiver} side (the engine stores per domain; cross-domain references break)', { receiver: receiver as string })
        : l10nText('access in the {scope} section is outside its domain', { scope: fileScope as PropertyDirectionScope });
      findings.push({
        line: access.line,
        character: charStart,
        length: propertyPath.length,
        propertyPath,
        receiver,
        fileScope,
        domains,
        severity: 'Warning',
        code: PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE,
        message: l10nText(
          'self.{prefix}{path} direction violation: {path} declared in the {domains} domain; {detail}',
          {
            prefix: receiver ? `${receiver}.` : '',
            path: propertyPath,
            domains: domainLabel(domains),
            detail
          }
        )
      });
    }
  }
  return findings;
}

/**
 * 异步面:先按 (propertyPath, rootSymbol) 预解析全部去重访问(异步解析器,
 * 如 EntityMappingManager.resolvePropertyDefinitionInfo),再以同步查表
 * 解析器走 findPropertyDirectionFindings——纯判定逻辑零重复,与属性 CodeLens
 * 的「同一属性多处访问只解析一次」同口径。
 */
export async function findPropertyDirectionFindingsAsync(
  text: string,
  filePath: string,
  resolve: (
    propertyPath: string,
    rootSymbol: string
  ) => Promise<PropertyDirectionHit | null | undefined>
): Promise<PropertyDirectionFinding[]> {
  const cache = new Map<string, PropertyDirectionHit | null>();
  const syncResolve = (
    propertyPath: string,
    rootSymbol: string
  ): PropertyDirectionHit | null | undefined => cache.get(`${propertyPath}\u0000${rootSymbol}`);

  for (const access of findPythonSelfPropertyAccesses(text)) {
    const segments = access.fullPath.split('.');
    const root = segments[0] ?? '';
    let propertyPath = access.fullPath;
    if (RECEIVER_SCOPE[root] && segments.length >= 2) {
      propertyPath = segments.slice(1).join('.');
    }
    const rootSymbol = propertyPath.split('.')[0];
    const key = `${propertyPath}\u0000${rootSymbol}`;
    if (!cache.has(key)) {
      cache.set(key, (await resolve(propertyPath, rootSymbol)) ?? null);
    }
  }
  return findPropertyDirectionFindings(text, filePath, syncResolve);
}

/** 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖) */
export interface PropertyDirectionDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning' | 'Information';
  source: 'kbengine';
  code: string;
}

/** 入口(同步):开关口 enabled=false 零产出;解析器同步提供 */
export function propertyDirectionDiagnosticItems(
  text: string,
  filePath: string,
  resolve: (propertyPath: string, rootSymbol: string) => PropertyDirectionHit | null | undefined,
  enabled: boolean
): PropertyDirectionDiagnosticItem[] {
  if (!enabled) {
    return [];
  }
  return findPropertyDirectionFindings(text, filePath, resolve).map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: finding.severity,
    source: 'kbengine' as const,
    code: finding.code
  }));
}

/**
 * 入口(异步):开关口 enabled=false 零产出;解析器异步(预解析去重后同步
 * 判定,与同步入口同产出口径)。
 */
export async function propertyDirectionDiagnosticItemsAsync(
  text: string,
  filePath: string,
  resolve: (
    propertyPath: string,
    rootSymbol: string
  ) => Promise<PropertyDirectionHit | null | undefined>,
  enabled: boolean
): Promise<PropertyDirectionDiagnosticItem[]> {
  if (!enabled) {
    return [];
  }
  return (await findPropertyDirectionFindingsAsync(text, filePath, resolve)).map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: finding.severity,
    source: 'kbengine' as const,
    code: finding.code
  }));
}
