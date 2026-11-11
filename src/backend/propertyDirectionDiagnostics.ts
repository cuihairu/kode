// GEN-DEF-1e ④:方向违规诊断(属性面)——python 脚本里对 def 属性的访问,
// 若访问位置(进程作用域 / 接收者段)不在属性 Flags 推导的三域位内,标 Warning;
// 进程作用域按 py 文件所在段已知信息推断,不足则降级标 Information(不标
// Error,用户令「不足则标 info 不标 error」)。
//
// cellData 通道(2026-11-10 用户报障收编):baseapp 对带 cell 部件的实体自动
// 装 self.cellData dict(kbe/src/server/baseapp/entity.cpp:238,createCellData
// :250-308 装全部 cell 桶属性默认值+position/direction;cell 创建时整 dict 作
// 初值流给 cellapp baseapp.cpp:2561)——base 侧合法的 cell 属性通道是
// self.cellData["x"],不是直接属性。分析产出分两条流:
//   诊断流(下划线):真方向违规(Warning)与作用域不足(Information);
//   提示流(inlay 淡色小字,用户令 2026-11-10「不要下划线,很容易以为是
//   错误」「就提示复制属性开头,颜色变下就行」):
//     1) 复制属性:__init__ 里 self.y = self.cellData["x"] 取值的,y 是 cell
//        侧 def 字段 x 的 base 侧副本——赋值行与裸访问处渲染
//        「复制属性 x: <type> · <domains>」;
//     2) cellData["key"] 的 key 对 def 解析:def 键渲染 key 的 def 面
//        「key: <type> · <domains>」,域位不含 cell 追加「不在 cellData」;
//        非 def 键(position/direction/脚本自塞键)一律跳过,不发明。
//     __init__ 里赋值但右侧非 cellData 的:暂不展示也不报错(用户令
//     「暂时复制属性吧」),仅作误报治理(不再标 Warning)。
//
// 方法面方向违规已由 receiverNoneDiagnostics 的 sectionMismatch
// (kbengine.sectionMismatch)覆盖;本模块只补属性面(属性 Flags 域位)。
//
// 纯逻辑层,不 import vscode:扫 self.<属性路径> / self.<role>.<属性路径> 访问,
// 属性域位经外部解析器回包(与属性 CodeLens 同索引同口径——provider 层把
// EntityMappingManager.resolvePropertyDefinitionInfo 回包装配成
// PropertyDirectionHit),本层不自己读 def 文件。

import { findPythonSelfPropertyAccesses } from './propertyCodeLens';
import { l10nText } from '../nlsRuntime';
import { inferMethodSectionFromPythonFile } from '../entityMapping';
import type { PropertyFlagDomain } from './defAnalyzer';

export const PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE = 'kbengine.propertyDirectionViolation';
export const PROPERTY_DIRECTION_SCOPE_UNKNOWN_DIAGNOSTIC_CODE = 'kbengine.propertyDirectionScopeUnknown';
/** __init__ 影子属性(普通赋值):脚本自维护的同名属性,误报治理不标 Warning */
export const PROPERTY_DIRECTION_SHADOW_DIAGNOSTIC_CODE = 'kbengine.propertyDirectionShadowAttribute';
/** 复制属性提示:右侧取自 self.cellData,提示为 cell 侧字段的副本值 */
export const PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE = 'kbengine.propertyDirectionCellDataCopy';
/** cellData["key"] 的 key 对 def 解析面(含「不在 cellData」标记) */
export const PROPERTY_DIRECTION_CELL_DATA_KEY_DIAGNOSTIC_CODE = 'kbengine.propertyDirectionCellDataKey';
export const PROPERTY_DIRECTION_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 进程作用域三域(与属性域位同名词) */
export type PropertyDirectionScope = 'base' | 'cell' | 'client';

/**
 * 进程作用域推断:按 py 文件所在段已知信息(scripts/base|baseapp|cell|
 * cellapp|client|bots,KBEngine 实际目录名与 BigWorld 旧名同权)。
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
  /** def <Type> 直文本(复制属性/cellData 键提示展示用;缺省不带类型段) */
  typeName?: string;
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
  /** 复制属性/cellData 键流的 RHS 键名(提示展示用) */
  cellDataKey?: string;
  /** 提示锚列(self.<名> token / cellData 访问表达式之后;提示流用) */
  endCharacter?: number;
  /** def <Type> 直文本(提示展示用;解析未命中不带) */
  typeName?: string;
  /** def 声明文件(提示流导航目标;解析未命中不带) */
  defFile?: string;
  /** def 声明行(0 起;提示流导航目标) */
  defLine?: number;
}

/** 接收者段 → 属性域位(与 PYTHON_RECEIVER_SECTIONS 段名一一对应) */
const RECEIVER_SCOPE: Record<string, PropertyDirectionScope> = {
  cell: 'cell',
  base: 'base',
  client: 'client'
};

const domainLabel = (domains: readonly PropertyFlagDomain[]): string =>
  domains.length > 0 ? domains.join('|') : l10nText('(Flags not configured)');

/** __init__ 内一处 self.<名> = 赋值的位置面 */
export interface InitAssignmentSite {
  /** 赋值行(0 起) */
  line: number;
  /** self.<名> token 结束列(0 起;复制属性 inlay 锚在其后) */
  character: number;
}

/** __init__ 内 self.<属性> = 赋值的扫描结果面 */
export interface InitAssignedSelfProperties {
  /** __init__ 里赋过值的属性名(影子属性全体,误报治理面) */
  names: Set<string>;
  /** 名称 → 赋值位置(self.<名> token 之后) */
  sites: Map<string, InitAssignmentSite>;
  /** 名称 → RHS 引用的 cellData 键(self.y = self.cellData["x"] 的 x) */
  cellDataCopyKeys: Map<string, string>;
}

/**
 * __init__ 内的 self.<属性> = 赋值扫描(纯行扫描,与模块同为保守词法面,
 * 不 import vscode、不引入 AST):脚本在 __init__ 里给同名属性赋值
 * (self.spaceUType = self.cellData["spaceUType"] 等)即声明了「自维护影子
 * 属性」——引擎域外的裸访问不再是失效引用(引擎 GenericGetAttr 落到实例
 * __dict__ 的影子值上),误报治理不再标 Warning(用户令)。右侧引用
 * self.cellData 的把键名记下来(2026-11-10 用户令:提示是 cell 对应属性的
 * copy 值,带 key/类型/域位)。多类各自扫,__init__ 出块(缩进回落)即收手;
 * `==`/`+=`/注解赋值不计(保守,宁漏勿错)。
 */
export function findInitAssignedSelfProperties(text: string): InitAssignedSelfProperties {
  const names = new Set<string>();
  const sites = new Map<string, InitAssignmentSite>();
  const cellDataCopyKeys = new Map<string, string>();
  let initIndent = -1;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const defMatch = /^(\s*)def\s+__init__\s*\(/.exec(line);
    if (defMatch) {
      initIndent = defMatch[1].length;
      continue;
    }
    if (initIndent < 0) {
      continue;
    }
    if (line.trim() === '') {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= initIndent) {
      initIndent = -1; // 出块;下一个 def __init__(下一类)重新进入
      continue;
    }
    const assign = /^(\s*)self\.(\w+)\s*=(?!=)(.*)$/.exec(line);
    if (!assign) {
      continue;
    }
    const name = assign[2];
    names.add(name);
    sites.set(name, {
      line: index,
      character: assign[1].length + 'self.'.length + name.length
    });
    const cellKey = /self\.cellData\s*(?:\[\s*(["'])([^"'\]]+)\1|\.get\s*\(\s*(["'])([^"')]+)\3)/
      .exec(assign[3] ?? '');
    const key = cellKey?.[2] ?? cellKey?.[4];
    if (key) {
      cellDataCopyKeys.set(name, key);
    }
  }
  return { names, sites, cellDataCopyKeys };
}

/** 一处 self.cellData["key"] / self.cellData.get("key") 访问的结构面 */
export interface CellDataKeyAccess {
  /** 访问行(0 起) */
  line: number;
  /** key 起始列(0 起,UTF-16 码元;不含引号) */
  character: number;
  /** key 长度(高亮区间) */
  length: number;
  /** 整个访问表达式的结束列(inlay 提示锚在其后) */
  accessEnd: number;
  key: string;
}

const CELL_DATA_ACCESS_PATTERN =
  /self\.cellData\s*(?:\[\s*(["'])([^"'\]]+)\1\s*\]|\.get\s*\(\s*(["'])([^"')]+)\3)/g;

/**
 * 全文扫 self.cellData["key"] / self.cellData.get("key") 访问(与
 * findPythonSelfPropertyAccesses 同款朴素行级正则,无掩码同口径)。
 * 位置指向 key 本身(引号内),供提示锚定;accessEnd 指向表达式尾。
 */
export function findCellDataKeyAccesses(text: string): CellDataKeyAccess[] {
  const accesses: CellDataKeyAccess[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    CELL_DATA_ACCESS_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CELL_DATA_ACCESS_PATTERN.exec(lines[index])) !== null) {
      const key = match[2] ?? match[4];
      if (!key) {
        continue;
      }
      accesses.push({
        line: index,
        character: match.index + match[0].indexOf(key),
        length: key.length,
        accessEnd: match.index + match[0].length,
        key
      });
    }
  }
  return accesses;
}

/** 一次词法扫描束(三扫描面:AUDIT-005 B2 批 7 起 Rust 面可供给,判定核共用) */
export interface PropertyDirectionScanBundle {
  accesses: ReturnType<typeof findPythonSelfPropertyAccesses>;
  initAssigned: InitAssignedSelfProperties;
  cellDataAccesses: CellDataKeyAccess[];
}

/** 本地扫描束(兜底与缺省路径;Rust 面同形供给,判定核零分叉) */
export function scanBundleOf(text: string): PropertyDirectionScanBundle {
  return {
    accesses: findPythonSelfPropertyAccesses(text),
    initAssigned: findInitAssignedSelfProperties(text),
    cellDataAccesses: findCellDataKeyAccesses(text)
  };
}

/**
 * 属性方向违规判定(纯函数):每处 self.<prop> / self.<role>.<prop> 访问,
 * 属性在 def 有声明(解析器命中)且访问域不在 Flags 域位内 → Warning;
 * 无接收者的裸 self.<prop> 且文件作用域不足 → Information(降级,不标 Error)。
 * 解析器未命中(非 def 属性/纯 python 属性)一律跳过,不诊断。
 * bundle 缺省本地扫描;Rust 面(buildPropertyDirectionScanBundleWithRust)同形
 * 供给时判定核逐位同语义(两流完整保留,消息渲染留本模块)。
 */
export function findPropertyDirectionFindings(
  text: string,
  filePath: string,
  resolve: (propertyPath: string, rootSymbol: string) => PropertyDirectionHit | null | undefined,
  bundle: PropertyDirectionScanBundle = scanBundleOf(text)
): PropertyDirectionFinding[] {
  const fileScope = inferProcessScopeFromPythonFile(filePath);
  const initAssigned = bundle.initAssigned;
  const findings: PropertyDirectionFinding[] = [];
  // 复制属性提示已覆盖的裸访问(行\u0000名):赋值行 LHS 若同时被访问扫描
  // 命中,赋值位提示不重复出
  const emitted = new Set<string>();

  for (const access of bundle.accesses) {
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
      // 无接收者且文件作用域不足(不在六角色目录段):降级为参考信息
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
          'Cannot determine the process scope of {path} (file not under scripts/base|baseapp|cell|cellapp|client|bots); direction check downgraded to reference info (not Error)',
          { path: propertyPath }
        )
      });
      continue;
    }

    if (domains.length === 0) {
      continue; // Flags 未配置 → 无域位可判,不发明方向
    }
    if (!domains.includes(accessedDomain)) {
      // 误报治理:同文件 __init__ 里给同名属性赋值 = 脚本自维护影子属性,
      // 引擎域外裸访问落到实例 __dict__ 的影子值上,不再是失效引用——不标
      // Warning(用户令「不要下划线」);右侧取自 self.cellData 的进一步出
      // 「复制属性」提示(带 key/类型/域位,用户令「就提示复制属性开头」);
      // 接收者限定形式(self.base.x 等)不走实体属性解析,影子不生效,维持原判。
      const shadowRoot = propertyPath.split('.')[0];
      if (!receiver && initAssigned.names.has(shadowRoot)) {
        const cellKey = initAssigned.cellDataCopyKeys.get(shadowRoot);
        if (cellKey !== undefined) {
          emitted.add(`${access.line}\u0000${shadowRoot}`);
        }
        findings.push({
          line: access.line,
          character: charStart,
          length: propertyPath.length,
          propertyPath,
          receiver,
          fileScope,
          domains,
          severity: 'Information',
          code: cellKey !== undefined
            ? PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE
            : PROPERTY_DIRECTION_SHADOW_DIAGNOSTIC_CODE,
          ...(cellKey !== undefined
            ? {
              cellDataKey: cellKey,
              endCharacter: charStart + propertyPath.length,
              typeName: hit.typeName,
              defFile: hit.defFile,
              defLine: hit.defLine,
              message: l10nText(
                'base-side copy of the cell def field {key} — assigned in __init__ from self.cellData; the engine syncs {key} only to the {domains} domain, reads here see the copy',
                { key: cellKey, domains: domainLabel(domains) }
              )
            }
            : {
              message: l10nText(
                'self.{path} is assigned in __init__ — script-maintained attribute shadowing the def field (the engine syncs {path} only to the {domains} domain)',
                { path: propertyPath, domains: domainLabel(domains) }
              )
            })
        });
        continue;
      }
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

  // 复制属性提示(赋值位):self.y = self.cellData["x"] 的 self.y 之后渲染
  // key 的 def 面——裸访问提示已覆盖同一行同名时不重复出(用户令「就提示
  // 复制属性开头」);右侧非 cellData 的赋值暂不展示(用户令「暂时复制属性」)。
  for (const [name, site] of initAssigned.sites) {
    const key = initAssigned.cellDataCopyKeys.get(name);
    if (key === undefined || emitted.has(`${site.line}\u0000${name}`)) {
      continue;
    }
    const keyHit = resolve(key, key);
    if (!keyHit || keyHit.domains.length === 0) {
      continue; // 键不是 def 属性 / Flags 未配置 → def 面不可知,宁缺勿错
    }
    findings.push({
      line: site.line,
      character: site.character - name.length,
      length: name.length,
      propertyPath: name,
      domains: keyHit?.domains ?? [],
      severity: 'Information',
      code: PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE,
      cellDataKey: key,
      endCharacter: site.character,
      typeName: keyHit?.typeName,
      defFile: keyHit?.defFile,
      defLine: keyHit?.defLine,
      message: l10nText(
        'base-side copy of the cell def field {key} — assigned in __init__ from self.cellData; the engine syncs {key} only to the {domains} domain, reads here see the copy',
        { key, domains: domainLabel(keyHit?.domains ?? []) }
      )
    });
  }

  // cellData 键提示:self.cellData["key"] 的 key 逐个对 def 解析——def 键渲染
  // key 的 def 面(key: 类型 · 域位),域位不含 cell 追加「不在 cellData」
  // (引擎不会把它放进 cellData);非 def 键(position/direction 引擎自塞键、
  // 脚本自塞键)一律跳过,不发明。
  for (const access of bundle.cellDataAccesses) {
    const hit = resolve(access.key, access.key);
    if (!hit || hit.domains.length === 0) {
      continue; // 非 def 键 / Flags 未配置 → 无域位可判,不发明
    }
    const carries = hit.domains.includes('cell');
    findings.push({
      line: access.line,
      character: access.character,
      length: access.length,
      propertyPath: access.key,
      domains: hit.domains,
      severity: 'Information',
      code: PROPERTY_DIRECTION_CELL_DATA_KEY_DIAGNOSTIC_CODE,
      cellDataKey: access.key,
      endCharacter: access.accessEnd,
      typeName: hit.typeName,
      defFile: hit.defFile,
      defLine: hit.defLine,
      message: carries
        ? l10nText(
          'cellData["{key}"] carries the {domains} def field — the cell side writes it, base reads the copy here',
          { key: access.key, domains: domainLabel(hit.domains) }
        )
        : l10nText(
          'cellData["{key}"] never carries this def field: the {domains} domain set has no cell part, so the engine does not put it into cellData',
          { key: access.key, domains: domainLabel(hit.domains) }
        )
    });
  }
  findings.sort((left, right) =>
    left.line - right.line || left.character - right.character
  );
  return findings;
}

/** 提示流(下划线之外)出哪些码;诊断流只出违规与作用域不足 */
const HINT_STREAM_CODES = new Set([
  PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_CELL_DATA_KEY_DIAGNOSTIC_CODE
]);

const DIAGNOSTIC_STREAM_CODES = new Set([
  PROPERTY_DIRECTION_VIOLATION_DIAGNOSTIC_CODE,
  PROPERTY_DIRECTION_SCOPE_UNKNOWN_DIAGNOSTIC_CODE
]);

/**
 * 提示短文案(用户令「就提示复制属性开头」):复制属性 =
 * 「复制属性 key: 类型 · cell」;cellData 键 = 「key: 类型 · cell」。
 * 标签展示 cell 面(用户令 2026-11-11:base 侧读到的就是 cell 侧同步来的
 * 那份,裸并集 cell|client 是噪音);域位不含 cell 保持原域位并追加
 * 「不在 cellData」(引擎不会把它放进 cellData,副本永远读不到值)。
 * 完整域位并集留悬停全文(诊断消息同源),不丢信息。
 */
export function shadowHintLabelOf(finding: PropertyDirectionFinding): string {
  const inCellData = finding.domains.includes('cell');
  const detail =
    (finding.typeName ? `: ${finding.typeName}` : '') +
    (finding.domains.length > 0 ? ` · ${inCellData ? 'cell' : domainLabel(finding.domains)}` : '');
  if (finding.code === PROPERTY_DIRECTION_CELL_DATA_COPY_DIAGNOSTIC_CODE) {
    const label = l10nText('copied property {key}{detail}', {
      key: finding.cellDataKey ?? finding.propertyPath,
      detail
    });
    return inCellData ? label : `${label} · ${l10nText('not in cellData')}`;
  }
  const label = l10nText('{key}{detail}', {
    key: finding.cellDataKey ?? finding.propertyPath,
    detail
  });
  return inCellData ? label : `${label} · ${l10nText('not in cellData')}`;
}

/** 一条淡色内嵌提示的纯数据形态(provider 层转 vscode.InlayHint,测试免 vscode 依赖) */
export interface PropertyDirectionShadowHintItem {
  /** 锚点(self.<名> token / cellData 访问表达式之后) */
  position: { line: number; character: number };
  /** 短文案(「复制属性 …」/「key: 类型 · cell」) */
  label: string;
  /** 悬停全文(诊断级解释同源,完整域位并集在此) */
  tooltip: string;
  code: string;
  /** def 声明落点(文件路径 + 0 起行;导航面与非复制提示 F12 一致,解析未命中不带) */
  location?: { uri: string; line: number };
}

/**
 * 提示流入口(同步):开关口 enabled=false 零产出;只出复制属性与
 * cellData 键两类淡色内嵌提示,永不出下划线(用户令)。
 */
export function propertyDirectionShadowHintItems(
  text: string,
  filePath: string,
  resolve: (propertyPath: string, rootSymbol: string) => PropertyDirectionHit | null | undefined,
  enabled: boolean
): PropertyDirectionShadowHintItem[] {
  if (!enabled) {
    return [];
  }
  return findPropertyDirectionFindings(text, filePath, resolve)
    .filter(finding => HINT_STREAM_CODES.has(finding.code))
    .map(finding => ({
      position: {
        line: finding.line,
        character: finding.endCharacter ?? finding.character + finding.length
      },
      label: shadowHintLabelOf(finding),
      tooltip: finding.message,
      code: finding.code,
      ...(finding.defFile !== undefined && finding.defLine !== undefined
        ? { location: { uri: finding.defFile, line: finding.defLine } }
        : {})
    }));
}

/**
 * 异步面:先按 (propertyPath, rootSymbol) 预解析全部去重访问(异步解析器,
 * 如 EntityMappingManager.resolvePropertyDefinitionInfo),再以同步查表
 * 解析器走 findPropertyDirectionFindings——纯判定逻辑零重复,与属性 CodeLens
 * 的「同一属性多处访问只解析一次」同口径。bundle 缺省本地扫描;Rust 面同形
 * 供给时预解析与判定核走同一束(零双扫)。
 */
export async function findPropertyDirectionFindingsAsync(
  text: string,
  filePath: string,
  resolve: (
    propertyPath: string,
    rootSymbol: string
  ) => Promise<PropertyDirectionHit | null | undefined>,
  bundle: PropertyDirectionScanBundle = scanBundleOf(text)
): Promise<PropertyDirectionFinding[]> {
  const cache = new Map<string, PropertyDirectionHit | null>();
  const syncResolve = (
    propertyPath: string,
    rootSymbol: string
  ): PropertyDirectionHit | null | undefined => cache.get(`${propertyPath}\u0000${rootSymbol}`);

  for (const access of bundle.accesses) {
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
  // cellData 键与复制属性键也预解析:同步核同样走 resolve,漏预解析会让
  // 缓存未命中(get 返回 undefined)被当「非 def 属性」静默跳过
  const cellKeys = new Set<string>([
    ...bundle.cellDataAccesses.map(access => access.key),
    ...bundle.initAssigned.cellDataCopyKeys.values()
  ]);
  for (const key of cellKeys) {
    const cacheKey = `${key}\u0000${key}`;
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, (await resolve(key, key)) ?? null);
    }
  }
  return findPropertyDirectionFindings(text, filePath, syncResolve, bundle);
}

/**
 * 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖):
 * 只出真违规(Warning)与作用域不足(Information);影子/复制属性/cellData
 * 键走提示流(见 propertyDirectionShadowHintItems),不出下划线。
 */
export function propertyDirectionDiagnosticItems(
  text: string,
  filePath: string,
  resolve: (propertyPath: string, rootSymbol: string) => PropertyDirectionHit | null | undefined,
  enabled: boolean
): PropertyDirectionDiagnosticItem[] {
  if (!enabled) {
    return [];
  }
  return findPropertyDirectionFindings(text, filePath, resolve)
    .filter(finding => DIAGNOSTIC_STREAM_CODES.has(finding.code))
    .map(finding => ({
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

/** 提示流入口(异步):预解析去重后同步判定,与诊断流同一份分析核;bundle 缺省本地扫描(Rust 面同形供给时零双扫,批 7) */
export async function propertyDirectionShadowHintItemsAsync(
  text: string,
  filePath: string,
  resolve: (
    propertyPath: string,
    rootSymbol: string
  ) => Promise<PropertyDirectionHit | null | undefined>,
  enabled: boolean,
  bundle?: PropertyDirectionScanBundle
): Promise<PropertyDirectionShadowHintItem[]> {
  if (!enabled) {
    return [];
  }
  return findPropertyDirectionFindingsAsync(text, filePath, resolve, bundle)
    .then(findings => findings
      .filter(finding => HINT_STREAM_CODES.has(finding.code))
      .map(finding => ({
        position: {
          line: finding.line,
          character: finding.endCharacter ?? finding.character + finding.length
        },
        label: shadowHintLabelOf(finding),
        tooltip: finding.message,
        code: finding.code,
        ...(finding.defFile !== undefined && finding.defLine !== undefined
          ? { location: { uri: finding.defFile, line: finding.defLine } }
          : {})
      })));
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
  enabled: boolean,
  bundle?: PropertyDirectionScanBundle
): Promise<PropertyDirectionDiagnosticItem[]> {
  if (!enabled) {
    return [];
  }
  return findPropertyDirectionFindingsAsync(text, filePath, resolve, bundle)
    .then(findings => findings
      .filter(finding => DIAGNOSTIC_STREAM_CODES.has(finding.code))
      .map(finding => ({
        range: {
          start: { line: finding.line, character: finding.character },
          end: { line: finding.line, character: finding.character + finding.length }
        },
        message: finding.message,
        severity: finding.severity,
        source: 'kbengine' as const,
        code: finding.code
      })));
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
