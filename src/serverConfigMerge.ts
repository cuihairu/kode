import * as vscode from 'vscode';
import {
  getConfigResolved,
  invalidateConfigResolved,
  resolveCustomConfigXmlPath,
  type ConfigResolvedState,
  type ConfigResolveOverrides
} from './serverConfigResolve';
import { annotateConfigTree } from './serverConfigAnnotations';
import {
  generatedCommentBody,
  sanitizeXmlComment,
  sourceCommentSameContent
} from './serverConfigCommentText';

// 注释文本工具在此仍按原名对外(既有调用/测试的入口不变),实现见
// serverConfigCommentText(与挂注释侧共用,避免循环依赖)
export { generatedCommentBody, sanitizeXmlComment, sourceCommentSameContent };

// KODE-CFG-009:元件 kbengine.xml 定位迁至 serverConfigResolve(core 不碰盘,
// TS 只做定位+读盘+送达);此处按原名对外(既有调用/测试入口不变)。
export { resolveCustomConfigXmlPath };

/**
 * 最终服务端配置合成(批112 用户令):按引擎装载规则——先加载
 * kbengine_defaults.xml(引擎默认),再加载元件 kbengine.xml(自定义)逐键
 * 覆盖——合成一份"最终生效配置"并在虚拟文档里展示(文件不落盘)。
 * telnet 端口/密码等服务参数同样从这套合成口径读出(src/telnetService.ts)。
 */

/** 元件配置合成树节点(text = 叶子值;children = 子段/子键) */
export interface ConfigXmlNode {
  name: string;
  text: string;
  children: ConfigXmlNode[];
  /**
   * 源注释(解析期捕获,输入 XML 里原有的注释,KODE-CFG-010):行内/尾随注释
   * 挂到所属元素、前导注释挂到紧随的元素、段尾与文件级游离注释就近挂到所在段
   * 的容器元素(归属规则见 core parse_config 文件头,kode-parser/src/config.rs)。渲染时原样回写,与生成用
   * comment/docHeader 分两套——二者是文案库生成物,本字段是用户原文。
   * 声明/XML PI 不入树(仍丢弃)。
   */
  sourceComments?: string[];
  /**
   * 逐项作用注释(仅渲染期写入,core 解析不产出也不回读):
   * 由 annotateConfigTree 按文案库挂上,渲染时放进元素内部。
   * 渲染时源注释优先于本字段(去重见 renderConfigXml)。
   */
  comment?: string;
  /** 文档头注(合成来源与覆盖口径),同样只出现在元素内部;属生成物,
   * 源注释在前,且 kbengine.finalConfigComments 关闭时不输出 */
  docHeader?: string;
}

/**
 * 渲染单节点(引擎 defaults 排版口径:叶子值两侧留空,缩进用 tab)。
 * 注释装配顺序:源注释(输入 XML 原文) → 文档头注 → 文案库作用注释——
 * 源注释优先于生成注释,全部经 sanitizeXmlComment 规范化后去重。
 */
export function renderConfigXml(node: ConfigXmlNode, depth = 0): string {
  const pad = '\t'.repeat(depth);
  // 注释一律放元素内部(不上元素上方、不落文件头):容器放子节点之前,叶子按
  // commentAfter 放值之后(引擎按 FirstChild 原样取值的键,见 serverConfigAnnotations)
  const comments = renderComments(node);
  if (node.children.length === 0) {
    const value = node.text.length > 0 ? ` ${node.text} ` : '';
    if (comments.length === 0) {
      return `${pad}<${node.name}>${value}</${node.name}>`;
    }
    // 叶子:注释放在值之后(元素内部)——tinyxml2 的 IntText()/DoubleText() 只认
    // 第一个子节点是文本,注释在值之前会把数值读成默认值(取证见
    // serverConfigAnnotations.ts 文件头);放值之后 GetText/IntText/ToText 都取原值。
    const valueLine = node.text.length > 0 ? `${pad}\t${node.text}` : null;
    return [
      `${pad}<${node.name}>`,
      ...(valueLine !== null ? [valueLine] : []),
      ...comments.map(comment => `${pad}\t<!-- ${comment} -->`),
      `${pad}</${node.name}>`
    ].join('\n');
  }
  const lines = [`${pad}<${node.name}>`, ...comments.map(comment => `${pad}\t<!-- ${comment} -->`)];
  for (const child of node.children) {
    lines.push(renderConfigXml(child, depth + 1));
  }
  lines.push(`${pad}</${node.name}>`);
  return lines.join('\n');
}

/**
 * 节点渲染注释装配(KODE-CFG-010 源注释回写):源注释在前,文档头注与文案库
 * 作用注释(均为生成物)在后;全部规范化后去重——文本相等只留一条,生成注释
 * 与某条源注释同一内容(见 sourceCommentSameContent)时只留源注释,否则同一
 * 内容在同元素里显示两遍(kbengine_defaults.xml 192 条源注释里 138 条已被
 * 文案库收割,不去重必双显)。
 */
export function renderComments(node: ConfigXmlNode): string[] {
  const sources = (node.sourceComments ?? [])
    .map(comment => sanitizeXmlComment(comment))
    .filter(comment => comment.length > 0);
  const kept: string[] = [...new Set(sources)];
  const seen = new Set(kept);
  const add = (raw: string): void => {
    const comment = sanitizeXmlComment(raw);
    if (comment.length === 0 || seen.has(comment)) {
      return;
    }
    seen.add(comment);
    kept.push(comment);
  };
  if (node.docHeader !== undefined) {
    add(node.docHeader);
  }
  if (node.comment !== undefined) {
    const comment = sanitizeXmlComment(node.comment);
    const covered =
      sources.length > 0 &&
      sources.some(
        source =>
          sourceCommentSameContent(source, comment) ||
          sourceCommentSameContent(source, generatedCommentBody(comment))
      );
    if (!covered) {
      add(node.comment);
    }
  }
  return kept;
}

/** 渲染整棵合成树(伪根不输出,顶层组件段各占一块) */
export function renderConfigXmlSections(root: ConfigXmlNode): string {
  return root.children.map(child => renderConfigXml(child, 0)).join('\n');
}

export interface FinalServerConfig {
  text: string;
  /** 引擎 defaults 文件路径(定位失败为 null) */
  defaultsPath: string | null;
  /** 元件 kbengine.xml 路径(定位失败为 null;引擎无自定义配置也能跑) */
  customPath: string | null;
  /** true = 展示的是纯引擎默认(未找到元件 kbengine.xml) */
  defaultsOnly: boolean;
}

export interface MergedConfigTree {
  /** null = defaults 缺失或不可解析,合成无从谈起 */
  merged: ConfigXmlNode | null;
  defaultsPath: string | null;
  customPath: string | null;
  /** true = 元件 kbengine.xml 解析成功并参与了同键覆盖 */
  customApplied: boolean;
}

/**
 * 装载轴覆盖(IDE-REV-015):活动 profile 的引擎根/资产根各自替换对应
 * 轴——被覆盖的轴绝不回落设置/发现/工作区链(回落即读到别的项目的
 * 配置);未覆盖的轴照常走原有链。undefined 与空串不同义:空串视为
 * 「该 profile 没有自己的根」,不覆盖。
 */
export interface MergedConfigTreeOverrides {
  /** 引擎 bin 目录(profile.engineRoot + kbe/bin/server 推导) */
  binPath?: string;
  /** 资产根(profile.assetsRoot):只在其下找元件 kbengine.xml */
  configRoot?: string;
}

/**
 * defaults + 元件 kbengine.xml 的合成树(批131 抽出):最终配置展示与
 * dbmgr 数据库接口读值共用一套装载口径,不各读各的。
 */
/** custom/defaults 两棵原始配置树(TS 读盘解析;core 不碰盘,设计 §5.2) */
export interface ConfigTreePair {
  /** 元件 kbengine.xml 解析树(缺失/不可解析为 null) */
  customTree: ConfigXmlNode | null;
  /** 引擎 kbengine_defaults.xml 解析树(缺失/不可解析为 null) */
  defaultsTree: ConfigXmlNode | null;
  customPath: string | null;
  defaultsPath: string | null;
}

/**
 * 装载 custom + defaults 两棵原始配置树(buildMergedConfigTree 的拆分面):
 * KODE-CFG-009 起两棵树由 core 解析(`$/kode/config/resolve`),本函数只读
 * 消费缓存——调用方需先 `await ensureConfigResolved(overrides)` 保证新鲜
 * (configDerive 刷新面与各 async 命令入口已接线)。core 不可知(门未接线/
 * RPC 失败)时树为 null,定位事实照常带出(configDerive facts 依赖)。
 */
export function buildConfigTreePair(overrides: MergedConfigTreeOverrides = {}): ConfigTreePair {
  const state = getConfigResolved(overrides);
  if (!state) {
    return { customTree: null, defaultsTree: null, customPath: null, defaultsPath: null };
  }
  const resolved: ConfigResolvedState = state;
  return {
    customTree: resolved.customTree,
    defaultsTree: resolved.defaultsTree,
    customPath: resolved.customPath,
    defaultsPath: resolved.defaultsPath
  };
}

export function buildMergedConfigTree(overrides: ConfigResolveOverrides = {}): MergedConfigTree {
  const state = getConfigResolved(overrides);
  const pair = buildConfigTreePair(overrides);
  return {
    merged: state?.merged ?? null,
    defaultsPath: pair.defaultsPath,
    customPath: pair.customPath,
    customApplied: pair.customTree !== null
  };
}

/**
 * 合成最终生效配置:defaults 必须在(binPath 推导不出/读不到则 text 空,
 * 由命令层提示);元件 kbengine.xml 找不到时展示纯 defaults,不算错误。
 *
 * 注释增强(用户令 final XML config):默认开启 `kbengine.finalConfigComments`,
 * 逐项挂作用注释并按子分类排序;注释语言跟随 VS Code 显示语言(传入 language
 * 可覆盖,便于测试)。文档头注(来源与覆盖口径)放进第一个顶层元素内部,
 * 文件头不放任何注释。
 */
export function buildFinalServerConfig(language?: string): FinalServerConfig {
  const { merged, defaultsPath, customPath, customApplied } = buildMergedConfigTree();
  if (!merged) {
    return { text: '', defaultsPath, customPath: null, defaultsOnly: true };
  }
  // 展示头注(批112 默认开启令:变更联动时标一句来源与覆盖口径,读者不用猜)
  const source = customApplied
    ? `先载引擎默认 ${defaultsPath},再以元件配置 ${customPath} 同键覆盖(子键按名对齐)`
    : `仅引擎默认 ${defaultsPath}(未找到元件 kbengine.xml)`;
  const enabled = vscode.workspace
    .getConfiguration('kbengine')
    .get<boolean>('finalConfigComments', true);
  const annotated = annotateConfigTree(merged, {
    language: language ?? vscode.env.language,
    enabled,
    header: `kode 合成最终配置:${source};只读展示,不落盘`
  });
  return {
    text: renderConfigXmlSections(annotated),
    defaultsPath,
    customPath,
    defaultsOnly: !customApplied
  };
}

/** dbmgr 数据库接口连接要素(批131 用户令:连接信息直接读 KBEngine 自身配置) */
export interface DatabaseInterfaceConfig {
  host: string;
  /** 引擎 <port> 0 = 用 mysql 默认 3306(db_interface_mysql.cpp:166-167) */
  port: number;
  username: string;
  databaseName: string;
  /** true = <encrypt> true:密码经引擎 RSA 加密,kode 不读不解读 */
  encrypt: boolean;
  characterSet: string;
  /**
   * 明文密码(仅 <encrypt>false</encrypt> 时提取):批C 漂移校验要用真实
   * 连接要素连库,而「不新增配置项」意味着密码只能来自引擎配置本身。
   * 密文账号(encrypt=true,引擎默认)读不出明文,留 undefined——
   * 漂移校验据此降级为「未校验」,不让用户为了校验去手填密码。
   */
  plainPassword?: string;
}

/**
 * 配置或 kbengine*.xml 落盘变更后由扩展层调用,令消费态失效(下一次
 * ensureConfigResolved 强制重取;新值由 core `$/kode/config/resolve` 产出)。
 */
export function resetDatabaseInterfaceConfigCache(): void {
  invalidateConfigResolved();
}

/**
 * 引擎最终生效配置里的数据库连接要素(core `dbInterface` 直传,消费缓存):
 * defaults 不可得/core 不可知时返回 null,不虚构。
 */
export function resolveDatabaseInterfaceConfig(): DatabaseInterfaceConfig | null {
  return getConfigResolved()?.dbInterface ?? null;
}

/** 合成配置虚拟文档 scheme(展示用,不落盘) */
export const KBE_CONFIG_SCHEME = 'kbengine-config';

/** 合成配置虚拟文档路径(命中 **\/kbengine*.xml 悬停 pattern,可悬停看字段说明) */
export const KBE_CONFIG_VIRTUAL_PATH = '/kbengine-final.xml';

/**
 * 合成配置内容提供者:每次打开重算(设置/文件可能已变);默认开启令的
 * 变更联动经 refresh() 通知已打开的虚拟文档重读。
 */
export class FinalConfigContentProvider implements vscode.TextDocumentContentProvider {
  private readonly didChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.didChange.event;

  /** 合成源(defaults / 元件 kbengine.xml)变更后重算并刷新已打开的文档 */
  refresh(): void {
    this.didChange.fire(vscode.Uri.parse(`${KBE_CONFIG_SCHEME}:${KBE_CONFIG_VIRTUAL_PATH}`));
  }

  provideTextDocumentContent(_uri: vscode.Uri): string {
    return buildFinalServerConfig().text;
  }
}

/** 侧栏常驻入口(批112 默认开启令):单节点,点击即开最终配置只读视图 */
export class FinalConfigTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly item = new vscode.TreeItem(vscode.l10n.t('Final Configuration'), vscode.TreeItemCollapsibleState.None);

  constructor() {
    this.item.description = 'kbengine-final.xml';
    this.item.tooltip = '引擎默认与元件 kbengine.xml 合成后的最终生效配置(只读视图)';
    this.item.command = {
      command: 'kbengine.config.showFinal',
      title: '打开最终配置'
    };
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return [this.item];
  }
}
