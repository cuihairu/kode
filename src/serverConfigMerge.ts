import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ENGINE_DEFAULT_TELNET_PORTS,
  deriveEngineDefaultsXmlPath
} from './telnetService';
import { expandWorkspacePlaceholders } from './workspacePath';

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
}

/**
 * 解析引擎风格的服务端配置 XML(仅需元素树,注释/声明/属性忽略):
 * 根为伪节点(名字空),顶层各组件段作其 children。标签不闭合或多余
 * 闭合按已见内容容错,不抛——配置展示宁可显示半棵树也不崩命令。
 */
export function parseConfigXml(xml: string): ConfigXmlNode | null {
  const cleaned = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');
  const root: ConfigXmlNode = { name: '', text: '', children: [] };
  const stack: ConfigXmlNode[] = [root];
  const tagRe = /<(\/?)(\w+)([^>]*)>/g;
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(cleaned)) !== null) {
    const top = stack[stack.length - 1];
    const text = cleaned.slice(lastEnd, match.index).trim();
    if (text.length > 0 && top !== root) {
      top.text += (top.text.length > 0 ? ' ' : '') + text;
    }
    lastEnd = tagRe.lastIndex;
    if (match[1] === '/') {
      if (top !== root && top.name === match[2]) {
        stack.pop();
      }
    } else {
      const node: ConfigXmlNode = { name: match[2], text: '', children: [] };
      top.children.push(node);
      if (!/\/\s*$/.test(match[3])) {
        stack.push(node);
      }
    }
  }
  return root.children.length > 0 ? root : null;
}

/**
 * 合并(引擎同键覆盖口径):以 defaults 为基、自定义覆盖。子键按名字对齐——
 * 自定义没有的保留默认;自定义写了的整名替换(叶子取自定义值,重复名列表
 * 如 <item> 整表替换,不与默认表交错);两边都是单一容器段则递归下钻。
 */
export function mergeConfigXml(base: ConfigXmlNode, override: ConfigXmlNode): ConfigXmlNode {
  const names: string[] = [];
  for (const child of [...base.children, ...override.children]) {
    if (!names.includes(child.name)) {
      names.push(child.name);
    }
  }
  const children: ConfigXmlNode[] = [];
  for (const name of names) {
    const baseOnes = base.children.filter(child => child.name === name);
    const overrideOnes = override.children.filter(child => child.name === name);
    if (overrideOnes.length === 0) {
      children.push(...baseOnes);
    } else if (baseOnes.length === 0) {
      children.push(...overrideOnes);
    } else if (
      baseOnes.length === 1 &&
      overrideOnes.length === 1 &&
      baseOnes[0].children.length > 0 &&
      overrideOnes[0].children.length > 0
    ) {
      children.push(mergeConfigXml(baseOnes[0], overrideOnes[0]));
    } else {
      children.push(...overrideOnes);
    }
  }
  return { name: override.name, text: override.text, children };
}

/** 渲染单节点(引擎 defaults 排版口径:叶子值两侧留空,缩进用 tab) */
export function renderConfigXml(node: ConfigXmlNode, depth = 0): string {
  const pad = '\t'.repeat(depth);
  if (node.children.length === 0) {
    const value = node.text.length > 0 ? ` ${node.text} ` : '';
    return `${pad}<${node.name}>${value}</${node.name}>`;
  }
  const lines = [`${pad}<${node.name}>`];
  for (const child of node.children) {
    lines.push(renderConfigXml(child, depth + 1));
  }
  lines.push(`${pad}</${node.name}>`);
  return lines.join('\n');
}

/** 渲染整棵合成树(伪根不输出,顶层组件段各占一块) */
export function renderConfigXmlSections(root: ConfigXmlNode): string {
  return root.children.map(child => renderConfigXml(child, 0)).join('\n');
}

/**
 * 元件 kbengine.xml 定位:kbengine.configPath(服务器资产目录,引擎
 * KBE_RES_PATH 中的项目侧)下的 kbengine.xml 优先,再按约定路径探测
 * 工作区根(与 telnet 约定路径一致)。取第一个存在的文件。
 */
export function resolveCustomConfigXmlPath(workspaceRoot: string | undefined): string | null {
  const config = vscode.workspace.getConfiguration('kbengine');
  const configPath = expandWorkspacePlaceholders(
    config.get<string>('configPath', ''),
    workspaceRoot
  );
  const candidates: string[] = [];
  if (configPath.length > 0) {
    candidates.push(path.join(configPath, 'kbengine.xml'));
  }
  if (workspaceRoot) {
    candidates.push(
      ...['kbengine.xml', 'res/server/kbengine.xml', 'assets/res/server/kbengine.xml'].map(
        relative => path.join(workspaceRoot, relative)
      )
    );
  }
  for (const candidate of candidates) {
    try {
      fs.readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // 缺失/不可读:试下一个候选
    }
  }
  return null;
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

/**
 * 合成最终生效配置:defaults 必须在(binPath 推导不出/读不到则 text 空,
 * 由命令层提示);元件 kbengine.xml 找不到时展示纯 defaults,不算错误。
 */
export function buildFinalServerConfig(): FinalServerConfig {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const binPath = expandWorkspacePlaceholders(
    vscode.workspace.getConfiguration('kbengine').get<string>('binPath', ''),
    workspaceRoot
  );
  const defaultsPath = deriveEngineDefaultsXmlPath(binPath);
  let defaultsXml: string | null = null;
  if (defaultsPath) {
    try {
      defaultsXml = fs.readFileSync(defaultsPath, 'utf8');
    } catch {
      defaultsXml = null;
    }
  }
  const defaultsTree = defaultsXml !== null ? parseConfigXml(defaultsXml) : null;
  if (!defaultsTree) {
    return { text: '', defaultsPath, customPath: null, defaultsOnly: true };
  }
  const customPath = resolveCustomConfigXmlPath(workspaceRoot);
  let customTree: ConfigXmlNode | null = null;
  if (customPath) {
    // 不可达(批112 定性):customPath 刚经 resolveCustomConfigXmlPath 以同
    // 参数 readFileSync 试读通过,同一 tick 内二次读盘不可能由可读转为不可
    // 读;catch 为防御臂,v8 记不到执行即忽略。
    /* istanbul ignore start */
    try {
      customTree = parseConfigXml(fs.readFileSync(customPath, 'utf8'));
    } catch {
      customTree = null;
    }
    /* istanbul ignore stop */
  }
  const merged = customTree ? mergeConfigXml(defaultsTree, customTree) : defaultsTree;
  // 展示头注(批112 默认开启令:变更联动时标一句来源与覆盖口径,读者不用猜)
  const source =
    customTree !== null
      ? `先载引擎默认 ${defaultsPath},再以元件配置 ${customPath} 同键覆盖(子键按名对齐)`
      : `仅引擎默认 ${defaultsPath}(未找到元件 kbengine.xml)`;
  return {
    text: `<!-- kode 合成最终配置:${source};只读展示,不落盘 -->\n${renderConfigXmlSections(merged)}`,
    defaultsPath,
    customPath,
    defaultsOnly: !customTree
  };
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
  private readonly item = new vscode.TreeItem('最终配置', vscode.TreeItemCollapsibleState.None);

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

/**
 * 合成配置的 telnet 速览(批112 用户令:"根据这个配置去获得 telnet 的端口和
 * 密码"):从最终生效配置逐组件读 <telnet_service> 端口/密码,与
 * telnetService 的合成读值同口径,供命令层在合成文档头部展示。
 */
export function summarizeFinalTelnet(finalConfig: string): Array<{
  component: string;
  port: number | null;
  password: string | null;
}> {
  return ENGINE_DEFAULT_TELNET_PORTS.map(({ component }) => {
    const section = finalConfig.match(new RegExp(`<${component}>([\\s\\S]*?)</${component}>`));
    const telnet = section?.[1].match(/<telnet_service>([\s\S]*?)<\/telnet_service>/);
    const port = telnet?.[1].match(/<port>([\s\S]*?)<\/port>/);
    const password = telnet?.[1].match(/<password>([\s\S]*?)<\/password>/);
    const portValue = port !== undefined && port !== null ? Number(port[1].trim()) : NaN;
    return {
      component,
      port: Number.isFinite(portValue) ? portValue : null,
      password:
        password !== undefined && password !== null && password[1].trim().length > 0
          ? password[1].trim()
          : null
    };
  });
}
