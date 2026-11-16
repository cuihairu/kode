// RUST-175 entities.xml 注册完整性审计(纯核,零 vscode,输入注入)。
// 引擎真源锚(kbengine kbe/src):
// - entitydef.cpp:199-210:每条 entities.xml 条目 registerNewScriptDefModule 后
//   openSection(<name>.def),打开失败即 return false——引擎启动中止;唯一
//   的 .def 装载环也在条目内,清单外 .def 永不注册(utype 只在
//   registerNewScriptDefModule,entitydef.cpp:253-265 分配),运行期
//   createEntity 走 findScriptModule 落空。
// - scriptdef_module.cpp:330-510 autoMatchCompOwn:face 存在性 = 脚本在盘 ×
//   entities.xml 显式声明;脚本缺失且无显式 false 声明时引擎仍视该部分存在
//   (scriptdef_module.cpp:452-460 base,cell 同构),对应进程 import 模块
//   失败即中止启动(entitydef.cpp:2273-2280,isLoadScriptModule:1741-1779);
//   显式 hasBase/hasCell="false" 是干净的豁出口。
// - client 面有 def-context 覆写(scriptdef_module.cpp:366-373),本审计不
//   裁定,如实排除;方法一致性(C-19 def-method-missing-in-python)与重复
//   条目(KBE-DEF-009 duplicate-entity-name)已有交付面,不重复。
// 条目解析复用 entitiesXmlAnalysis 的两种在野格式口径(平铺+分节透明下钻)。

import {
  collectEntityEntries,
  ENTITIES_XML_SECTIONS
} from './entitiesXmlAnalysis';
import { parseDefDocument } from './defParser';

export type EntitiesRegistrationCheck =
  | 'entry-without-def'
  | 'def-without-entry'
  | 'face-script-missing';

export type EntitiesRegistrationFace = 'base' | 'cell';

/** 审计发现:只记事实,位置只在有真锚点时给出(绝不伪造行)。 */
export interface EntitiesRegistrationFinding {
  check: EntitiesRegistrationCheck;
  severity: 'error' | 'warning';
  /** 实体名(def-without-entry 时为 .def 基名) */
  entity: string;
  /** face-script-missing 时的面;其余 null */
  face: EntitiesRegistrationFace | null;
  /** 条目开标签在 entities.xml 内的 0 基区间(仅 entry 锚定面);其余 null */
  offset: number | null;
  length: number | null;
}

export interface EntitiesRegistrationAuditInput {
  /** entities.xml 原文(活编辑器文本;解析失败=诚实空结果,不虚构) */
  entitiesXmlText: string;
  /** entity_defs 下 *.def 基名(无扩展名,清单对照用) */
  defNames: readonly string[];
  /** scripts/base 下 <Name>.py|.pyc 在盘的基名集合(引擎 matchRes 口径含 pyc) */
  baseScriptNames: ReadonlySet<string>;
  /** scripts/cell 下 <Name>.py|.pyc 在盘的基名集合 */
  cellScriptNames: ReadonlySet<string>;
}

/** face 是否由引擎视为存在:autoMatchCompOwn 口径——显式声明听声明的,
 * 否则一律视为存在(脚本缺失也不例外,interface 可能携带该面内容)。 */
const faceActive = (declared: boolean, declaredValue: boolean): boolean =>
  declared ? declaredValue : true;

/**
 * 注册完整性审计:
 * - entry-without-def(error):条目无对应 <Name>.def——引擎启动中止;
 * - def-without-entry(warning):.def 未入清单——永不注册,不可 createEntity;
 * - face-script-missing(warning):face 视为存在而脚本缺失且无显式 false
 *   豁免——对应进程 import 失败会中止启动。
 * 重复条目按引擎同口径取首条(registerNewScriptDefModule 合并语义),
 * 不在此重复 KBE-DEF-009 的诊断职责。
 */
export function auditEntitiesRegistration(
  input: EntitiesRegistrationAuditInput
): EntitiesRegistrationFinding[] {
  let entries: ReturnType<typeof collectEntityEntries>;
  try {
    const document = parseDefDocument(input.entitiesXmlText);
    if (!document.root) {
      return [];
    }
    entries = collectEntityEntries(document.root);
  } catch {
    // 活编辑器文本可能中途不完整:解析失败静默空结果,不虚构发现
    return [];
  }

  const defNames = new Set(input.defNames);
  const findings: EntitiesRegistrationFinding[] = [];
  const registeredNames = new Set<string>();

  for (const entryNode of entries) {
    const name = entryNode.name;
    if (name === 'root' || ENTITIES_XML_SECTIONS.has(name) || registeredNames.has(name)) {
      continue;
    }
    registeredNames.add(name);

    if (!defNames.has(name)) {
      findings.push({
        check: 'entry-without-def',
        severity: 'error',
        entity: name,
        face: null,
        offset: entryNode.tagStart,
        length: entryNode.tagEnd - entryNode.tagStart
      });
    }

    const attributes = entryNode.attributes;
    const baseActive = faceActive(
      Object.prototype.hasOwnProperty.call(attributes, 'hasBase'),
      String(attributes.hasBase ?? '').trim().toLowerCase() === 'true'
    );
    const cellActive = faceActive(
      Object.prototype.hasOwnProperty.call(attributes, 'hasCell'),
      String(attributes.hasCell ?? '').trim().toLowerCase() === 'true'
    );
    if (baseActive && !input.baseScriptNames.has(name)) {
      findings.push({
        check: 'face-script-missing',
        severity: 'warning',
        entity: name,
        face: 'base',
        offset: entryNode.tagStart,
        length: entryNode.tagEnd - entryNode.tagStart
      });
    }
    if (cellActive && !input.cellScriptNames.has(name)) {
      findings.push({
        check: 'face-script-missing',
        severity: 'warning',
        entity: name,
        face: 'cell',
        offset: entryNode.tagStart,
        length: entryNode.tagEnd - entryNode.tagStart
      });
    }
  }

  for (const defName of [...input.defNames].sort()) {
    if (!registeredNames.has(defName)) {
      findings.push({
        check: 'def-without-entry',
        severity: 'warning',
        entity: defName,
        face: null,
        offset: null,
        length: null
      });
    }
  }

  return findings;
}

/** 一次审计的清单事实(渲染头部用)。 */
export interface EntitiesRegistrationAuditStats {
  registered: number;
  defFiles: number;
  baseScripts: number;
  cellScripts: number;
}

export function collectAuditStats(input: EntitiesRegistrationAuditInput): EntitiesRegistrationAuditStats {
  const registered = new Set<string>();
  try {
    const document = parseDefDocument(input.entitiesXmlText);
    if (document.root) {
      for (const entryNode of collectEntityEntries(document.root)) {
        if (entryNode.name === 'root' || ENTITIES_XML_SECTIONS.has(entryNode.name)) {
          continue;
        }
        registered.add(entryNode.name);
      }
    }
  } catch {
    // 解析失败时 registered 保持 0,渲染如实按「无法解析」呈现
  }
  return {
    registered: registered.size,
    defFiles: input.defNames.length,
    baseScripts: input.baseScriptNames.size,
    cellScripts: input.cellScriptNames.size
  };
}

/** 审计报告渲染(输出通道用,整段可复制;双语走 ideLanguage 先例)。 */
export function renderEntitiesRegistrationAudit(
  findings: readonly EntitiesRegistrationFinding[],
  stats: EntitiesRegistrationAuditStats | null,
  ideLanguage?: string
): string {
  const zh = ideLanguage?.startsWith('zh');
  const lines: string[] = [];
  lines.push(zh ? 'entities.xml 注册完整性审计' : 'entities.xml registration audit');
  lines.push('======================================');
  if (stats) {
    lines.push(
      zh
        ? `清单登记 ${stats.registered} / .def 文件 ${stats.defFiles} / base 脚本 ${stats.baseScripts} / cell 脚本 ${stats.cellScripts}`
        : `registered ${stats.registered} / .def files ${stats.defFiles} / base scripts ${stats.baseScripts} / cell scripts ${stats.cellScripts}`
    );
  }
  if (findings.length === 0) {
    lines.push(zh ? '未发现注册完整性问题。' : 'No registration integrity issues found.');
    return lines.join('\n');
  }
  for (const finding of findings) {
    const location = finding.offset !== null
      ? (zh ? `（entities.xml 偏移 ${finding.offset}）` : ` (entities.xml offset ${finding.offset})`)
      : '';
    if (finding.check === 'entry-without-def') {
      lines.push(
        zh
          ? `[error] 实体 ${finding.entity} 在 entities.xml 已登记,但 entity_defs/${finding.entity}.def 不存在——引擎启动时打开该 def 失败即中止(entitydef.cpp:207-210)${location}`
          : `[error] entity ${finding.entity} is registered in entities.xml but entity_defs/${finding.entity}.def is missing — the engine aborts startup when this def fails to open (entitydef.cpp:207-210)${location}`
      );
    } else if (finding.check === 'def-without-entry') {
      lines.push(
        zh
          ? `[warning] entity_defs/${finding.entity}.def 存在,但未登记进 entities.xml——def 只按清单装载(entitydef.cpp:199-210),该实体不会获得 utype(entitydef.cpp:253-265),运行期 createEntity 将找不到此类型`
          : `[warning] entity_defs/${finding.entity}.def exists but is not listed in entities.xml — defs load per manifest only (entitydef.cpp:199-210), the entity never gets a utype (entitydef.cpp:253-265) and createEntity will not find this type at runtime`
      );
    } else {
      const face = finding.face ?? '';
      lines.push(
        zh
          ? `[warning] 实体 ${finding.entity} 的 ${face} 面视为存在,但 scripts/${face}/${finding.entity}.py 未找到——引擎在脚本缺失且无显式 false 声明时仍视该部分存在(scriptdef_module.cpp:452-460),对应进程 import 失败会中止启动(entitydef.cpp:2273-2280);确认不需要该面时在 entities.xml 显式声明 has${face === 'base' ? 'Base' : 'Cell'}="false"${location}`
          : `[warning] entity ${finding.entity} has an active ${face} face but scripts/${face}/${finding.entity}.py was not found — the engine treats the face as present when the script is missing without an explicit false (scriptdef_module.cpp:452-460); an import failure on that process aborts startup (entitydef.cpp:2273-2280). Declare has${face === 'base' ? 'Base' : 'Cell'}="false" explicitly if the face is not needed${location}`
      );
    }
  }
  return lines.join('\n');
}
