import * as vscode from 'vscode';
import { getHoverLanguage, HoverLanguage } from './hoverLocale';
import { configPathAtText, configSourceInfo, renderSourceEvidenceBlock } from './backend/configSourceFace';
import { computeKeyImpact, renderImpactBlock } from './backend/configImpact';
import { buildConfigTreePair, type ConfigTreePair } from './serverConfigMerge';
import { prepareConfigAnalysis } from './configCompletionProvider';
import { parseConfigXml } from './serverConfigFallbackCore';

/**
 * 元件 kbengine.xml / 引擎 kbengine_defaults.xml 字段悬浮文档(批112 用户令:
 * "鼠标悬浮在配置上可以提示每个配置字段的作用")。说明文字逐条对照引擎源码
 * kbengine_defaults.xml 的双语注释与引擎文档整理,不臆造语义;键为
 * `<所在段>.<字段名>`(就近向上找整行 opener)或裸 `<字段名>`(无歧义时),
 * 先查带段的键、再查裸键。
 *
 * IDE-I18N-002:文案语言跟 `kbengine.hover.language` 配置(auto 探测中文
 * 系统/UTC+8,默认英文;见 hoverLocale.ts)。下表为中文包,英文包
 * SERVER_CONFIG_FIELD_DOCS_EN 同键同数(测试锁两表全等与逐键互异),
 * 逐键取文优先所选语言,缺键回落本表——既有中文悬停不因语言面引入空悬停。
 */

/**
 * 悬停适用文档:元件配置 kbengine.xml 与引擎默认配置 kbengine_defaults.xml
 * (pattern 覆盖两处,types.xml/entities.xml 走既有 .def 悬停体系不在此列)。
 */
export const SERVER_CONFIG_SELECTOR: vscode.DocumentSelector = {
  language: 'xml',
  pattern: '**/kbengine*.xml'
};

export const SERVER_CONFIG_FIELD_DOCS: Record<string, string> = {
  // —— 组件段(裸键:段 opener 行自身悬停,向上无段时也落这里) ——
  machine: '**machine** 进程:甘道夫式探测/组网守护,负责多物理机组网与进程发现',
  logger: '**logger** 进程:收集各组件日志的独立进程',
  dbmgr: '**dbmgr** 进程:数据库管理,负责账号校验与实体数据读写',
  interfaces: '**interfaces** 进程:对接第三方计费/订单等外部系统',
  baseapp: '**baseapp** 进程:管理 base 实体、备份存档与客户端登录转发',
  cellapp: '**cellapp** 进程:管理 cell 实体、View/空间与负载平衡',
  loginapp: '**loginapp** 进程:登录网关,处理登录、账号创建与服务器列表下发',
  bots: '**bots** 进程:机器人压测进程',
  root: '元件 kbengine.xml 根节点,内含各组件进程的配置段',

  // —— 嵌套段 ——
  telnet_service:
    'Telnet 控制台服务(元件配置中启用即开启各组件 telnet 端口);端口被占用则向后尝试 +1(如 34001)',
  witness: '观察者(玩家就是观察者):观察到的实体信息同步给客户端',
  shutdown: '服务端关闭过程的参数(分批销毁节奏等)',
  profiles: '程序的性能分析相关开关',
  ids: 'entityID 分配器:进入溢出范围则请求获取新的 ID 资源',
  coordinate_system: '坐标系:1 = 基于网格,2 = 基于范围',
  databaseInterfaces: '可额外添加多个 interfaces 到地址池分担压力',
  account_system: '账号系统配置(dbmgr)',
  account_registration: '账号注册相关(dbmgr)',
  account_resetPassword: '找回/重置密码相关(dbmgr)',

  // —— 通用字段(裸键,语义全组件一致) ——
  entryScriptFile: '脚本入口模块,相当于 main 函数',
  internalInterface: '内部网络接口地址:可配置网卡名、MAC 或 IP',
  externalAddress:
    '对外暴露的地址;留空由引擎自动探测网卡(多网卡/公网映射时需显式指定)',
  externalTcpPorts_min: '暴露给客户端的 TCP 端口范围下限',
  externalTcpPorts_max: '暴露给客户端的 TCP 端口范围上限',
  externalUdpPorts_min: '暴露给客户端的 UDP 端口范围下限',
  externalUdpPorts_max: '暴露给客户端的 UDP 端口范围上限',
  SOMAXCONN: 'listen 监听队列最大值',
  orders_timeout: '订单超时(秒)',
  debug: 'debug 模式下可输出读写操作信息',
  shareDB: '是否共享数据库',
  allowEmptyDigest: '是否检查 defs-MD5 摘要(false 校验,配合资产同步一致性)',
  addDefaultAddress:
    'true 则自动将配置中的 Interfaces 地址加入地址池,免得改动 Interfaces 端口要修改多处',
  host: '服务器地址(IP/主机名)',
  default_layer: 'telnet 命令默认层(如 python)',
  defaultViewRadius: '默认 View 半径,脚本中可以改变它',
  aliasEntityID:
    '优化 EntityID:View 范围内实体数少于 255 个时,EntityID 传输到 client 使用 1 字节别名',
  entitydefAliasID:
    '广播带宽优化:Entity 客户端属性或方法不超过 255 个时,属性/方法用别名传输',
  cprofile: 'true 则引擎启动即开始记录 profile 信息,进程退出后导出一份报告',
  loadSmoothingBias: '负载平衡滤波器指标值',
  ghostUpdateHertz: 'ghost(远端实体镜像)更新频率',
  rangemgr_y:
    '是否管理 y 轴:管理后 View/Trap 等功能有了高度,空间内实体较少时更好用',
  entity_posdir_additional_updates:
    '实体位置停止变化后,引擎继续向客户端更新 tick 次的位置信息;0 = 总是更新',
  entity_posdir_updates: '实体位置更新方式(1 = 关键帧,2 = 每个位移包)',
  perSecsDestroyEntitySize: '每秒销毁带 base 部分的实体数量',
  archivePeriod: '实体存档周期(秒)',
  backupPeriod: '实体备份周期(秒)',
  backUpUndefinedProperties: '是否备份脚本未定义的属性',
  downloadStreaming: '资源下载带宽限制',
  bitsPerSecondPerClient: '每客户端带宽位速',
  entityRestoreSize: '灾难发生后 baseapp 进行灾难恢复时,每次恢复 entity 的数量',
  buffer_size: '资源池缓冲大小(KB):该大小以内的资源才可进入资源池',
  checktick: '资源池检查 tick(秒)',
  encrypt_login:
    '登录加密方式:0 = 无加密,1 = Blowfish,2 = RSA(res/key/kbengine_private.key)',
  account_type:
    '账号类型:1 = 普通账号,2 = email 账号(需激活),3 = 智能账号(自动识别 email/普通号码)',
  http_cbhost:
    'http 回调接口:处理认证、密码重置等(一般会被引擎替换为 externalInterface/externalAddress,仅第一个 loginapp 开启)',
  http_cbport: 'http 回调端口',
  forceInternalLogin:
    '对应 baseapp externalAddress 的解决方案:强制下发公网 IP 提供登录时,内部连接仍走内网',
  isOnInitCallPropertysSetMethods: '初始化时是否调用属性设置方法',
  defaultAddBots: '默认启动进程后自动添加这么多个机器人',
  account_name_prefix: '机器人账号名称的前缀',
  account_name_suffix_inc: '机器人账号名后缀递增:0 使用随机数递增,否则按所填数递增',
  tick_max_buffered_logs: '单个 app 进程上一个 tick 最多缓存的日志数量',
  tick_sync_logs: '单个 app 进程上一个 tick 同步给 logger 的日志数量',
  addresses:
    '多物理机组网被路由器禁止 UDP 广播时,在此填入所有相关物理机地址,引擎定向发探测包完成组网',
  accountEntityScriptType: '账号 Entity 的名称',
  accountDefaultFlags: '新账号默认标记(可组合,填写时按十进制格式)',
  accountDefaultDeadline: '新账号默认期限',
  loginAutoCreate: '登录合法但游戏数据库找不到游戏账号时自动创建',
  databaseName: '数据库名称',
  numConnections: '数据库连接池连接数',
  auth: '数据库认证方式',
  timeout:
    '超时(秒):witness 段为实体不被观察后的恢复延时;baseapp 段为资源池中资源闲置销毁时间',

  // —— 歧义字段带段键 ——
  'telnet_service.port': 'telnet 监听端口(0 = 不开启)',
  'telnet_service.password': 'telnet 登录密码(引擎默认 pwd123456)'
};

/**
 * 英文包(IDE-I18N-002):与 SERVER_CONFIG_FIELD_DOCS 同键同数,措辞对照引擎
 * kbengine_defaults.xml 注释的英文括注与引擎文档整理,不另造语义。
 */
export const SERVER_CONFIG_FIELD_DOCS_EN: Record<string, string> = {
  // —— 组件段(裸键:段 opener 行自身悬停,向上无段时也落这里) ——
  machine:
    '**machine** process: gandalf-style probe/network daemon; handles multi-machine networking and process discovery',
  logger: '**logger** process: standalone process collecting logs from all components',
  dbmgr: '**dbmgr** process: database manager; handles account verification and entity data read/write',
  interfaces: '**interfaces** process: connects third-party billing/order and other external systems',
  baseapp: '**baseapp** process: manages base entities, backup archives and client login forwarding',
  cellapp: '**cellapp** process: manages cell entities, View/space and load balancing',
  loginapp: '**loginapp** process: login gateway; handles login, account creation and server list delivery',
  bots: '**bots** process: robot stress-testing process',
  root: 'Component kbengine.xml root node; contains the config sections of all component processes',

  // —— 嵌套段 ——
  telnet_service:
    'Telnet console service (enabling it in the component config opens each component telnet port); if the port is taken it tries +1 (e.g. 34001)',
  witness: 'Witness (each player is a witness): entity information it observes is synced to the client',
  shutdown: 'Server shutdown process parameters (batched destruction pacing, etc.)',
  profiles: 'Program profiling switches',
  ids: 'entityID allocator: requests new ID ranges when entering the overflow range',
  coordinate_system: 'Coordinate system: 1 = grid-based, 2 = range-based',
  databaseInterfaces: 'Additional interfaces can be added to the address pool to share load',
  account_system: 'Account system config (dbmgr)',
  account_registration: 'Account registration (dbmgr)',
  account_resetPassword: 'Password find/reset (dbmgr)',

  // —— 通用字段(裸键,语义全组件一致) ——
  entryScriptFile: 'Script entry module, equivalent to the main function',
  internalInterface: 'Internal network interface address: NIC name, MAC or IP',
  externalAddress:
    'Externally exposed address; empty lets the engine auto-detect the NIC (set explicitly with multiple NICs/public NAT)',
  externalTcpPorts_min: 'Lower bound of the TCP port range exposed to clients',
  externalTcpPorts_max: 'Upper bound of the TCP port range exposed to clients',
  externalUdpPorts_min: 'Lower bound of the UDP port range exposed to clients',
  externalUdpPorts_max: 'Upper bound of the UDP port range exposed to clients',
  SOMAXCONN: 'Maximum listen backlog queue size',
  orders_timeout: 'Order timeout (seconds)',
  debug: 'debug mode can print read/write operation info',
  shareDB: 'Whether to share the database',
  allowEmptyDigest: 'Whether to check the defs-MD5 digest (false = verify, for asset sync consistency)',
  addDefaultAddress:
    'true adds the configured Interfaces address to the address pool automatically, so changing the Interfaces port does not require edits in multiple places',
  host: 'Server address (IP/hostname)',
  default_layer: 'Default telnet command layer (e.g. python)',
  defaultViewRadius: 'Default View radius; scripts can change it',
  aliasEntityID:
    'EntityID optimization: with fewer than 255 entities in View range, the EntityID sent to the client uses a 1-byte alias',
  entitydefAliasID:
    'Broadcast bandwidth optimization: with no more than 255 entity client properties or methods, they are transferred by alias',
  cprofile: 'true starts recording profile info at engine startup and exports a report on process exit',
  loadSmoothingBias: 'Load balance filter metric value',
  ghostUpdateHertz: 'ghost (remote entity mirror) update frequency',
  rangemgr_y:
    'Whether to manage the y-axis: gives View/Trap etc. a height dimension; better when entities in a space are sparse',
  entity_posdir_additional_updates:
    'After an entity stops moving, the engine keeps sending position updates to the client for this many ticks; 0 = always update',
  entity_posdir_updates: 'Entity position update mode (1 = key frames, 2 = every movement packet)',
  perSecsDestroyEntitySize: 'Number of entities with a base part destroyed per second',
  archivePeriod: 'Entity archive period (seconds)',
  backupPeriod: 'Entity backup period (seconds)',
  backUpUndefinedProperties: 'Whether to back up properties undefined by scripts',
  downloadStreaming: 'Resource download bandwidth limit',
  bitsPerSecondPerClient: 'Per-client bandwidth bit rate',
  entityRestoreSize: 'Number of entities restored per batch during baseapp disaster recovery',
  buffer_size: 'Resource pool buffer size (KB): only resources within this size enter the resource pool',
  checktick: 'Resource pool check tick (seconds)',
  encrypt_login:
    'Login encryption: 0 = none, 1 = Blowfish, 2 = RSA (res/key/kbengine_private.key)',
  account_type:
    'Account type: 1 = normal account, 2 = email account (needs activation), 3 = smart account (auto-detects email/normal)',
  http_cbhost:
    'http callback interface: handles authentication, password reset etc. (usually replaced by the engine with externalInterface/externalAddress; only the first loginapp enables it)',
  http_cbport: 'http callback port',
  forceInternalLogin:
    'Resolution for baseapp externalAddress: when a public IP is forced for login, internal connections still use the internal network',
  isOnInitCallPropertysSetMethods: 'Whether to call property set methods on initialization',
  defaultAddBots: 'Automatically add this many bots after processes start, by default',
  account_name_prefix: 'Prefix of bot account names',
  account_name_suffix_inc: 'Bot account name suffix increment: 0 = random increment, otherwise increments by the given number',
  tick_max_buffered_logs: 'Maximum logs buffered per tick on one app process',
  tick_sync_logs: 'Maximum logs synced to the logger per tick on one app process',
  addresses:
    'When multi-machine networking is blocked by routers forbidding UDP broadcast, list all relevant machine addresses here; the engine sends directed probe packets to complete networking',
  accountEntityScriptType: 'Name of the account Entity',
  accountDefaultFlags: 'Default flags of new accounts (combinable; enter in decimal)',
  accountDefaultDeadline: 'Default deadline of new accounts',
  loginAutoCreate: 'Auto-create the game account when login is valid but it is not found in the game database',
  databaseName: 'Database name',
  numConnections: 'Database connection pool size',
  auth: 'Database authentication method',
  timeout:
    'Timeout (seconds): witness section — restore delay after an entity stops being observed; baseapp section — idle destroy time of pooled resources',

  // —— 歧义字段带段键 ——
  'telnet_service.port': 'telnet listen port (0 = disabled)',
  'telnet_service.password': 'telnet login password (engine default pwd123456)'
};

/**
 * 语言取文:先查所选语言的带段键,再查裸键;英文面缺键回落中文表
 * (既有中文悬停永不为空,语言配置不引入空悬停)。
 */
export function serverConfigFieldDoc(
  qualifiedKey: string,
  bareKey: string,
  language: HoverLanguage
): string | undefined {
  const primary =
    language === 'en' ? SERVER_CONFIG_FIELD_DOCS_EN : SERVER_CONFIG_FIELD_DOCS;
  const hit = primary[qualifiedKey] ?? primary[bareKey];
  if (hit !== undefined) {
    return hit;
  }
  if (language === 'en') {
    return SERVER_CONFIG_FIELD_DOCS[qualifiedKey] ?? SERVER_CONFIG_FIELD_DOCS[bareKey];
  }
  return undefined;
}

/**
 * 悬停解析(行级口径):当前行取第一个标签名作悬停目标;所在段自当前位置
 * 向上找最近的整行 opener(`^\s*<(\w+)>\s*$`)。先查 `段.标签` 再查裸标签,
 * 命中即产出 Markdown 悬停,否则 null(交回既有 .def/xml 悬停体系)。
 * 文案语言随 `kbengine.hover.language`(IDE-I18N-002,见 hoverLocale.ts)。
 */
export function provideServerConfigHover(
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.Hover | null {
  const line = document.lineAt(position.line).text;
  const tagMatch = line.match(/<(\w+)[\s/>]/);
  if (!tagMatch) {
    return null;
  }
  let section = '';
  for (let i = position.line - 1; i >= 0; i--) {
    const opener = document.lineAt(i).text.match(/^\s*<(\w+)>\s*$/);
    if (opener) {
      section = opener[1];
      break;
    }
  }
  const doc = serverConfigFieldDoc(`${section}.${tagMatch[1]}`, tagMatch[1], getHoverLanguage());
  if (doc === undefined) {
    return null;
  }
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(doc);
  // KSEM-CFG-06:来源证据块(覆盖来源/生效值/单位;敏感值只给脱敏形态;
  // 树不可得(纯单测替身/非工作区)或路径不存在时静默不追加)
  const evidence = sourceEvidenceForHover(document, position);
  if (evidence !== null) {
    markdown.appendMarkdown(`\n\n${evidence}`);
  }
  // KSEM-CFG-10:修改影响块(受影响模块/默认回退/读取点;只读示数,
  // 零写入面;树不可得/路径不存在时静默不追加)
  const impact = configImpactForHover(document, position);
  if (impact !== null) {
    markdown.appendMarkdown(`\n\n${impact}`);
  }
  return new vscode.Hover(markdown);
}

/**
 * KSEM-CFG-06:悬停证据块装配(文档+位置→纯核心)。构建失败/树缺失/
 * 路径解析不出 → null(既有静态文案面不受影响)。
 */
export function sourceEvidenceForHover(
  document: vscode.TextDocument,
  position: vscode.Position
): string | null {
  const path = configPathAtText(document.getText(), document.offsetAt(position));
  if (path === null) {
    return null;
  }
  const pair = buildConfigTreePair();
  if (pair.defaultsTree === null && pair.customTree === null) {
    return null;
  }
  let extraction = null;
  if (pair.defaultsTree !== null) {
    extraction = prepareConfigAnalysis(pair.defaultsTree, pair.customTree).extraction;
  }
  const info = configSourceInfo(path, pair.customTree, pair.defaultsTree, extraction);
  return renderSourceEvidenceBlock(info, getHoverLanguage() === 'en' ? 'en' : 'zh');
}

/**
 * KSEM-CFG-10:修改影响块装配(文档+位置→纯核心)。构造零写入:只读树、
 * 只产出示数据。**修改未保存内容也刷新**:被悬停文档若是 custom/defaults
 * 配置文件本身,以其实文本现解析顶替盘上缓存树(盘树不含未保存编辑),
 * 默认回退/受影响模块随文档当前内容实时变化;其他文档不顶替(读别的
 * 文件的盘树是正确语义,不猜工作区外文本)。构建失败/路径解析不出 →
 * null(既有静态文案面不受影响)。
 */
export function configImpactForHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  pairOverride?: ConfigTreePair
): string | null {
  const path = configPathAtText(document.getText(), document.offsetAt(position));
  if (path === null) {
    return null;
  }
  const pair = pairOverride ?? buildConfigTreePair();
  if (pair.customTree === null && pair.defaultsTree === null) {
    return null;
  }
  let customTree = pair.customTree;
  let defaultsTree = pair.defaultsTree;
  // 未保存内容也刷新:被悬停文档是配置文件本身 → 实文本现解析顶替盘树
  const docPath = document.uri.fsPath;
  const live = parseConfigXml(document.getText());
  if (live !== null) {
    if (pair.customPath !== null && docPath === pair.customPath) {
      customTree = live;
    }
    if (pair.defaultsPath !== null && docPath === pair.defaultsPath) {
      defaultsTree = live;
    }
  }
  const impact = computeKeyImpact({
    path,
    face: 'engine-xml',
    customTree,
    defaultsTree
  });
  if (impact === null) {
    return null;
  }
  return renderImpactBlock(impact, getHoverLanguage() === 'en' ? 'en' : 'zh');
}

/** 悬停提供者(随扩展装配注册,dispose 挂订阅链) */
export class ServerConfigHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    // 批154:kbengine 服务配置悬停一枚独立开关(kbengine.hover.serverConfig)
    if (!vscode.workspace.getConfiguration('kbengine').get<boolean>('hover.serverConfig', true)) {
      return null;
    }
    return provideServerConfigHover(document, position);
  }
}
