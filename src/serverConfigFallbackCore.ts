// AUDIT-007:`$/kode/config/resolve` 的 TS 回落核(纯函数,零 vscode 依赖)。
//
// KODE-CFG-009 曾定「core 唯一解析实现,绝不回退本地解析」;2026-11-11 用户令
// 补 TS 回退:纯 TS 通用包(平台包无 kode-server 二进制)与 RPC 失败时四消费
// 面(Player Data DSN/telnet 自动配置/克隆连接派生/configDerive)不再降级。
// 本模块语义逐条镜像 Rust kode-parser/src/config.rs(parse_config/
// merge_config_xml/find_among_layers/telnet_summary/db_interface_config/
// custom_telnet/leaf_number),对拍由 tests/serverConfigFallbackParity.test.ts
// 以真实二进制 RPC 输出为 golden 深等锁定。tests/helpers/configCoreContract.ts
// 的门替身自本模块取实现(单一事实源,替身 ≡ 回落 ≡ Rust)。

import { sanitizeXmlComment } from './backend/serverConfigCommentText';
import type { ConfigXmlNode } from './serverConfigMerge';

/** core `telnetSummary` 条目(端口数字非法/密码空 → null,与 core 同裁) */
export interface CoreTelnetSummaryEntry {
  component: string;
  port: number | null;
  password: string | null;
}

/** core `customTelnet` 产物(元件配置 telnet_service 段读值;无段 → null) */
export interface CoreCustomTelnet {
  port: number | null;
  password: string | null;
}

/** core `dbInterface` 产物(镜像 serverConfigMerge.DatabaseInterfaceConfig) */
export interface CoreDatabaseInterfaceConfig {
  host: string;
  port: number;
  username: string;
  databaseName: string;
  /** true = 密码经引擎 RSA 加密,kode 不读不解读 */
  encrypt: boolean;
  characterSet: string;
  /** 明文密码(仅 encrypt=false 时提取) */
  plainPassword?: string;
}

/** 回落核全量产物(与 `$/kode/config/resolve` RPC 响应体同形) */
export interface ConfigResolveProducts {
  defaultsTree: ConfigXmlNode | null;
  customTree: ConfigXmlNode | null;
  merged: ConfigXmlNode | null;
  telnetSummary: CoreTelnetSummaryEntry[];
  telnetDefaultPorts: Record<string, number>;
  customTelnet: CoreCustomTelnet | null;
  dbInterface: CoreDatabaseInterfaceConfig | null;
}

/** 引擎各组件 telnet 默认端口(kbengine_defaults.xml `<telnet_service><port/>`;
 * 与 Rust ENGINE_DEFAULT_TELNET_PORTS 同表同序,导出供端口规划测试对撞用) */
export const ENGINE_DEFAULT_TELNET_PORTS: ReadonlyArray<{ component: string; port: number }> = [
  { component: 'loginapp', port: 31000 },
  { component: 'dbmgr', port: 32000 },
  { component: 'interfaces', port: 33000 },
  { component: 'logger', port: 34000 },
  { component: 'baseapp', port: 40000 },
  { component: 'cellapp', port: 50000 },
  { component: 'bots', port: 51000 }
];

/** 引擎 defaults dbmgr 段缺叶时的默认值(kbengine_defaults.xml
 * `<dbmgr><databaseInterfaces><default>`) */
const ENGINE_DB_INTERFACE_DEFAULTS = {
  host: 'localhost',
  port: 3306,
  username: 'kbe',
  databaseName: 'kbe',
  characterSet: 'utf8mb4'
} as const;

/** 已见内容容错不抛;根为伪节点(名字空),顶层组件段作其 children。
 * 镜像 Rust parse_config(伪根恒返回;纯注释输入 → null)。 */
export function parseConfigXml(xml: string): ConfigXmlNode | null {
  const root: ConfigXmlNode = { name: '', text: '', children: [] };
  const stack: ConfigXmlNode[] = [root];
  // 注释优先于标签匹配:注释体里出现 `<item>` 之类字样也不会被当成标签
  const tokenRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)(\w+)([^>]*)>/g;
  let lastEnd = 0;
  /** 上一个标签(或注释)结束处:用于判断注释与前一标签是否同行 */
  let lastTagEnd = 0;
  /** 最近闭合的元素:同行的尾随注释归它 */
  let lastClosed: ConfigXmlNode | null = null;
  /** 尚未归属的前导注释,挂到下一个打开的元素上 */
  let pending: string[] = [];
  let match: RegExpExecArray | null;

  const takeText = (top: ConfigXmlNode, end: number): void => {
    const text = xml.slice(lastEnd, end).trim();
    if (text.length > 0 && top !== root) {
      top.text += (top.text.length > 0 ? ' ' : '') + text;
    }
  };
  const attach = (node: ConfigXmlNode, comments: readonly string[]): void => {
    if (comments.length === 0) {
      return;
    }
    node.sourceComments = [...(node.sourceComments ?? []), ...comments];
  };

  while ((match = tokenRe.exec(xml)) !== null) {
    const top = stack[stack.length - 1];
    const token = match[0];
    takeText(top, match.index);
    lastEnd = tokenRe.lastIndex;
    if (token.startsWith('<!--')) {
      const body = token.slice(4, -3);
      const sinceTag = xml.slice(lastTagEnd, match.index);
      if (lastClosed !== null && !sinceTag.includes('\n')) {
        attach(lastClosed, [body]);
      } else {
        pending.push(body);
      }
      lastTagEnd = lastEnd;
      continue;
    }
    lastTagEnd = lastEnd;
    if (token.startsWith('<?')) {
      continue; // 声明/XML PI:丢弃
    }
    lastClosed = null;
    if (match[1] === '/') {
      if (top !== root && top.name === match[2]) {
        stack.pop();
        attach(top, pending); // 段尾游离注释 → 就近挂回所在容器
        pending = [];
        lastClosed = top;
      }
    } else {
      const node: ConfigXmlNode = { name: match[2], text: '', children: [] };
      top.children.push(node);
      attach(node, pending); // 前导注释 → 紧随的元素
      pending = [];
      if (!/\/\s*$/.test(match[3])) {
        stack.push(node);
      }
    }
  }
  if (pending.length > 0) {
    // 文件尾游离注释:就近挂到段首容器元素;一个元素都没有(纯注释输入)
    // 则丢弃——返回 null 的既有路径,不崩
    const target = stack.length > 1 ? stack[stack.length - 1] : root.children[0];
    if (target !== undefined) {
      attach(target, pending);
    }
    pending = [];
  }
  return root.children.length > 0 ? root : null;
}

/**
 * 两侧源注释合并(override 优先):override 侧在前、defaults 侧在后;
 * 两侧不同则都保留(容器层不互相覆盖),规范化后相同的只留一条。
 */
function mergeSourceComments(base: ConfigXmlNode, override: ConfigXmlNode): string[] | undefined {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const comment of [...(override.sourceComments ?? []), ...(base.sourceComments ?? [])]) {
    const normalized = sanitizeXmlComment(comment);
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(comment);
  }
  return merged.length > 0 ? merged : undefined;
}

/**
 * 合并(引擎同键覆盖口径):以 defaults 为基、自定义覆盖。子键按名字对齐——
 * 自定义没有的保留默认;自定义写了的整名替换(叶子取自定义值,重复名列表
 * 如 <item> 整表替换,不与默认表交错);两边都是单一容器段则递归下钻。
 * 源注释两侧都保留:override 侧在前(优先),同名单元素的 defaults 侧注释
 * 追加其后;重复名列表整表替换时只带自定义侧注释。
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
    } else if (baseOnes.length === 1 && overrideOnes.length === 1) {
      // 同名单元素(叶子/空容器):值取自定义,源注释两侧都留(override 优先)
      const node: ConfigXmlNode = { ...overrideOnes[0] };
      const comments = mergeSourceComments(baseOnes[0], overrideOnes[0]);
      if (comments !== undefined) {
        node.sourceComments = comments;
      }
      children.push(node);
    } else {
      children.push(...overrideOnes);
    }
  }
  const comments = mergeSourceComments(base, override);
  const merged: ConfigXmlNode = { name: override.name, text: override.text, children };
  if (comments !== undefined) {
    merged.sourceComments = comments;
  }
  return merged;
}

/**
 * 文本按 JS `Number` 口径转数(镜像 Rust leaf_number:trim 后空/非数/非有限
 * → null)。Rust `parse::<f64>` 拒 0x/0o/0b 前缀(JS `Number` 收),这里同步
 * 拒掉——对拍钉死,端口域虽不出现也按 golden 口径走。
 */
function leafNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /^0[xXoObB]/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 直接子叶取原文(镜像 Rust child_leaf:不 trim,trim 在用点做) */
function childLeaf(parent: ConfigXmlNode | undefined, name: string): string | null {
  const child = parent?.children.find(item => item.name === name);
  return child ? child.text : null;
}

/** 两候选层找段(镜像 Rust find_among_layers:伪根一层直挂组件段与
 * `<root>` 包裹二层都找,一层优先) */
function findAmongLayers(root: ConfigXmlNode, name: string): ConfigXmlNode | null {
  return (
    root.children.find(child => child.name === name) ??
    root.children.flatMap(child => child.children).find(child => child.name === name) ??
    null
  );
}

/** 从合成树读 telnet 速览:逐组件(引擎写死表序)读 `<telnet_service>` 端口/
 * 密码。端口 0 合法保留、非数 → null,密码非空才带出;组件段缺
 * telnet_service → 全 null(不猜)。镜像 Rust telnet_summary。 */
function telnetSummaryOf(merged: ConfigXmlNode | null): CoreTelnetSummaryEntry[] {
  if (!merged) {
    return [];
  }
  return ENGINE_DEFAULT_TELNET_PORTS.map(({ component }) => {
    const section = findAmongLayers(merged, component)?.children.find(
      child => child.name === 'telnet_service'
    );
    const portText = childLeaf(section, 'port');
    const password = (childLeaf(section, 'password') ?? '').trim();
    return {
      component,
      port: portText !== null ? leafNumber(portText) : null,
      password: password.length > 0 ? password : null
    };
  });
}

/**
 * 从合成树提取 `<dbmgr><databaseInterfaces><default>` 的连接要素;段缺 →
 * null。username/encrypt 藏在 `<auth>` 下,characterSet 藏在 `<unicodeString>`
 * 下;端口缺/非法/0 回落 3306(引擎 `<port>0` 即「用 mysql 默认」,
 * db_interface_mysql.cpp:166-167)。镜像 Rust db_interface_config。
 */
export function extractDatabaseInterfaceConfig(
  root: ConfigXmlNode
): CoreDatabaseInterfaceConfig | null {
  const dbmgr = findAmongLayers(root, 'dbmgr');
  const iface = dbmgr
    ?.children.find(child => child.name === 'databaseInterfaces')
    ?.children.find(child => child.name === 'default');
  if (!iface) {
    return null;
  }
  const auth = iface.children.find(child => child.name === 'auth');
  const unicode = iface.children.find(child => child.name === 'unicodeString');
  const host = (childLeaf(iface, 'host') ?? '').trim();
  const username = (childLeaf(auth, 'username') ?? '').trim();
  const database = (childLeaf(iface, 'databaseName') ?? '').trim();
  const charset = (childLeaf(unicode, 'characterSet') ?? '').trim();
  // encrypt 缺省 true:值(忽略大小写)非字面 false 即加密
  const encryptText = childLeaf(auth, 'encrypt');
  const encrypt = encryptText !== null ? encryptText.trim().toLowerCase() !== 'false' : true;
  const password = (childLeaf(auth, 'password') ?? '').trim();
  const port = leafNumber(childLeaf(iface, 'port') ?? '');
  return {
    host: host.length > 0 ? host : ENGINE_DB_INTERFACE_DEFAULTS.host,
    port: port !== null && port > 0 ? port : ENGINE_DB_INTERFACE_DEFAULTS.port,
    username: username.length > 0 ? username : ENGINE_DB_INTERFACE_DEFAULTS.username,
    databaseName: database.length > 0 ? database : ENGINE_DB_INTERFACE_DEFAULTS.databaseName,
    encrypt,
    characterSet: charset.length > 0 ? charset : ENGINE_DB_INTERFACE_DEFAULTS.characterSet,
    plainPassword: !encrypt && password.length > 0 ? password : undefined
  };
}

/** 文档序首个名匹配节点(children 一层优先,再逐子深扫;镜像 Rust first_node) */
function firstNode(node: ConfigXmlNode, name: string): ConfigXmlNode | null {
  for (const child of node.children) {
    if (child.name === name) {
      return child;
    }
  }
  for (const child of node.children) {
    const found = firstNode(child, name);
    if (found) {
      return found;
    }
  }
  return null;
}

/** 元件配置 telnet_service 段读值(镜像 Rust custom_telnet:无段 → null) */
function customTelnetOf(customTree: ConfigXmlNode | null): CoreCustomTelnet | null {
  if (!customTree) {
    return null;
  }
  const section = firstNode(customTree, 'telnet_service');
  if (!section) {
    return null;
  }
  const port = leafNumber(childLeaf(section, 'port') ?? '');
  const password = (childLeaf(section, 'password') ?? '').trim();
  return { port, password: password.length > 0 ? password : null };
}

/**
 * 回落核入口:defaults + 元件配置原文 → 与 `$/kode/config/resolve` RPC 响应
 * 同形的全量产物(镜像 Rust resolve_config:两侧都缺 → merged null,速览/
 * dbInterface 随 merged 缺席为空;customTelnet 只看 custom 树)。产物按输入
 * 原文 memo 化(软缓存重试零重解析)。
 */
const productsMemo = new Map<string, ConfigResolveProducts>();
const PRODUCTS_MEMO_LIMIT = 8;

export function resolveConfigProductsInTs(
  defaultsXml: string | null,
  customXml: string | null
): ConfigResolveProducts {
  const memoKey = `${defaultsXml ?? ''}\u0000${customXml ?? ''}`;
  const hit = productsMemo.get(memoKey);
  if (hit) {
    return hit;
  }
  const defaultsTree = defaultsXml !== null ? parseConfigXml(defaultsXml) : null;
  const customTree = customXml !== null ? parseConfigXml(customXml) : null;
  const merged = defaultsTree
    ? customTree
      ? mergeConfigXml(defaultsTree, customTree)
      : defaultsTree
    : null;
  const products: ConfigResolveProducts = {
    defaultsTree,
    customTree,
    merged,
    telnetSummary: telnetSummaryOf(merged),
    telnetDefaultPorts: Object.fromEntries(
      ENGINE_DEFAULT_TELNET_PORTS.map(entry => [entry.component, entry.port])
    ),
    customTelnet: customTelnetOf(customTree),
    dbInterface: merged !== null ? extractDatabaseInterfaceConfig(merged) : null
  };
  productsMemo.delete(memoKey); // 重插即视为最新
  productsMemo.set(memoKey, products);
  while (productsMemo.size > PRODUCTS_MEMO_LIMIT) {
    const oldest = productsMemo.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    productsMemo.delete(oldest);
  }
  return products;
}
