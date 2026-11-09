import type { ConfigXmlNode } from '../serverConfigMerge';
import { sourceCommentSameContent } from './serverConfigCommentText';
import {
  SERVER_CONFIG_GROUPS,
  SERVER_CONFIG_GROUP_ORDER,
  SERVER_CONFIG_UNKNOWN_DOC,
  configItemDocBody,
  findServerConfigItemDoc,
  isZhConfigLanguage,
  type ServerConfigGroup,
  type ServerConfigItemDoc
} from './serverConfigCatalog';

/**
 * 最终配置的子分类与逐项作用注释(用户令:final XML config 增强)。
 *
 * 分组主轴 = 进程:kbengine_defaults.xml 的顶层段名就是进程名(dbmgr/cellapp/
 * baseapp/loginapp/machine/bots/logger/interfaces/...),serverconfig.cpp 逐段
 * `root->FirstChildElement("<进程>")` 读取(serverconfig.cpp:733 baseapp、:911
 * dbmgr),段内再按功能(network/db/log/...)分子分类。
 *
 * 注释位置(引擎兼容取证:本机引擎 KBEngine 2.5.10 的 kbe/src/lib/xml/xml.{h,cpp}
 * 与 kbe/src/lib/server/serverconfig.cpp,并用同版本 tinyxml2 11 实测):
 * - 容器元素:注释作为元素第一个子节点。serverconfig.cpp 全篇用
 *   FirstChildElement/NextSiblingElement 取子元素(291 处),二者都跳过注释节点;
 *   XML_FOR_BEGIN 显式按 `ToElement()==nullptr` 跳过注释(xml.h:14-19);
 *   enterNode 也显式跳过注释节点(xml.cpp:81-89)。
 * - 叶子元素(有值/无值):注释放值之后,仍在元素内部。tinyxml2 的
 *   IntText()/DoubleText() 只认第一个子节点是文本,注释在值之前会把数值读成
 *   默认值——实测 `<r><!-- c --> 42 </r>` → IntText() 取默认,`<r> 42 <!-- c
 *   --></r>` → 42;而引擎数值项正是走 intText/doubleText(serverconfig.cpp:41-67)。
 *   放值之后 GetText()/IntText()/ToText() 三条读法都取到原值。
 * 任何注释都不出现在元素上方或文件头。
 */

/** 顶层段名 = 进程名(证据:kbe/res/server/kbengine_defaults.xml 顶层段) */
const PROCESS_SECTION_NAMES = new Set([
  'baseapp',
  'cellapp',
  'dbmgr',
  'loginapp',
  'machine',
  'bots',
  'logger',
  'interfaces',
  'cellappmgr',
  'baseappmgr'
]);

export interface ConfigAnnotationOptions {
  /** VS Code 显示语言(undefined/zh* → 中文注释,其余英文) */
  language?: string;
  /**
   * false = 关闭增强(kbengine.finalConfigComments):不加作用注释、不加文档
   * 头注、不按子分类重排。只关「生成物」——解析期捕获的源注释
   * (sourceComments)是输入原文,不受开关影响,照常回写。
   */
  enabled?: boolean;
  /** 文档头注(合成来源与覆盖口径),放进第一个顶层元素内部;属生成物,
   * enabled=false 时不输出 */
  header?: string;
}

/** 子分类排序键;自定义配置恒排最后 */
function groupRank(group: ServerConfigGroup): number {
  const index = SERVER_CONFIG_GROUP_ORDER.indexOf(group);
  return index < 0 ? SERVER_CONFIG_GROUP_ORDER.length : index;
}

/** 组合一条注释文案:【子分类】作用说明〔来源: ...〕(英文侧同构) */
function composeComment(doc: ServerConfigItemDoc, language: string | undefined): string {
  const zh = isZhConfigLanguage(language);
  const group = SERVER_CONFIG_GROUPS[doc.group];
  const label = zh ? group.zh : group.en;
  const body = configItemDocBody(doc, language);
  if (zh) {
    return `【${label}】${body}〔来源: ${doc.source}〕`;
  }
  return `[${label}] ${body} (source: ${doc.source})`;
}

/** 未识别的自定义配置项:归入「自定义配置」子分类并标「未识别」,不猜语义 */
function composeUnknownComment(language: string | undefined): string {
  const doc = SERVER_CONFIG_UNKNOWN_DOC;
  const zh = isZhConfigLanguage(language);
  const group = SERVER_CONFIG_GROUPS[doc.group];
  const label = zh ? group.zh : group.en;
  const body = configItemDocBody(doc, language);
  return zh ? `【${label}】${body}` : `[${label}] ${body}`;
}

/**
 * 给合成配置树挂子分类注释:逐项查文案库(查不到 = 自定义配置·未识别),
 * 段内按子分类稳定排序(同组保持引擎原序),并把文档头注放进第一个顶层元素。
 * 返回新树,不改动入参。
 */
export function annotateConfigTree(
  root: ConfigXmlNode,
  options: ConfigAnnotationOptions = {}
): ConfigXmlNode {
  const { language, enabled = true, header } = options;
  const top = root.children;
  const single = top.length === 1 ? top[0] : undefined;
  // 包裹段(<root>/<defaults>)不参与排序:全局键与进程段保持引擎原序。
  // 单个顶层段本身就是进程段(无包裹)时,它的子键照常分组。
  const isWrapper = single !== undefined && !PROCESS_SECTION_NAMES.has(single.name);
  const sortMinParentDepth = isWrapper ? 2 : 1;

  const annotate = (node: ConfigXmlNode, depth: number, ancestors: readonly string[]): ConfigXmlNode => {
    const segments = [...ancestors, node.name];
    const children = node.children.map(child => annotate(child, depth + 1, segments));

    const isWrapperNode = isWrapper && single !== undefined && node === single;
    const doc = isWrapperNode
      ? findServerConfigItemDoc([node.name])
      : findServerConfigItemDoc(segments);

    // 注释放元素内部(容器在子节点前、叶子在值后),规则与取证见文件头
    const out: ConfigXmlNode = { name: node.name, text: node.text, children };
    if (node.sourceComments !== undefined && node.sourceComments.length > 0) {
      // 源注释原样带过(生成的注释是另一套字段,渲染时源注释优先)
      out.sourceComments = [...node.sourceComments];
    }
    // 源注释优先:文案库正文(中英双语,正文常逐字收割自源注释)与源注释同一
    // 内容时不再挂生成注释,否则同一条说明在同一元素里显示两遍(KODE-CFG-010)
    const coveredBySource =
      enabled &&
      doc !== null &&
      (node.sourceComments ?? []).some(
        source =>
          sourceCommentSameContent(source, doc.zh) || sourceCommentSameContent(source, doc.en)
      );
    if (enabled && doc && !coveredBySource) {
      out.comment = composeComment(doc, language);
    } else if (enabled && !doc && !isWrapperNode) {
      out.comment = composeUnknownComment(language);
    }
    return out;
  };

  const annotated: ConfigXmlNode = {
    name: root.name,
    text: root.text,
    children: top.map(child => annotate(child, 1, []))
  };
  if (root.sourceComments !== undefined && root.sourceComments.length > 0) {
    annotated.sourceComments = [...root.sourceComments];
  }

  // 段内按子分类排序:同组保持原序(稳定排序),自定义配置沉底。
  if (enabled) {
    const rankMap = new Map<ConfigXmlNode, number>();
    const rankPass = (node: ConfigXmlNode, segments: readonly string[]): void => {
      const next = node.name.length > 0 ? [...segments, node.name] : segments;
      if (node !== annotated) {
        const doc = findServerConfigItemDoc(next);
        rankMap.set(node, groupRank(doc ? doc.group : 'custom'));
      }
      for (const child of node.children) {
        rankPass(child, next);
      }
    };
    rankPass(annotated, []);

    const sortChildren = (node: ConfigXmlNode, depth: number): void => {
      if (depth >= sortMinParentDepth && node.children.length > 1) {
        node.children = [...node.children].sort(
          (a, b) => (rankMap.get(a) ?? 0) - (rankMap.get(b) ?? 0)
        );
      }
      for (const child of node.children) {
        sortChildren(child, depth + 1);
      }
    };
    sortChildren(annotated, 0);
  }

  if (enabled && header !== undefined && annotated.children.length > 0) {
    // 文档头注同属生成物:开关关闭时不输出(源注释不受此开关管辖)
    annotated.children[0].docHeader = header;
  }
  return annotated;
}
