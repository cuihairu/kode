// QA-001a(2026-11-21):实体脚本基类合法性 + 类名一致性检查面(实体脚本基类面)。
// 引擎两条硬闸(判例源 docs/knowledge/entity-script-base-class.md,引擎头
// 55a66552):
//   - 类名闸:实体模块 `{entityName}.py` 必须暴露与模块名同名的类
//     (EntityDef::initialize → PyObject_GetAttrString(pyModule, moduleName);
//     取不到 → "Could not find EntityClass[{}]" → 装载失败);
//   - 基类闸:实体类经 PyObject_IsSubclass 对组件名册任一基类为真即通过
//     (registerScript(Entity/Proxy/EntityComponent::getScriptType()));
//     无任何基类 → 对名册全假 → "not derived from KBEngine.[...]" → 失败。
//
// 本面如实覆盖可证子集,绝不冒充全判:
//   - 类名闸:模块命名空间「绑定该名」才放行(定义类/模块级实例赋值/
//     import 绑定均可——GetAttrString 取到即过),三者皆无才报。别名/
//     import 形态绝不误报;
//   - 基类闸:仅对**可证非法**形态报——实体类**无任何直接基类**且当前组件
//     名册非空(cellapp/baseapp;任何非空名册对无基类全假)。有基类(含
//     未解析内建基类别名)不报(无法证明非法——基类可能经 MRO 解析到
//     KBEngine 内建);client 名册未取证 → 基类闸不跑(不猜);面未知/歧义
//     → 类名闸照跑(引擎每个进程装载实体都查类名),基类闸不跑。
//
// 纯逻辑层,不 import vscode;面数据由调用方注入(与 roleMisuse 同源:目录域
// 优先 + def 归属唯一面)。Rust 面本族未收编(TS 同步路径,收编归后续批)。

import { parsePythonFile } from './pythonParser';
import { l10nText } from '../nlsRuntime';
import type { EntityComponentFace } from './entityBuiltinProperties';

export const ENTITY_SCRIPT_BASE_CLASS_DIAGNOSTIC_CODE = 'kbengine.entityScriptBaseClass';
export const ENTITY_SCRIPT_BASE_CLASS_DIAGNOSTICS_ENABLED_DEFAULT = true;

/**
 * 组件名册(引擎 registerScript 取证,判例 source entity-script-base-class.md):
 * cellapp=Entity+EntityComponent(cellapp.cpp)、baseapp=Entity+Proxy+EntityComponent
 * (baseapp.cpp);client 的 registerScript 机制与 server 同(c客户端装载实体类
 * 也过 IsSubclass),但清单内容未取证 → null=基类闸不断言;dbmgr 不在此面表
 * (getEntityComponentFacesForPythonFile 只回 baseapp/cellapp/client)。
 */
export const SCRIPT_BASE_ROSTER: Record<EntityComponentFace, readonly string[] | null> = {
  cellapp: ['KBEngine.Entity', 'KBEngine.EntityComponent'],
  baseapp: ['KBEngine.Entity', 'KBEngine.Proxy', 'KBEngine.EntityComponent'],
  client: null
};

/** 一处基类面发现(诊断面所需最小信息) */
export interface EntityScriptBaseClassFinding {
  /** 行(0 起) */
  line: number;
  /** 起始列(0 起) */
  character: number;
  /** 高亮长度 */
  length: number;
  kind: 'class-name-gate' | 'base-class-gate';
  entityName: string;
  /** 类名闸:模块内定义的类名清单(空 = 无类) */
  definedClasses: readonly string[];
  /** 基类闸:组件名册(cellapp/baseapp) */
  roster: readonly string[] | null;
  face: EntityComponentFace | null;
  message: string;
}

/**
 * 类名闸消息:模块名/模块内类清单取证,不猜。
 */
export function renderEntityClassNameGateMessage(
  fileName: string,
  entityName: string,
  definedClasses: readonly string[]
): string {
  return l10nText(
    'Entity script module must define a class named {entityName} (the engine loads {fileName} as the entity module and requires a class of the same name via GetAttrString; classes defined in this module: {classes})',
    {
      entityName,
      fileName,
      classes: definedClasses.length ? definedClasses.join(', ') : '(none)'
    }
  );
}

/**
 * 基类闸消息:无基类 + 非空名册取证,如实报引擎拒载口径。
 */
export function renderEntityBaseClassGateMessage(
  entityName: string,
  face: EntityComponentFace,
  roster: readonly string[]
): string {
  return l10nText(
    'Entity class {entityName} has no base class; the {face} component requires the entity class to derive from one of {roster} (engine isSubClass against the component roster rejects a class with no base)',
    { entityName, face, roster: roster.join(', ') }
  );
}

/**
 * 基类面判定(纯函数):类名闸 + 基类闸。face=null(面未知/歧义)→ 只跑
 * 类名闸;face='client'(名册未取证)→ 类名闸照跑,基类闸不跑。调用方须先
 * 确认该文件是实体模块文件(`{entityName}.py`,basename==entityName)才调用。
 */
export function findEntityScriptBaseClassFindings(
  text: string,
  fileName: string,
  entityName: string,
  face: EntityComponentFace | null
): EntityScriptBaseClassFinding[] {
  const parsed = parsePythonFile(text, `/w/scripts/${fileName}`);
  const definedClasses = parsed.classes.map(cls => cls.name);
  const entityClass = parsed.classes.find(cls => cls.name === entityName);
  // 模块命名空间是否绑定实体名(定义类/模块级实例赋值/import 绑定任一
  // 即 GetAttrString 取得到,引擎放行——绝不误报别名/import 形态)。
  const nameBound =
    entityClass !== undefined ||
    parsed.imports?.has(entityName) === true ||
    parsed.instanceAssignments.some(assign => assign.variable === entityName);

  const findings: EntityScriptBaseClassFinding[] = [];
  if (!nameBound) {
    // 类名闸:高亮首个类定义行(改名处);无类 → 0,0。
    const line = parsed.classes.length ? parsed.classes[0].startLine : 0;
    findings.push({
      line,
      character: 0,
      length: Math.max(entityName.length, 8),
      kind: 'class-name-gate',
      entityName,
      definedClasses,
      roster: null,
      face,
      message: renderEntityClassNameGateMessage(fileName, entityName, definedClasses)
    });
    // 引擎在类名闸先失败(装载失败),基类闸不可达,不再叠报。
    return findings;
  }
  // 基类闸:无直接基类 + 名册非空(cellapp/baseapp)→ 对名册全假,可证非法。
  const roster = face ? SCRIPT_BASE_ROSTER[face] : null;
  if (roster !== null && roster.length > 0 && entityClass !== undefined &&
      entityClass.bases.length === 0) {
    findings.push({
      line: entityClass.startLine,
      character: 0,
      length: Math.max(entityClass.name.length, 8),
      kind: 'base-class-gate',
      entityName,
      definedClasses,
      roster,
      face,
      message: renderEntityBaseClassGateMessage(entityName, face!, roster)
    });
  }
  return findings;
}

/** 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖) */
export interface EntityScriptBaseClassDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/** findings → 诊断项(纯数据;test 免 vscode) */
export function entityScriptBaseClassFindingsToItems(
  findings: readonly EntityScriptBaseClassFinding[]
): EntityScriptBaseClassDiagnosticItem[] {
  return findings.map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning' as const,
    source: 'kbengine' as const,
    code: ENTITY_SCRIPT_BASE_CLASS_DIAGNOSTIC_CODE
  }));
}
