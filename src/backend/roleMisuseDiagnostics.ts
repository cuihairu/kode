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
import {
  getEntityBuiltinPropertiesForFace,
  resolveEntityComponentFaceFromPath,
  type EntityComponentFace
} from './entityBuiltinProperties';

export const ROLE_MISUSE_DIAGNOSTIC_CODE = 'kbengine.roleMisuse';
export const ROLE_MISUSE_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 各面属性名集(数据源同 hover 属性表;面=null 时宏公共 3 各面都注册) */
const FACE_PROPERTY_NAMES: Record<EntityComponentFace, Set<string>> = {
  baseapp: new Set(getEntityBuiltinPropertiesForFace('baseapp').map(p => p.name)),
  cellapp: new Set(getEntityBuiltinPropertiesForFace('cellapp').map(p => p.name)),
  client: new Set(getEntityBuiltinPropertiesForFace('client').map(p => p.name))
};

/** 全部面注册过的内建属性名(含各自宏公共/客户端宏条目) */
const ALL_BUILTIN_PROPERTY_NAMES = new Set<string>([
  ...FACE_PROPERTY_NAMES.baseapp,
  ...FACE_PROPERTY_NAMES.cellapp,
  ...FACE_PROPERTY_NAMES.client
]);

/** 属性注册的面列表(定序 baseapp → cellapp → client) */
function facesRegistering(propertyName: string): EntityComponentFace[] {
  return (['baseapp', 'cellapp', 'client'] as const).filter(face =>
    FACE_PROPERTY_NAMES[face].has(propertyName)
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
 * 角色错用判定(纯函数):掩码文本上扫单段 `self.<属性>`,属性注册于其他面
 * 而当前面没有 → Warning;非实体脚本/角色不明/非内建属性跳过。
 * pathFace 与 defFaces 由调用方提供(与内建属性 hover 同源面判定)。
 */
export function findRoleMisuseFindings(
  text: string,
  pathFace: EntityComponentFace | null,
  defFaces: readonly EntityComponentFace[] | null
): RoleMisuseFinding[] {
  // 非实体脚本:目录域无面且无 def 归属 → 不接管(普通 Python 类不猜)
  const isEntityScript = pathFace !== null || (defFaces !== null && defFaces.length > 0);
  if (!isEntityScript) {
    return [];
  }
  // 目录域优先;无目录域时 def 归属唯一面生效,多面歧义 → 不猜(零产出)
  const face =
    pathFace ??
    (defFaces !== null && defFaces.length === 1 ? defFaces[0] : null);
  if (face === null) {
    return [];
  }

  const masked = maskPythonNonCode(text);
  const lines = masked.split(/\r?\n/);
  const findings: RoleMisuseFinding[] = [];
  const pattern = /\bself\.(\w+)(?![\w.])/g;

  for (let line = 0; line < lines.length; line += 1) {
    const lineText = lines[line];
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lineText)) !== null) {
      const propertyName = match[1];
      // 当前面注册 → 正常访问,不报
      if (FACE_PROPERTY_NAMES[face].has(propertyName)) {
        continue;
      }
      // 任何面都没注册(非内建)→ 落回 def/普通符号,不报
      if (!ALL_BUILTIN_PROPERTY_NAMES.has(propertyName)) {
        continue;
      }
      // 内建但当前面没有 → 角色错用
      const registeredFaces = facesRegistering(propertyName);
      const source = sourceFor(propertyName, registeredFaces);
      findings.push({
        line,
        character: match.index,
        length: match[0].length,
        propertyName,
        currentFace: face,
        registeredFaces,
        source,
        message: l10nText(
          'self.{property} role misuse: current {face} entity has no {property} property (registered on {faces}; engine registration: {source}); {face}-side access will not hit that engine property',
          {
            property: propertyName,
            face,
            faces: registeredFaces.join('/'),
            source
          }
        )
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

/**
 * 异步入口:pathFace 按目录域定面;pathFace 判不出时经 fetchDefFaces(通常
 * entityMappingManager.getEntityComponentFacesForPythonFile)取 def 归属面
 * (与内建属性 inlay provider 同源),失败按 null 兜底(非实体 → 零产出)。
 * enabled=false 零产出。
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
  return findRoleMisuseFindings(text, pathFace, defFaces).map(finding => ({
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
