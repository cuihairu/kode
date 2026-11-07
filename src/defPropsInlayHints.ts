import * as vscode from 'vscode';
import type { EntityMappingManager, PropertyDefinitionInfo } from './entityMapping';
import { resolveEntityAnnotationType, getWorkspaceRootForDocument } from './definitionWorkspace';
import { PYTHON_TYPE_STUB_FALLBACK } from './pythonTypeStubs';

// C-22 交付③(def 属性可视化呈现,重做版):def 属性只读视图 inlay(注释
// 锚形态)。Python 侧 __init__ 之前引擎灌入的 def 属性在源码里不可见;在
// 用户放置的整行注释锚 `# kode:props-from-def` 行尾以一条 inlay 渲染该文
// 件所属实体的 def 根级属性清单(name: 注解,段悬停给 def 声明出处)。纯
// 渲染层,不写代码不造第二事实源——属性唯一事实源 = .def(C-22 原则),
// 跳转走既有属性 F12 同一索引,self.<prop> 悬停走既有
// resolveSelfPropertyAnnotationHover 面(hover 呈现已在本仓库,不重复造)。
//
// 口径(诚实面):
// - 锚 = 整行注释(trim 后以 # 起)且含精确 token `kode:props-from-def`;
//   代码行尾注释/字符串里的同词不触发;
// - 属性面 = 文件所属实体的 .def 根级声明(FIXED_DICT 子键(路径带 .)与
//   组件槽成员不进总览,各自在访问点有既有 inlay/F12 面);
// - 无所属实体 / 无根级属性 / 开关关 → 零 inlay,不推导不猜;
// - 注解链与 hover/stub 同源(resolveEntityAnnotationType),解析落 Any
//   的属性只显名不带类型,不伪造。
// 独立开关 kbengine.inlayHints.defProps(默认开),provider 现读配置,
// 下一次渲染即生效,与 defParams 同模式。

/** 锚注释里的精确标记 token */
export const DEF_PROPS_ANCHOR_TOKEN = 'kode:props-from-def';

export interface DefPropsAnchorSite {
  /** 锚注释行(0 起) */
  line: number;
  /** 行文本长度(hint 锚在行尾) */
  character: number;
}

/** inlay 单段(label part):文本 + 悬停出处 */
export interface DefPropsHintPart {
  text: string;
  tooltip?: string;
}

/** 一条锚点 inlay 的纯数据形态(provider 层转 vscode.InlayHint,测试免 vscode 依赖) */
export interface DefPropsHintItem {
  position: { line: number; character: number };
  parts: DefPropsHintPart[];
  kind: 'Type';
}

/**
 * 提取注释锚:只认整行注释形态(trim 后以 # 起)。纯函数(文本输入),
 * 测试免 vscode 依赖;代码行尾注释/字符串字面量里的同词不触发。
 */
export function findDefPropsAnchorSites(text: string): DefPropsAnchorSite[] {
  const lines = text.split(/\r?\n/);
  const sites: DefPropsAnchorSite[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index];
    if (!lineText.trim().startsWith('#')) {
      continue;
    }
    if (!lineText.includes(DEF_PROPS_ANCHOR_TOKEN)) {
      continue;
    }
    sites.push({ line: index, character: lineText.length });
  }
  return sites;
}

/** 根级声明过滤器:FIXED_DICT 子键(路径带 .)与组件槽成员不进总览 */
const isRootLevelProperty = (property: PropertyDefinitionInfo): boolean => {
  if (property.identity.componentSlotName) {
    return false;
  }
  const propertyPath = property.identity.propertyPath ?? property.identity.symbolName;
  return !propertyPath.includes('.');
};

/** 段悬停:声明出处(文件名:行)+ 域 + 持久化,无域无持久化只剩出处 */
const partTooltipOf = (property: PropertyDefinitionInfo): string => {
  const fileName = property.defFile.split(/[\\/]/).pop() ?? property.defFile;
  const details = [`${fileName}:${property.line}`];
  if (property.domains.length > 0) {
    details.push(property.domains.join('/'));
  }
  if (property.persistent) {
    details.push('持久化');
  }
  return details.join(' · ');
};

/**
 * 组装单锚点 inlay:头部段 `def 属性(N)`(悬停=只读视图说明)+ 逐属性段
 * `name: 注解`(Any 落名裸显),段间 ` · ` 分隔。注解链与 hover/stub 同源。
 * 根级属性为零 → null(锚行零 inlay)。
 */
export function buildDefPropsInlayItems(
  site: DefPropsAnchorSite,
  properties: readonly PropertyDefinitionInfo[],
  workspaceRoot: string
): DefPropsHintItem | null {
  const rootProperties = properties.filter(isRootLevelProperty);
  if (rootProperties.length === 0) {
    return null;
  }
  const parts: DefPropsHintPart[] = [
    {
      text: `def 属性(${rootProperties.length}) `,
      tooltip: 'def 声明属性只读视图(纯渲染,非代码)。事实源: .def;跳转: 属性上 F12 直达声明行'
    }
  ];
  for (const property of rootProperties) {
    if (parts.length > 1) {
      parts.push({ text: ' · ' });
    }
    const name = property.identity.propertyPath || property.identity.symbolName;
    const annotation = property.typeName
      ? resolveEntityAnnotationType(workspaceRoot, property.typeName)
      : PYTHON_TYPE_STUB_FALLBACK;
    parts.push({
      text: annotation === PYTHON_TYPE_STUB_FALLBACK ? name : `${name}: ${annotation}`,
      tooltip: partTooltipOf(property)
    });
  }
  return { position: { line: site.line, character: site.character }, parts, kind: 'Type' };
}

export class DefPropsInlayHintsProvider implements vscode.InlayHintsProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): Promise<vscode.InlayHint[]> {
    if (!vscode.workspace.getConfiguration('kbengine').get<boolean>('inlayHints.defProps', true)) {
      return [];
    }
    let properties: PropertyDefinitionInfo[] | null = null;
    try {
      properties = await this.entityMappingManager.listPropertyDefinitionsForFile(document.fileName);
    } catch {
      properties = null;
    }
    if (!properties || properties.length === 0) {
      return [];
    }
    const workspaceRoot = getWorkspaceRootForDocument(document) ?? '';
    const text = document.getText();
    const hints: vscode.InlayHint[] = [];
    for (const site of findDefPropsAnchorSites(text)) {
      // inlay 按可视区要:视图口外的锚行不出 hint(批154 同口径)
      if (site.line < range.start.line || site.line > range.end.line) {
        continue;
      }
      const item = buildDefPropsInlayItems(site, properties, workspaceRoot);
      if (!item) {
        continue;
      }
      // label part 走真实 vscode.InlayHintLabelPart(段悬停给 def 声明出处)
      const hint = new vscode.InlayHint(
        new vscode.Position(item.position.line, item.position.character),
        item.parts.map(part => {
          const labelPart = new vscode.InlayHintLabelPart(part.text);
          if (part.tooltip) {
            labelPart.tooltip = new vscode.MarkdownString(part.tooltip);
          }
          return labelPart;
        }),
        vscode.InlayHintKind.Type
      );
      hint.paddingLeft = true;
      hints.push(hint);
    }
    return hints;
  }
}
