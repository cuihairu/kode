// KODE-CFG-009 门替身契约镜像(tests-only,非 src 双实现):
// `$/kode/config/resolve` 的响应契约镜像——原 TS parseConfigXml/
// mergeConfigXml/telnetSummary/dbInterface 语义已整体迁入 Rust core
// (kode-parser resolve_config,rpc_dispatch.rs + config_resolve_units.rs
// 钉死契约真值)。消费端接线测试(serverConfigMerge.test.ts 等)用本镜像
// 伪造门响应,与 configDeriveScanRoot.test.ts 的 contractDerive 同一先例:
// 替身只按契约回数,TS 侧接线(送达原文→消费 core 树→缓存/降级)是真被验面。

import { sanitizeXmlComment } from '../../src/serverConfigCommentText';

export interface ConfigXmlNode {
  name: string;
  text: string;
  children: ConfigXmlNode[];
  sourceComments?: string[];
}

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

// 叶子缺省时的引擎默认值(kbengine_defaults.xml <dbmgr><databaseInterfaces><default>)
const ENGINE_DB_INTERFACE_DEFAULTS = {
  host: 'localhost',
  port: 3306,
  username: 'kbe',
  databaseName: 'kbe',
  characterSet: 'utf8mb4'
} as const;

export interface DatabaseInterfaceConfig {
  host: string;
  port: number;
  username: string;
  databaseName: string;
  encrypt: boolean;
  characterSet: string;
  plainPassword?: string;
}

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

/**
 * 合成配置的 telnet 速览(批112 用户令:"根据这个配置去获得 telnet 的端口和
 * 密码"):从最终生效配置逐组件读 <telnet_service> 端口/密码,与
 * telnetService 的合成读值同口径,供命令层在合成文档头部展示。
 */
/** 引擎各组件 telnet 默认端口(与 Rust core ENGINE_DEFAULT_TELNET_PORTS 同表;
 * 导出供 debugpyInstancePorts/autoDebugpy 等端口规划测试对撞用) */
export const ENGINE_DEFAULT_TELNET_PORTS: ReadonlyArray<{ component: string; port: number }> = [
  { component: 'loginapp', port: 31000 },
  { component: 'dbmgr', port: 32000 },
  { component: 'interfaces', port: 33000 },
  { component: 'logger', port: 34000 },
  { component: 'baseapp', port: 40000 },
  { component: 'cellapp', port: 50000 },
  { component: 'bots', port: 51000 }
];

export function summarizeFinalTelnet(finalConfig: string): Array<{
  component: string;
  port: number | null;
  password: string | null;
}> {
  // 合成文档里每个配置元素内部都带作用注释,先剥注释再取值(否则
  // `<!-- ... --> 40000` 落 Number() = NaN);无注释时行为不变。
  const xml = finalConfig.replace(/<!--[\s\S]*?-->/g, '');
  return ENGINE_DEFAULT_TELNET_PORTS.map(({ component }) => {
    const section = xml.match(new RegExp(`<${component}>([\\s\\S]*?)</${component}>`));
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


/** 元件配置 telnet_service 段读值(镜像 core custom_telnet:文档序首段) */
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

function customTelnetOf(tree: ConfigXmlNode | null): { port: number | null; password: string | null } | null {
  if (!tree) {
    return null;
  }
  const section = firstNode(tree, 'telnet_service');
  if (!section) {
    return null;
  }
  const pick = (name: string): string =>
    section.children.find(child => child.name === name)?.text.trim() ?? '';
  const portRaw = pick('port');
  const port = portRaw !== '' && Number.isFinite(Number(portRaw)) ? Number(portRaw) : null;
  const password = pick('password') !== '' ? pick('password') : null;
  return { port, password };
}

// ---- 门替身工厂:按 `$/kode/config/resolve` 契约回数(调用序可断言) ----
import { renderConfigXmlSections } from '../../src/serverConfigMerge';
import type { KodeCoreGate } from '../../src/kodeCoreGate';

export interface ContractGateCall {
  method: string;
  params: {
    defaultsXml: string | null;
    customXml: string | null;
  };
}

/** resolve 契约响应体(镜像 core resolve_config 产物;导出供各门替身复用) */
export function contractResolveResult(
  defaultsXml: string | null,
  customXml: string | null
): Record<string, unknown> {
  const defaultsTree = defaultsXml !== null ? parseConfigXml(defaultsXml) : null;
  const customTree = customXml !== null ? parseConfigXml(customXml) : null;
  const merged = defaultsTree
    ? customTree
      ? mergeConfigXml(defaultsTree, customTree)
      : defaultsTree
    : null;
  return {
    defaultsTree,
    customTree,
    merged,
    telnetSummary: merged !== null ? summarizeFinalTelnet(renderConfigXmlSections(merged)) : [],
    telnetDefaultPorts: Object.fromEntries(
      ENGINE_DEFAULT_TELNET_PORTS.map(entry => [entry.component, entry.port])
    ),
    customTelnet: customTelnetOf(customTree),
    dbInterface: merged !== null ? extractDatabaseInterfaceConfig(merged) : null
  };
}

/** 契约门替身:resolve 按镜像语义回数;其余方法调用方自行在 calls 里核对 */
export function makeContractGate(calls: ContractGateCall[]): KodeCoreGate {
  return {
    runInRust: async (method: string, params: unknown) => {
      calls.push({
        method,
        params: params as ContractGateCall['params']
      });
      if (method !== '$/kode/config/resolve') {
        return { ok: true as const, result: {} };
      }
      const p = params as { defaultsXml: string | null; customXml: string | null };
      return {
        ok: true as const,
        result: contractResolveResult(p.defaultsXml, p.customXml)
      };
    }
  } as unknown as KodeCoreGate;
}
