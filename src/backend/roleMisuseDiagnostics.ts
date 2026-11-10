// IDE-LINT-009:已确认角色的引擎内建属性错用 lint(KBE-PY-008 诊断面)——实体
// 脚本里 `self.<内建属性>` 访问当前角色面不注册该属性(注册于其他面)时报
// Warning;角色不明与普通 Python 类不猜。
//
// 纯逻辑层,不 import vscode。角色判定与内建属性 hover/inlay 同一底座同一
// 口径(resolveEntityComponentFaceFromPath 目录域 + getEntityComponentFacesFor
// PythonFile def 归属,见 entityBuiltinProperties §4-3);数据源复用同一张引擎
// 属性表(getEntityBuiltinPropertiesForFace)——hover 元数据与 lint 共用来源。
//
// 判定:
//   - 非实体脚本(pathFace null 且 defFaces null)→ 不接管(普通 Python 类不猜);
//   - 角色不明(pathFace null 且 defFaces 空/多面歧义)→ 不猜(多面歧义只给宏
//     公共 3,而那 3 项各面都注册,不可能错用 → 零产出);
//   - 当前面注册该属性 → 正常访问,不报;
//   - 属性不在当前面但在其他面注册 → 角色错用,报 Warning(引注册面取证);
//   - 属性任何面都没注册(不是内建)→ 落回 def/普通符号,不报。
//
// 已知边界(与同族 self-属性 lint 一致):嵌套非实体类内的同名 self.<p> 不单列
// (文件级实体身份判定);引擎实体 API(方法,如 teleport/addTimer)的角色面表
// 尚未建立——本 lint 只对属性面表有据可查的错用报,API 错用保持仅提示(hover/
// 补全元数据),不冒充已实现;`self.<prop>` 仅单段(self.cell.X 等多段访问
// 不参与——那是 EntityCall 成员面,由 receiver/段错配负责)。

import { maskPythonNonCode } from './pythonLexicalMask';
import { l10nText } from '../nlsRuntime';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  getEntityBuiltinPropertiesForFace,
  resolveEntityComponentFaceFromPath,
  type EntityComponentFace
} from './entityBuiltinProperties';

export const ROLE_MISUSE_DIAGNOSTIC_CODE = 'kbengine.roleMisuse';
export const ROLE_MISUSE_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 各面属性名表(数据源同 hover 属性表;面=null 时宏公共 3 各面都注册) */
export interface RoleMisuseTables {
  baseapp: readonly string[];
  cellapp: readonly string[];
  client: readonly string[];
}

/** 生产面表(TS 桥接给 Rust;与 FACE_PROPERTY_NAMES 同源单点) */
export const ROLE_MISUSE_TABLES: RoleMisuseTables = {
  baseapp: getEntityBuiltinPropertiesForFace('baseapp').map(p => p.name),
  cellapp: getEntityBuiltinPropertiesForFace('cellapp').map(p => p.name),
  client: getEntityBuiltinPropertiesForFace('client').map(p => p.name)
};

/** 面表 → 面属性集(判定用;每调用重建,表小可忽略) */
function faceSetsOf(
  tables: RoleMisuseTables
): Record<EntityComponentFace, Set<string>> {
  return {
    baseapp: new Set(tables.baseapp),
    cellapp: new Set(tables.cellapp),
    client: new Set(tables.client)
  };
}

/** 属性注册的面列表(定序 baseapp → cellapp → client) */
function facesRegistering(
  faceSets: Record<EntityComponentFace, Set<string>>,
  propertyName: string
): EntityComponentFace[] {
  return (['baseapp', 'cellapp', 'client'] as const).filter(face =>
    faceSets[face].has(propertyName)
  );
}

/**
 * 消息渲染(单源模板;Rust 结构面与 TS 兜底共用,零模板漂移)。
 * source = 引擎注册取证(任一注册面源码;空 = 表内缺源)。
 */
export function renderRoleMisuseMessage(
  propertyName: string,
  face: EntityComponentFace,
  registeredFaces: readonly EntityComponentFace[],
  source: string
): string {
  return l10nText(
    'self.{property} role misuse: current {face} entity has no {property} property (registered on {faces}; engine registration: {source}); {face}-side access will not hit that engine property',
    {
      property: propertyName,
      face,
      faces: registeredFaces.join('/'),
      source
    }
  );
}

/** 该属性在任一注册面的引擎取证(引注册面源码;首面即够) */
function sourceFor(propertyName: string, faces: readonly EntityComponentFace[]): string {
  for (const face of faces) {
    const property = getEntityBuiltinPropertiesForFace(face)
      .find(item => item.name === propertyName);
    if (property) {
      return property.source;
    }
  }
  return '';
}

/** 一处角色错用访问(诊断面所需最小信息) */
export interface RoleMisuseFinding {
  /** 行(0 起) */
  line: number;
  /** `self` 起始列(0 起;高亮整个 `self.<name>`) */
  character: number;
  /** 高亮长度(`self.<name>` 全长) */
  length: number;
  propertyName: string;
  /** 当前文件角色面(目录域优先;def 归属唯一面) */
  currentFace: EntityComponentFace;
  /** 该属性实际注册的面(当前面不在其中) */
  registeredFaces: EntityComponentFace[];
  source: string;
  message: string;
}

/**
 * 当前文件角色面(目录域优先;无目录域时 def 归属唯一面生效,多面歧义与
 * 非实体脚本 → null,零产出)。与内建属性 hover 同源面判定。
 */
export function resolveRoleMisuseFace(
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null
): EntityComponentFace | null {
  // 非实体脚本:目录域无面且无 def 归属 → 不接管(普通 Python 类不猜)
  const isEntityScript = pathFace !== null || (defFaces !== null && defFaces.length > 0);
  if (!isEntityScript) {
    return null;
  }
  return pathFace ?? (defFaces !== null && defFaces.length === 1 ? defFaces[0] : null);
}

/**
 * 角色错用判定(纯函数):掩码文本上扫单段 `self.<属性>`,属性注册于其他面
 * 而当前面没有 → Warning;非实体脚本/角色不明/非内建属性跳过。
 * pathFace 与 defFaces 由调用方提供(与内建属性 hover 同源面判定)。
 * tables 为面属性名表(默认生产面表;测试可注入合成表,与 Rust 对拍同源)。
 */
export function findRoleMisuseFindings(
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null,
  tables: RoleMisuseTables = ROLE_MISUSE_TABLES
): RoleMisuseFinding[] {
  const face = resolveRoleMisuseFace(pathFace, defFaces);
  if (face === null) {
    return [];
  }

  const masked = maskPythonNonCode(text);
  const lines = masked.split(/\r?\n/);
  const faceSets = faceSetsOf(tables);
  const allBuiltin = new Set<string>([
    ...tables.baseapp,
    ...tables.cellapp,
    ...tables.client
  ]);
  const findings: RoleMisuseFinding[] = [];
  const pattern = /\bself\.(\w+)(?![\w.])/g;

  for (let line = 0; line < lines.length; line += 1) {
    const lineText = lines[line];
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lineText)) !== null) {
      const propertyName = match[1];
      // 当前面注册 → 正常访问,不报
      if (faceSets[face].has(propertyName)) {
        continue;
      }
      // 任何面都没注册(非内建)→ 落回 def/普通符号,不报
      if (!allBuiltin.has(propertyName)) {
        continue;
      }
      // 内建但当前面没有 → 角色错用
      const registeredFaces = facesRegistering(faceSets, propertyName);
      const source = sourceFor(propertyName, registeredFaces);
      findings.push({
        line,
        character: match.index,
        length: match[0].length,
        propertyName,
        currentFace: face,
        registeredFaces,
        source,
        message: renderRoleMisuseMessage(propertyName, face, registeredFaces, source)
      });
    }
  }
  return findings;
}

/** 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖) */
export interface RoleMisuseDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/** findings → 诊断项(纯数据;test 免 vscode;Rust 面与 TS 兜底共用) */
export function roleMisuseFindingsToItems(
  findings: readonly RoleMisuseFinding[]
): RoleMisuseDiagnosticItem[] {
  return findings.map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning' as const,
    source: 'kbengine' as const,
    code: ROLE_MISUSE_DIAGNOSTIC_CODE
  }));
}

// ---- Rust 面(AUDIT-005 B2 车道批 2:roleMisuse 收编) -------------------------
// `$/kode/lint/analyzeRoleMisuse` 经 gate.runInRust(命令面,与 analyzeTraps
// 同口径):Rust 只回结构面(code/line/character/length + propertyName/
// registeredFaces),消息渲染与引擎取证留 TS(模板单一来源 =
// renderRoleMisuseMessage,取证 = sourceFor)。Rust 不可用(无门/未配
// serverPath/调用失败)或应答畸形(任一条缺结构字段/缺 l10n 参数/语义矛盾)
// 整面作废回 TS 同步路径 —— 禁止部分采用(静默丢能力)。

/** Rust 结构面单条产物(`$/kode/lint/analyzeRoleMisuse` 应答) */
export interface RustRoleMisuseItem {
  code: string;
  line: number;
  character: number;
  length: number;
  propertyName: string;
  registeredFaces: string[];
}

const ROLE_MISUSE_RUST_METHOD = '$/kode/lint/analyzeRoleMisuse';

const VALID_FACES = new Set<EntityComponentFace>(['baseapp', 'cellapp', 'client']);

/**
 * 结构面数组 → 诊断面(消息渲染+引擎取证);任一条畸形/语义矛盾返回 null
 * (整面作废,调用方回 TS 兜底 —— 禁止部分采用)。对拍测试共用。
 * face = 当前面(消息与矛盾校验面);tables = 面表(非内建校验面)。
 */
export function renderRustRoleMisuseItems(
  items: unknown,
  face: EntityComponentFace,
  tables: RoleMisuseTables
): RoleMisuseDiagnosticItem[] | null {
  if (!Array.isArray(items)) {
    return null;
  }
  const allBuiltin = new Set<string>([
    ...tables.baseapp,
    ...tables.cellapp,
    ...tables.client
  ]);
  const rendered: RoleMisuseDiagnosticItem[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const item = raw as RustRoleMisuseItem;
    if (item.code !== ROLE_MISUSE_DIAGNOSTIC_CODE) {
      return null;
    }
    if (!Number.isInteger(item.line) || item.line < 0) {
      return null;
    }
    if (!Number.isInteger(item.character) || item.character < 0) {
      return null;
    }
    if (!Number.isInteger(item.length) || item.length < 0) {
      return null;
    }
    if (typeof item.propertyName !== 'string' || item.propertyName.length === 0) {
      return null;
    }
    if (!Array.isArray(item.registeredFaces)) {
      return null;
    }
    const registeredFaces: EntityComponentFace[] = [];
    for (const rf of item.registeredFaces) {
      if (typeof rf !== 'string' || !VALID_FACES.has(rf as EntityComponentFace)) {
        return null;
      }
      registeredFaces.push(rf as EntityComponentFace);
    }
    if (registeredFaces.length === 0) {
      return null; // 非内建(TS 不产),语义矛盾 → 作废
    }
    if (registeredFaces.includes(face)) {
      return null; // 当前面在注册面(TS 不产),语义矛盾 → 作废
    }
    if (!allBuiltin.has(item.propertyName)) {
      return null; // 非内建(TS 不产),语义矛盾 → 作废
    }
    const source = sourceFor(item.propertyName, registeredFaces);
    rendered.push({
      range: {
        start: { line: item.line, character: item.character },
        end: { line: item.line, character: item.character + item.length }
      },
      message: renderRoleMisuseMessage(item.propertyName, face, registeredFaces, source),
      severity: 'Warning' as const,
      source: 'kbengine' as const,
      code: ROLE_MISUSE_DIAGNOSTIC_CODE
    });
  }
  return rendered;
}

/**
 * Rust-first 角色错用产物:gate.runInRust 跑 `$/kode/lint/analyzeRoleMisuse`,
 * 结构面经 renderRustRoleMisuseItems 渲染;不可用/失败/畸形回 TS 兜底
 * findRoleMisuseFindings(既有行为不变)。
 */
export async function buildRoleMisuseItemsWithRust(
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null,
  deps: RoleMisuseComputeDeps
): Promise<RoleMisuseDiagnosticItem[]> {
  if (!deps.enabled) {
    return [];
  }
  const face = resolveRoleMisuseFace(pathFace, defFaces);
  if (face === null) {
    return [];
  }
  const gate = getKodeCoreShadowGate();
  if (gate) {
    const result = await gate.runInRust<{ items?: unknown }>(ROLE_MISUSE_RUST_METHOD, {
      text,
      face,
      facePropertyNames: {
        baseapp: deps.facePropertyNames.baseapp,
        cellapp: deps.facePropertyNames.cellapp,
        client: deps.facePropertyNames.client
      }
    });
    if (result.ok) {
      const items = renderRustRoleMisuseItems(result.result?.items, face, deps.facePropertyNames);
      if (items) {
        return items;
      }
    }
  }
  return roleMisuseFindingsToItems(
    findRoleMisuseFindings(text, pathFace, defFaces, deps.facePropertyNames)
  );
}

/** 构建期依赖(测试可注入) */
export interface RoleMisuseComputeDeps {
  /** 面属性名表(Rust 输入 + TS 兜底共用,与对拍同源) */
  facePropertyNames: RoleMisuseTables;
  enabled: boolean;
}

/**
 * 异步入口:pathFace 按目录域定面;pathFace 判不出时经 fetchDefFaces(通常
 * entityMappingManager.getEntityComponentFacesForPythonFile)取 def 归属面
 * (与内建属性 inlay provider 同源),失败按 null 兜底(非实体 → 零产出)。
 * enabled=false 零产出。Rust-first(经 buildRoleMisuseItemsWithRust),TS 兜底。
 */
export async function roleMisuseDiagnosticItemsAsync(
  text: string,
  filePath: string,
  fetchDefFaces: () => Promise<readonly EntityComponentFace[] | null>,
  enabled: boolean
): Promise<RoleMisuseDiagnosticItem[]> {
  if (!enabled) {
    return [];
  }
  const pathFace = resolveEntityComponentFaceFromPath(filePath);
  let defFaces: readonly EntityComponentFace[] | null = null;
  if (!pathFace) {
    try {
      defFaces = await fetchDefFaces();
    } catch {
      defFaces = null;
    }
  }
  return buildRoleMisuseItemsWithRust(text, pathFace, defFaces, {
    facePropertyNames: ROLE_MISUSE_TABLES,
    enabled
  });
}
