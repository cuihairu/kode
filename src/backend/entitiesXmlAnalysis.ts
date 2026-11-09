import {
  getDirectChildElements,
  parseDefDocument
} from './defParser';
import type { DefElementNode } from './defParser';

// entities.xml 清单静态分析(source-analysis 设计 D3)。引擎按清单顺序
// 给实体分配 utype(entitydef.cpp:253-265、2382-2396),同名重复条目则
// 按已有模块复用静默合并(registerNewScriptDefModule,
// entitydef.cpp:255-262)——第二条目及其属性断言不会生效,作者却毫无
// 感知。kode 对此产出 warning 诊断;清单顺序本身已由 getRegisteredEntities
// 按子节点序保真,悬停侧呈现序号(languageProviders)。

export type EntitiesXmlCheck = 'duplicate-entity-name';

export const ENTITIES_XML_DUPLICATE_CHECK: EntitiesXmlCheck = 'duplicate-entity-name';

export interface EntitiesXmlFinding {
  check: EntitiesXmlCheck;
  severity: 'warning';
  /** 0 基偏移与长度(诊断定位用,覆盖重复条目的整个开标签) */
  offset: number;
  length: number;
  /** 重复的实体名 */
  name: string;
  message: string;
}

// entities.xml 两种真实在野格式:
// ① 平铺(引擎自带 sdk 模板 kbe/res/sdk_templates/server/python_assets/scripts/entities.xml
//    与老脚本):`<root><Avatar hasBase="true"/></root>`,条目即 root 直接子节点;
// ② 分节(BigWorld entities.xml 语义,fantasydemo 等移植资产在用;取证:
//    KBEngine 2.5.10 引擎源码 kbe/src 全树无分节名,引擎本体不解析分节):
//    `<root><ClientServerEntities><Avatar/></ClientServerEntities>
//    <ServerOnlyEntities><Guard/></ServerOnlyEntities></root>`,条目在分节容器内一层。
// 只认平铺会让分节脚本整体漏检重复条目,故已知分节名透明下钻一层;
// 未识别的 root 直接子节点仍按条目处理(保持平铺口径向后兼容)。
// 注:分节→域位映射已按格式取证落在 getRegisteredEntities(C-13):
// 分节是 BigWorld entities.xml 语义(fork 2.5.10 引擎源码 kbe/src 无分节名,
// 见 fork docs/zh/study/05-entitydef-and-entity-definition.md:183-192),
// ClientServerEntities→hasClient=true、ServerOnlyEntities→hasClient=false
// (分组即最终判定),hasBase/hasCell 不由分节声明(由 cell/、base/ 脚本目录判定)。
export const ENTITIES_XML_SECTION_CLIENT_SERVER = 'ClientServerEntities';
export const ENTITIES_XML_SECTION_SERVER_ONLY = 'ServerOnlyEntities';
export const ENTITIES_XML_SECTIONS = new Set([
  ENTITIES_XML_SECTION_CLIENT_SERVER,
  ENTITIES_XML_SECTION_SERVER_ONLY
]);

function collectEntityEntries(root: DefElementNode): DefElementNode[] {
  const entries: DefElementNode[] = [];
  for (const child of getDirectChildElements(root)) {
    if (ENTITIES_XML_SECTIONS.has(child.name)) {
      entries.push(...getDirectChildElements(child));
      continue;
    }
    entries.push(child);
  }
  return entries;
}

export function analyzeEntitiesXml(text: string): EntitiesXmlFinding[] {
  // 活编辑器文本可能中途不完整:解析失败静默空结果,不虚构发现
  // (与 parseDefAst 的守卫口径一致)
  let document;
  try {
    document = parseDefDocument(text);
  } catch {
    return [];
  }
  const root = document.root;
  if (!root) {
    return [];
  }

  const findings: EntitiesXmlFinding[] = [];
  const seen = new Set<string>();
  for (const entityNode of collectEntityEntries(root)) {
    const name = entityNode.name;
    // 与 getRegisteredEntities 同口径:root 伪条目不参与实体清单
    if (name === 'root') {
      continue;
    }
    if (!seen.has(name)) {
      seen.add(name);
      continue;
    }
    findings.push({
      check: ENTITIES_XML_DUPLICATE_CHECK,
      severity: 'warning',
      offset: entityNode.tagStart,
      length: entityNode.tagEnd - entityNode.tagStart,
      name,
      message: `entities.xml 中实体 <${name}> 重复登记:引擎按首条静默合并,本条目及其属性断言不会生效`
    });
  }

  return findings;
}
