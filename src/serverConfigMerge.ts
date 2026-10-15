import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ENGINE_DEFAULT_TELNET_PORTS,
  deriveEngineDefaultsXmlPath
} from './telnetService';
import { expandWorkspacePlaceholders } from './workspacePath';
import { resolveDiscoveredConfigRoot, resolveKbeSourceRoot } from './workspaceDiscovery';

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
 * 批128:configPath 未设或未过探针时,发现出的资产根同样参与(其下
 * res/server/kbengine.xml 是引擎装载口径的元件配置位置)。
 */
export function resolveCustomConfigXmlPath(workspaceRoot: string | undefined): string | null {
  const config = vscode.workspace.getConfiguration('kbengine');
  const settingPath = expandWorkspacePlaceholders(
    config.get<string>('configPath', ''),
    workspaceRoot
  );
  // 批128:设置自身候选(直接文件与装载口径位置)之后,发现出的资产根
  // 参与探测,最后才是工作区根约定。设置下的直接文件仍是第一优先(批112 契约)
  const discovered = workspaceRoot ? resolveDiscoveredConfigRoot(workspaceRoot) : null;
  const candidates: string[] = [];
  if (settingPath.length > 0) {
    candidates.push(
      path.join(settingPath, 'kbengine.xml'),
      path.join(settingPath, 'res', 'server', 'kbengine.xml')
    );
  }
  if (discovered && discovered !== settingPath) {
    candidates.push(
      path.join(discovered, 'kbengine.xml'),
      path.join(discovered, 'res', 'server', 'kbengine.xml')
    );
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

export interface MergedConfigTree {
  /** null = defaults 缺失或不可解析,合成无从谈起 */
  merged: ConfigXmlNode | null;
  defaultsPath: string | null;
  customPath: string | null;
  /** true = 元件 kbengine.xml 解析成功并参与了同键覆盖 */
  customApplied: boolean;
}

/**
 * defaults + 元件 kbengine.xml 的合成树(批131 抽出):最终配置展示与
 * dbmgr 数据库接口读值共用一套装载口径,不各读各的。
 */
export function buildMergedConfigTree(): MergedConfigTree {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const binPath = expandWorkspacePlaceholders(
    vscode.workspace.getConfiguration('kbengine').get<string>('binPath', ''),
    workspaceRoot
  );
  // 批125 自动发现:binPath 未配/推导不出时,用引擎源码根锚点兜底再推 defaults
  let defaultsPath = deriveEngineDefaultsXmlPath(binPath);
  if (!defaultsPath && workspaceRoot) {
    const kbeSourceRoot = resolveKbeSourceRoot(workspaceRoot);
    if (kbeSourceRoot) {
      defaultsPath = deriveEngineDefaultsXmlPath(path.join(kbeSourceRoot, 'bin', 'server'));
    }
  }
  let defaultsXml: string | null = null;
  if (defaultsPath) {
    try {
      defaultsXml = fs.readFileSync(defaultsPath, 'utf8');
    } catch {
      defaultsXml = null;
    }
  }
  const defaultsTree = defaultsXml !== null ? parseConfigXml(defaultsXml) : null;
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
  const merged = defaultsTree
    ? (customTree ? mergeConfigXml(defaultsTree, customTree) : defaultsTree)
    : null;
  return { merged, defaultsPath, customPath, customApplied: customTree !== null };
}

/**
 * 合成最终生效配置:defaults 必须在(binPath 推导不出/读不到则 text 空,
 * 由命令层提示);元件 kbengine.xml 找不到时展示纯 defaults,不算错误。
 */
export function buildFinalServerConfig(): FinalServerConfig {
  const { merged, defaultsPath, customPath, customApplied } = buildMergedConfigTree();
  if (!merged) {
    return { text: '', defaultsPath, customPath: null, defaultsOnly: true };
  }
  // 展示头注(批112 默认开启令:变更联动时标一句来源与覆盖口径,读者不用猜)
  const source = customApplied
    ? `先载引擎默认 ${defaultsPath},再以元件配置 ${customPath} 同键覆盖(子键按名对齐)`
    : `仅引擎默认 ${defaultsPath}(未找到元件 kbengine.xml)`;
  return {
    text: `<!-- kode 合成最终配置:${source};只读展示,不落盘 -->\n${renderConfigXmlSections(merged)}`,
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

// 叶子缺省时的引擎默认值(kbengine_defaults.xml <dbmgr><databaseInterfaces><default>)
const ENGINE_DB_INTERFACE_DEFAULTS = {
  host: 'localhost',
  port: 3306,
  username: 'kbe',
  databaseName: 'kbe',
  characterSet: 'utf8mb4'
} as const;

/**
 * 从合成配置树提取 <dbmgr><databaseInterfaces><default> 的连接要素(纯函数)。
 * username/encrypt 藏在 <auth> 下,characterSet 藏在 <unicodeString> 下
 * (kbengine_defaults.xml dbmgr 段结构);密码只在 encrypt=false(明文配置)
 * 时提取——encrypt=true 是 RSA 密文,不解读;漂移校验需要真实连接要素,
 * 密文账号读不出明文时按「未校验」降级。
 */
export function extractDatabaseInterfaceConfig(root: ConfigXmlNode): DatabaseInterfaceConfig | null {
  // 引擎 defaults 以 <root> 包裹装载(kbengine_defaults.xml:1),dbmgr 在
  // 伪根下一层;无包裹的合成树则直接是顶层段。两层候选都找。
  const candidates = [...root.children, ...root.children.flatMap(child => child.children)];
  const dbmgr = candidates.find(child => child.name === 'dbmgr');
  const interfaces = dbmgr?.children.find(child => child.name === 'databaseInterfaces');
  const iface = interfaces?.children.find(child => child.name === 'default');
  if (!iface) {
    return null;
  }

  const leafText = (parent: ConfigXmlNode | undefined, name: string): string => {
    const child = parent?.children.find(item => item.name === name);
    return child ? child.text.trim() : '';
  };

  const auth = iface.children.find(child => child.name === 'auth');
  const unicode = iface.children.find(child => child.name === 'unicodeString');
  const rawPort = Number(leafText(iface, 'port'));
  const encrypt = leafText(auth, 'encrypt').toLowerCase() !== 'false';
  return {
    host: leafText(iface, 'host') || ENGINE_DB_INTERFACE_DEFAULTS.host,
    port: rawPort > 0 ? rawPort : ENGINE_DB_INTERFACE_DEFAULTS.port,
    username: leafText(auth, 'username') || ENGINE_DB_INTERFACE_DEFAULTS.username,
    databaseName: leafText(iface, 'databaseName') || ENGINE_DB_INTERFACE_DEFAULTS.databaseName,
    encrypt,
    characterSet: leafText(unicode, 'characterSet') || ENGINE_DB_INTERFACE_DEFAULTS.characterSet,
    plainPassword: encrypt ? undefined : leafText(auth, 'password') || undefined
  };
}

// 连接要素按「工作区根 + binPath 设置」缓存:悬停/跳转每次重建快照,不缓存
// 则每击一次 F12 都重跑一轮 defaults/元件定位探测(含发现扫描),代价不成比例。
let databaseInterfaceCache: { key: string; value: DatabaseInterfaceConfig | null } | null = null;

/** 配置或 kbengine*.xml 落盘变更后由扩展层调用,令下次读值重算 */
export function resetDatabaseInterfaceConfigCache(): void {
  databaseInterfaceCache = null;
}

/** 引擎最终生效配置里的数据库连接要素;defaults 不可得时返回 null,不虚构 */
export function resolveDatabaseInterfaceConfig(): DatabaseInterfaceConfig | null {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const binPath = expandWorkspacePlaceholders(
    vscode.workspace.getConfiguration('kbengine').get<string>('binPath', ''),
    workspaceRoot
  );
  const key = `${workspaceRoot ?? ''}\n${binPath}`;
  if (databaseInterfaceCache?.key === key) {
    return databaseInterfaceCache.value;
  }
  const { merged } = buildMergedConfigTree();
  const value = merged ? extractDatabaseInterfaceConfig(merged) : null;
  databaseInterfaceCache = { key, value };
  return value;
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
