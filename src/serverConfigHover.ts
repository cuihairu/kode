import * as vscode from 'vscode';

/**
 * 元件 kbengine.xml / 引擎 kbengine_defaults.xml 字段悬浮文档(批112 用户令:
 * "鼠标悬浮在配置上可以提示每个配置字段的作用")。说明文字逐条对照引擎源码
 * kbengine_defaults.xml 的双语注释与引擎文档整理,不臆造语义;键为
 * `<所在段>.<字段名>`(就近向上找整行 opener)或裸 `<字段名>`(无歧义时),
 * 先查带段的键、再查裸键。
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
 * 悬停解析(行级口径):当前行取第一个标签名作悬停目标;所在段自当前位置
 * 向上找最近的整行 opener(`^\s*<(\w+)>\s*$`)。先查 `段.标签` 再查裸标签,
 * 命中即产出 Markdown 悬停,否则 null(交回既有 .def/xml 悬停体系)。
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
  const doc =
    SERVER_CONFIG_FIELD_DOCS[`${section}.${tagMatch[1]}`] ??
    SERVER_CONFIG_FIELD_DOCS[tagMatch[1]];
  if (doc === undefined) {
    return null;
  }
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(doc);
  return new vscode.Hover(markdown);
}

/** 悬停提供者(随扩展装配注册,dispose 挂订阅链) */
export class ServerConfigHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    return provideServerConfigHover(document, position);
  }
}
