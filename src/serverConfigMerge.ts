import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ENGINE_DEFAULT_TELNET_PORTS,
  deriveEngineDefaultsXmlPath
} from './telnetService';
import { expandWorkspacePlaceholders } from './workspacePath';
import { resolveDiscoveredConfigRoot, resolveKbeSourceRoot } from './workspaceDiscovery';
import { annotateConfigTree } from './serverConfigAnnotations';
import {
  generatedCommentBody,
  sanitizeXmlComment,
  sourceCommentSameContent
} from './serverConfigCommentText';

// 注释文本工具在此仍按原名对外(既有调用/测试的入口不变),实现见
// serverConfigCommentText(与挂注释侧共用,避免循环依赖)
export { generatedCommentBody, sanitizeXmlComment, sourceCommentSameContent };

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
   * 的容器元素(归属规则见 parseConfigXml 文件头)。渲染时原样回写,与生成用
   * comment/docHeader 分两套——二者是文案库生成物,本字段是用户原文。
   * 声明/XML PI 不入树(仍丢弃)。
   */
  sourceComments?: string[];
  /**
   * 逐项作用注释(仅渲染期写入,parseConfigXml 不产出也不回读):
   * 由 annotateConfigTree 按文案库挂上,渲染时放进元素内部。
   * 渲染时源注释优先于本字段(去重见 renderConfigXml)。
   */
  comment?: string;
  /** 文档头注(合成来源与覆盖口径),同样只出现在元素内部;属生成物,
   * 源注释在前,且 kbengine.finalConfigComments 关闭时不输出 */
  docHeader?: string;
}

/**
 * 解析引擎风格的服务端配置 XML(仅需元素树,属性忽略;声明/XML PI 丢弃):
 * 注释不剥离——按位置关联进树(源注释归属规则):
 * - 紧跟 `</元素>` 同一行的行内/尾随注释 → 该元素(渲染时仍在值之后);
 * - 其余注释先挂起,归到下一个打开的元素(即「前导注释 → 紧随的元素」);
 * - 挂起的注释遇到所属容器闭合仍未归属(段尾)→ 挂回该容器;文件尾游离注释
 *   挂到段首容器元素;一个元素都没有(纯注释输入)则丢弃,照旧返回 null,不崩。
 * 根为伪节点(名字空),顶层各组件段作其 children。标签不闭合或多余
 * 闭合按已见内容容错,不抛——配置展示宁可显示半棵树也不崩命令。
 */
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

/**
 * 元件 kbengine.xml 定位:kbengine.assetsRoot(服务器资产目录,引擎
 * KBE_RES_PATH 中的项目侧)下的 kbengine.xml 优先,再按约定路径探测
 * 工作区根(与 telnet 约定路径一致)。取第一个存在的文件。
 * 批128:assetsRoot 未设或未过探针时,发现出的资产根同样参与(其下
 * res/server/kbengine.xml 是引擎装载口径的元件配置位置)。
 */
export function resolveCustomConfigXmlPath(
  workspaceRoot: string | undefined,
  /** profile 资产根(IDE-REV-015):给定时只在其下找,绝不混工作区/设置链(隔离) */
  overrideRoot?: string
): string | null {
  if (overrideRoot !== undefined) {
    // profile 面的元件配置只认 profile 自己的资产根:找不到 = 该 profile
    // 无元件配置(纯 defaults),不回落别处——回落即读到别的项目的配置
    const candidates = [
      path.join(overrideRoot, 'kbengine.xml'),
      path.join(overrideRoot, 'res', 'server', 'kbengine.xml')
    ];
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
  const config = vscode.workspace.getConfiguration('kbengine');
  const settingPath = expandWorkspacePlaceholders(
    config.get<string>('assetsRoot', ''),
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
export function buildMergedConfigTree(overrides: MergedConfigTreeOverrides = {}): MergedConfigTree {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const overridesBinPath = overrides.binPath !== undefined && overrides.binPath.length > 0
    ? overrides.binPath
    : undefined;
  const binPath = overridesBinPath
    ?? expandWorkspacePlaceholders(
      vscode.workspace.getConfiguration('kbengine').get<string>('binPath', ''),
      workspaceRoot
    );
  // 批125 自动发现:binPath 未配/推导不出时,用引擎源码根锚点兜底再推 defaults;
  // profile 覆盖轴不走发现链(profile 的根读不到 defaults = 如实无 defaults)
  let defaultsPath = deriveEngineDefaultsXmlPath(binPath);
  if (!defaultsPath && !overridesBinPath && workspaceRoot) {
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
  const overridesConfigRoot = overrides.configRoot !== undefined && overrides.configRoot.length > 0
    ? overrides.configRoot
    : undefined;
  const customPath = overridesConfigRoot !== undefined
    ? resolveCustomConfigXmlPath(workspaceRoot, overridesConfigRoot)
    : resolveCustomConfigXmlPath(workspaceRoot);
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
