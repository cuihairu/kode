// 最终配置注释文案库(用户令:final XML config 增强——按子分类 + 逐项作用注释)。
//
// 数据文件(便于维护,文案与分组全部集中在这里,渲染侧不写字):
// - kbe/res/server/kbengine_defaults.xml 引擎自带的双语注释逐条收割,source 即该
//   注释所在行(取证锚点);引擎没写注释的键人工补齐,source 指向引擎读取点
//   kbe/src/lib/server/serverconfig.cpp 等源码行,均不虚构语义;
// - 分组主轴:顶层段即进程(kbengine_defaults.xml 段名 = 进程名,serverconfig.cpp
//   逐段 getRootNode 读取),故段内子分类取功能轴(network/db/log/...)。
//
// 每条目:zh/en 双语必填,source 必填(取证),group 见 SERVER_CONFIG_GROUP_ORDER。
// 查不到的配置项一律落到 custom 子分类并标「未识别」。

export type ServerConfigGroup =
  | 'process'
  | 'net'
  | 'db'
  | 'account'
  | 'telnet'
  | 'log'
  | 'view'
  | 'backup'
  | 'perf'
  | 'test'
  | 'general'
  | 'custom';

/** 子分类展示名(zh/en 按 VS Code 显示语言取用) */
export interface ServerConfigGroupMeta {
  zh: string;
  en: string;
}

/** 子分类表:渲染注释时的「【分类】」标签与排序依据 */
export const SERVER_CONFIG_GROUPS: Record<ServerConfigGroup, ServerConfigGroupMeta> = {
  process: { zh: "进程与启动", en: "Process & Startup" },
  net: { zh: "网络与连接", en: "Network & Transport" },
  db: { zh: "数据库", en: "Database" },
  account: { zh: "账号与第三方对接", en: "Account & Integration" },
  telnet: { zh: "Telnet 控制台", en: "Telnet Console" },
  log: { zh: "日志与调试", en: "Logging & Debug" },
  view: { zh: "视图与空间", en: "View & Spatial" },
  backup: { zh: "备份与存档", en: "Backup & Archive" },
  perf: { zh: "性能与带宽", en: "Performance & Bandwidth" },
  test: { zh: "压测与机器人", en: "Stress & Bots" },
  general: { zh: "通用", en: "General" },
  custom: { zh: "自定义配置(未识别)", en: "Custom (unrecognized)" },
};

/** 子分类排序(自定义配置永远排最后,读者先看引擎认识的项) */
export const SERVER_CONFIG_GROUP_ORDER: readonly ServerConfigGroup[] = [
  'process',
  'net',
  'db',
  'account',
  'telnet',
  'log',
  'view',
  'backup',
  'perf',
  'test',
  'general',
  'custom'
];

/** 单条配置项的作用说明(双语 + 取证 + 子分类) */
export interface ServerConfigItemDoc {
  /** 中文作用说明 */
  zh: string;
  /** English description */
  en: string;
  /** 取证来源:引擎配置文件/源码的 file:line(或区间) */
  source: string;
  /** 功能子分类 */
  group: ServerConfigGroup;
}

/**
 * 配置项文案库:键为去掉配置根(<root>/<defaults> 等包裹段)后的点分路径,
 * 如 `baseapp.archivePeriod`、`trace_packet.disables`。
 */
export const SERVER_CONFIG_ITEM_DOCS: Readonly<Record<string, ServerConfigItemDoc>> = {
  "baseapp": { zh: "baseapp 进程:管理 base 实体、备份存档与客户端登录转发", en: "baseapp process: owns base entities, backup/archiving and client login forwarding", source: "kbe/res/server/kbengine_defaults.xml:588-716", group: 'process' },
  "baseapp.SOMAXCONN": { zh: "listen监听队列最大值", en: "listen: Maximum listen queue", source: "kbe/res/server/kbengine_defaults.xml:672", group: 'net' },
  "baseapp.archivePeriod": { zh: "自动存档的时间周期(秒)", en: "Automatic archiving time period(secs)", source: "kbe/res/server/kbengine_defaults.xml:618", group: 'backup' },
  "baseapp.backUpUndefinedProperties": { zh: "是否备份未定义的属性", en: "Whether backup undefined property", source: "kbe/res/server/kbengine_defaults.xml:628", group: 'backup' },
  "baseapp.backupPeriod": { zh: "自动备份的时间(秒)", en: "Automatic backup time period(secs)", source: "kbe/res/server/kbengine_defaults.xml:623", group: 'backup' },
  "baseapp.downloadStreaming": { zh: "资源下载带宽限制", en: "Download bandwidth limits", source: "kbe/res/server/kbengine_defaults.xml:638", group: 'perf' },
  "baseapp.downloadStreaming.bitsPerSecondPerClient": { zh: "单个客户端的资源下载带宽限制(位/秒)", en: "Per-client bandwidth cap for resource downloads (bits per second)", source: "kbe/res/server/kbengine_defaults.xml:638-643", group: 'perf' },
  "baseapp.downloadStreaming.bitsPerSecondTotal": { zh: "资源下载总带宽限制(位/秒)", en: "Total bandwidth cap for resource downloads (bits per second)", source: "kbe/res/server/kbengine_defaults.xml:638-642", group: 'perf' },
  "baseapp.entityRestoreSize": { zh: "当灾难发生后，baseapp进行灾难恢复时，每次恢复entity的数量", en: "When after the disaster, When baseapp recovery, Each time the number of recovery entity's", source: "kbe/res/server/kbengine_defaults.xml:653", group: 'backup' },
  "baseapp.entryScriptFile": { zh: "脚本入口模块， 相当于main函数", en: "Entry module, like the main-function", source: "kbe/res/server/kbengine_defaults.xml:589", group: 'process' },
  "baseapp.externalAddress": { zh: "强制指定外部IP地址或者域名，在某些网络环境下，可能会使用端口映射的方式来访问局域网内部的KBE服务器，那么KBE在当前 的机器上获得的外部地址是局域网地址，此时某些功能将会不正常。例如：账号激活邮件中给出的回调地址, 登录baseapp。 注意：服务端并不会检查这个地址的可用性，因为无法检查。", en: "Forced to specify an external IP-address or Domain-name, In some server environment, May use the port mapping to access KBE, So KBE on current machines on the external IP address may be a LAN IP address, Then some functions will not normal. For example: account activation email address given callback. Note: the availability of server does not check the address, because cannot check", source: "kbe/res/server/kbengine_defaults.xml:600", group: 'net' },
  "baseapp.externalInterface": { zh: "对外接口地址(可配置网卡名、MAC 或 IP),留空由引擎自动探测", en: "External interface address (NIC name, MAC or IP); empty means the engine detects it", source: "kbe/res/server/kbengine_defaults.xml:594-598", group: 'net' },
  "baseapp.externalTcpPorts_max": { zh: "暴露给客户端的 TCP 端口范围上限(0 = 使用默认)", en: "Upper bound of the TCP port range exposed to clients (0 = use default)", source: "kbe/res/server/kbengine_defaults.xml:610-614", group: 'net' },
  "baseapp.externalTcpPorts_min": { zh: "暴露给客户端的端口范围", en: "Exposed to the client port range", source: "kbe/res/server/kbengine_defaults.xml:610", group: 'net' },
  "baseapp.externalUdpPorts_max": { zh: "暴露给客户端的 UDP 端口范围上限", en: "Upper bound of the UDP port range exposed to clients", source: "kbe/res/server/kbengine_defaults.xml:610-616", group: 'net' },
  "baseapp.externalUdpPorts_min": { zh: "暴露给客户端的 UDP 端口范围下限", en: "Lower bound of the UDP port range exposed to clients", source: "kbe/res/server/kbengine_defaults.xml:610-615", group: 'net' },
  "baseapp.ids": { zh: "entityID分配器，进入溢出范围则请求获取新的ID资源", en: "The entityID allocator, enter the overflow area will get the new ID's", source: "kbe/res/server/kbengine_defaults.xml:646", group: 'process' },
  "baseapp.ids.criticallyLowSize": { zh: "entityID 池告警阈值:低于该值即向 dbmgr 申请新 ID 段(引擎下限 100)", en: "entityID pool warning threshold: below it the baseapp requests a new ID block from dbmgr (engine floor 100)", source: "kbe/src/lib/server/serverconfig.cpp:797-801", group: 'process' },
  "baseapp.internalInterface": { zh: "指定接口地址，可配置网卡名、MAC、IP", en: "Interface address specified, configurable NIC/MAC/IP", source: "kbe/res/server/kbengine_defaults.xml:594", group: 'net' },
  "baseapp.loadSmoothingBias": { zh: "负载平衡滤波器指标值", en: "Load balancing Smoothing Bias value", source: "kbe/res/server/kbengine_defaults.xml:633", group: 'view' },
  "baseapp.profiles": { zh: "程序的性能分析开关(cprofile/pyprofile/eventprofile/networkprofile)", en: "Program profiling switches (cprofile/pyprofile/eventprofile/networkprofile)", source: "kbe/res/server/kbengine_defaults.xml:658-670", group: 'log' },
  "baseapp.profiles.cprofile": { zh: "如果设置为true，引擎启动时就会开始记录相关profile信息， 进程退出后将导出一份报告", en: "if is true, Engine start is completed, start to record profile information, Process exit will export a report.", source: "kbe/res/server/kbengine_defaults.xml:662", group: 'log' },
  "baseapp.profiles.eventprofile": { zh: "true = 启动即开始记录事件 profile,进程退出导出报告", en: "true = start recording the event profile at launch, a report is exported on process exit", source: "kbe/src/lib/server/serverconfig.cpp:833-836", group: 'log' },
  "baseapp.profiles.networkprofile": { zh: "true = 启动即开始记录网络 profile,进程退出导出报告", en: "true = start recording the network profile at launch, a report is exported on process exit", source: "kbe/src/lib/server/serverconfig.cpp:839-842", group: 'log' },
  "baseapp.profiles.pyprofile": { zh: "true = 启动即开始记录 Python profile,进程退出导出报告", en: "true = start recording the Python profile at launch, a report is exported on process exit", source: "kbe/src/lib/server/serverconfig.cpp:827-830", group: 'log' },
  "baseapp.respool": { zh: "资源池:缓冲区大小、闲置销毁时间与检查 tick", en: "Resource pool: buffer size, idle destroy timeout and check tick", source: "kbe/res/server/kbengine_defaults.xml:699-715", group: 'perf' },
  "baseapp.respool.buffer_size": { zh: "缓冲区大小也等于资源大小， 在这个KB大小范围以内的资源才可以进入资源池", en: "Buffer size is equal to the size of resources, Less than the buffer resources before they can enter the resource pool", source: "kbe/res/server/kbengine_defaults.xml:700", group: 'perf' },
  "baseapp.respool.checktick": { zh: "资源池检查tick(秒)", en: "Resource pool check tick (secs)", source: "kbe/res/server/kbengine_defaults.xml:711", group: 'perf' },
  "baseapp.respool.timeout": { zh: "资源池中的资源超过这个时间未被访问则销毁(秒)", en: "Resources have not been accessed overtime will be destroyed (s)", source: "kbe/res/server/kbengine_defaults.xml:706", group: 'perf' },
  "baseapp.shutdown": { zh: "服务端关闭过程的参数", en: "Parameter server shutdown process", source: "kbe/res/server/kbengine_defaults.xml:689", group: 'backup' },
  "baseapp.shutdown.perSecsDestroyEntitySize": { zh: "每秒销毁base的数量", en: "The destroy of the per-seconds base's", source: "kbe/res/server/kbengine_defaults.xml:693", group: 'backup' },
  "baseapp.telnet_service": { zh: "Telnet服务, 如果端口被占用则向后尝试40001..", en: "Telnet service, if the port is occupied backwards to try 40001", source: "kbe/res/server/kbengine_defaults.xml:677", group: 'telnet' },
  "baseapp.telnet_service.default_layer": { zh: "命令默认层", en: "layer of default the command", source: "kbe/res/server/kbengine_defaults.xml:683", group: 'telnet' },
  "baseapp.telnet_service.password": { zh: "telnet 登录密码(引擎默认 pwd123456)", en: "telnet login password (engine default pwd123456)", source: "kbe/res/server/kbengine_defaults.xml:682", group: 'telnet' },
  "baseapp.telnet_service.port": { zh: "telnet 监听端口(引擎默认 40000;段注释:端口被占用则向后尝试 40001..)", en: "telnet listen port (engine default 40000; section note: when the port is taken the engine tries 40001.. next)", source: "kbe/res/server/kbengine_defaults.xml:677-682", group: 'telnet' },
  "baseappmgr": { zh: "baseappmgr 进程:调度与监控 baseapp,管理 base 实体分配", en: "baseappmgr process: schedules and monitors baseapp, manages base entity assignment", source: "kbe/res/server/kbengine_defaults.xml:730-740", group: 'process' },
  "baseappmgr.SOMAXCONN": { zh: "listen监听队列最大值", en: "listen: Maximum listen queue", source: "kbe/res/server/kbengine_defaults.xml:731", group: 'net' },
  "baseappmgr.internalInterface": { zh: "指定接口地址，可配置网卡名、MAC、IP", en: "Interface address specified, configurable NIC/MAC/IP", source: "kbe/res/server/kbengine_defaults.xml:736", group: 'net' },
  "bitsPerSecondToClient": { zh: "每秒发送到客户端的带宽限制", en: "bit The data sent to the client, the second bandwidth limit (bit)", source: "kbe/res/server/kbengine_defaults.xml:7", group: 'perf' },
  "bots": { zh: "bots 进程:机器人压测,虚拟客户端批量登录", en: "bots process: stress-test robots, virtual clients logging in bulk", source: "kbe/res/server/kbengine_defaults.xml:833-902", group: 'process' },
  "bots.account_infos": { zh: "机器人账号相关", en: "about bots-accounts", source: "kbe/res/server/kbengine_defaults.xml:873", group: 'account' },
  "bots.account_infos.account_name_prefix": { zh: "机器人账号名称的前缀", en: "The account name prefix", source: "kbe/res/server/kbengine_defaults.xml:877", group: 'account' },
  "bots.account_infos.account_name_suffix_inc": { zh: "机器人账号名称的后缀递增, 0使用随机数递增， 否则按照填写的数递增 注意：想让机器人每次登陆使用相同的账号请设置固定的bots程序启动时的cid参数，具体参考服务器启动脚本，机器人账号由\"前缀+cid+后缀组成\"。", en: "The account name suffix, 0 is the use of random number, Otherwise, use account_name_suffix_inc and increasing.", source: "kbe/res/server/kbengine_defaults.xml:882", group: 'account' },
  "bots.account_infos.account_password": { zh: "机器人账号密码(与前缀/后缀拼出的账号名配套)", en: "Bot account password (pairs with the name built from prefix + suffix)", source: "kbe/src/lib/server/serverconfig.cpp:1481-1484", group: 'account' },
  "bots.defaultAddBots": { zh: "默认启动进程后自动添加这么多个机器人 totalCount ： 添加总数量 tickTime ： 每次添加所用时间 tickCount ： 每次添加数量", en: "After starting the process, automatically add some robots Add the total-number s Interval time-secs Each time you add the number of", source: "kbe/res/server/kbengine_defaults.xml:861", group: 'test' },
  "bots.defaultAddBots.tickCount": { zh: "每个时间间隔添加的机器人数量", en: "Number of bots added per interval", source: "kbe/res/server/kbengine_defaults.xml:861-870", group: 'test' },
  "bots.defaultAddBots.tickTime": { zh: "每次添加机器人的时间间隔(秒)", en: "Interval between bot batches in seconds", source: "kbe/res/server/kbengine_defaults.xml:861-869", group: 'test' },
  "bots.defaultAddBots.totalCount": { zh: "启动后自动添加的机器人总数", en: "Total number of bots added automatically after startup", source: "kbe/res/server/kbengine_defaults.xml:861-868", group: 'test' },
  "bots.entryScriptFile": { zh: "脚本入口模块， 相当于main函数", en: "Entry module, like the main-function", source: "kbe/res/server/kbengine_defaults.xml:834", group: 'process' },
  "bots.forceInternalLogin": { zh: "对应baseapp的externalAddress的解决方案，当externalAddress强制下发公网IP提供登陆时， 如果局域网内部使用机器人测试也走公网IP和流量可能会不合适，此时可以设置为true，登陆时强制直接使用内网环境。", en: "Corresponding to baseapp->externalAddress solution, when externalAddress mandatory release of the public network to provide landing IP, If the use of robot within the LAN test also take the public network IP and traffic may be inappropriate, can be set to true, when landing forced to use the internal network environment.", source: "kbe/res/server/kbengine_defaults.xml:844", group: 'net' },
  "bots.host": { zh: "loginapp地址 （loginapp address)", en: "loginapp address.", source: "kbe/res/server/kbengine_defaults.xml:851", group: 'net' },
  "bots.internalInterface": { zh: "指定接口地址，可配置网卡名、MAC、IP", en: "Interface address specified, configurable NIC/MAC/IP", source: "kbe/res/server/kbengine_defaults.xml:839", group: 'net' },
  "bots.isOnInitCallPropertysSetMethods": { zh: "在Entity初始化时是否触发属性的set_*事件", en: "Whether to trigger property set_* events when an Entity is initialized.", source: "kbe/res/server/kbengine_defaults.xml:858", group: 'account' },
  "bots.port_max": { zh: "机器人登录 loginapp 的端口范围上限(小于下限时取下限)", en: "Upper bound of the loginapp port range used by bots (clamped up to the lower bound)", source: "kbe/src/lib/server/serverconfig.cpp:1428-1436", group: 'net' },
  "bots.port_min": { zh: "机器人登录 loginapp 的端口范围下限", en: "Lower bound of the loginapp port range used by bots", source: "kbe/src/lib/server/serverconfig.cpp:1424-1426", group: 'net' },
  "bots.telnet_service": { zh: "Telnet服务, 如果端口被占用则向后尝试51001..", en: "Telnet service, if the port is occupied backwards to try 51001", source: "kbe/res/server/kbengine_defaults.xml:891", group: 'telnet' },
  "bots.telnet_service.default_layer": { zh: "命令默认层", en: "layer of default the command", source: "kbe/res/server/kbengine_defaults.xml:897", group: 'telnet' },
  "bots.telnet_service.password": { zh: "telnet 登录密码(引擎默认 pwd123456)", en: "telnet login password (engine default pwd123456)", source: "kbe/res/server/kbengine_defaults.xml:896", group: 'telnet' },
  "bots.telnet_service.port": { zh: "telnet 监听端口(引擎默认 51000;段注释:端口被占用则向后尝试 51001..)", en: "telnet listen port (engine default 51000; section note: when the port is taken the engine tries 51001.. next)", source: "kbe/res/server/kbengine_defaults.xml:891-896", group: 'telnet' },
  "callback_timeout": { zh: "callback默认超时时间(秒)", en: "The callback: default timeout(seconds)", source: "kbe/res/server/kbengine_defaults.xml:213", group: 'process' },
  "cellapp": { zh: "cellapp 进程:管理 cell 实体、View/空间与负载平衡", en: "cellapp process: owns cell entities, View/space and load balancing", source: "kbe/res/server/kbengine_defaults.xml:447-586", group: 'process' },
  "cellapp.SOMAXCONN": { zh: "listen监听队列最大值", en: "listen: Maximum listen queue", source: "kbe/res/server/kbengine_defaults.xml:582", group: 'net' },
  "cellapp.aliasEntityID": { zh: "优化EntityID，View范围内实体数小于255个, EntityID传输到client时使用1字节别名ID", en: "1byte （Optimization EntityID，View the Entity is less than 255, use an aliasID transmitted to the client)", source: "kbe/res/server/kbengine_defaults.xml:461", group: 'view' },
  "cellapp.coordinate_system": { zh: "是否使用坐标系统, 如果设置为false， 那么View、Trap、 Move等功能将不可用", en: "Whether the use of coordinate-system, if is false, View, Trap, Move and other functions will not be available", source: "kbe/res/server/kbengine_defaults.xml:512", group: 'view' },
  "cellapp.coordinate_system.enable": { zh: "是否启用坐标系统:关闭后 View/Trap/Move 等功能不可用", en: "Whether the coordinate system is enabled: turning it off disables View/Trap/Move and friends", source: "kbe/res/server/kbengine_defaults.xml:512-517", group: 'view' },
  "cellapp.coordinate_system.entity_posdir_additional_updates": { zh: "实体位置停止发生改变后，引擎继续向客户端更新tick次的位置信息，为0则总是更新。", en: "After stopping to change the position/direction, the engine continued to update client information(position/direction) ticks If 0, then always update", source: "kbe/res/server/kbengine_defaults.xml:527", group: 'view' },
  "cellapp.coordinate_system.entity_posdir_updates": { zh: "实体位置更新方式， 0：直接同步高精度浮点数据，View范围无限制。 1：优化同步，降低海量同屏时带宽使用，有小许精度损耗，View范围限制在500以内。 2：智能选择模式，当同屏人数小于等于smartThreshold时使用0方式同步，否则使用1方式。View范围限制在500以内。", en: "Entity position update mode: 0 = sync high-precision floats directly (unlimited View range); 1 = optimized sync, less bandwidth with many entities on screen, slight precision loss, View range capped at 500; 2 = smart mode, uses 0 when on-screen entities <= smartThreshold, otherwise 1, View range capped at 500.", source: "kbe/res/server/kbengine_defaults.xml:534", group: 'view' },
  "cellapp.coordinate_system.entity_posdir_updates.smartThreshold": { zh: "智能模式的同屏人数阈值:不超过该值时用高精度同步方式", en: "On-screen entity threshold for smart mode: at or below it the high-precision mode is used", source: "kbe/res/server/kbengine_defaults.xml:537", group: 'view' },
  "cellapp.coordinate_system.entity_posdir_updates.type": { zh: "实体位置同步方式:0 = 高精度直发(View 无限制),1 = 优化同步(View 限 500),2 = 智能选择(同屏数 <= smartThreshold 用 0,否则 1)", en: "Entity position sync mode: 0 = high-precision direct sync (unlimited View), 1 = optimized sync (View capped at 500), 2 = smart (mode 0 while on-screen entities <= smartThreshold, else mode 1)", source: "kbe/res/server/kbengine_defaults.xml:534-541", group: 'view' },
  "cellapp.coordinate_system.rangemgr_y": { zh: "是否管理y轴? 注：管理y轴，则View、Trap等功能有了高度，当space内的实体较少时比较好用， 否则y轴的管理会带来一些消耗", en: "(is maintenance Y axis? Note: Management y axis, View、Trap and other functions with the height, When the entity space within little more useful when, Otherwise, the management of the y-axis will produce some consumption", source: "kbe/res/server/kbengine_defaults.xml:519", group: 'view' },
  "cellapp.defaultViewRadius": { zh: "默认View半径, 脚本中可以改变它", en: "Default View radius, the script can change it", source: "kbe/res/server/kbengine_defaults.xml:453", group: 'view' },
  "cellapp.defaultViewRadius.hysteresisArea": { zh: "离开 View 时的滞回区域:进入/离开视野的缓冲距离", en: "Hysteresis area when leaving View: the buffer distance for entering/leaving the view", source: "kbe/src/lib/server/serverconfig.cpp:577-579", group: 'view' },
  "cellapp.defaultViewRadius.radius": { zh: "默认 View 半径(脚本运行期可改)", en: "Default View radius (changeable from script at runtime)", source: "kbe/res/server/kbengine_defaults.xml:453-457", group: 'view' },
  "cellapp.entitydefAliasID": { zh: "优化Entity属性和方法在广播时所消耗的带宽，Entity客户端属性或者客户端方法不超过255时， 方法uid和属性uid传输到client时使用1字节别名ID", en: "Entity client (property or a method) is less than 256, using 1 byte transmission.", source: "kbe/res/server/kbengine_defaults.xml:467", group: 'view' },
  "cellapp.entryScriptFile": { zh: "脚本入口模块， 相当于main函数", en: "Entry module, like the main-function", source: "kbe/res/server/kbengine_defaults.xml:448", group: 'process' },
  "cellapp.ghostDistance": { zh: "ghost(跨 cell 的远端实体镜像)距离参数;引擎从 cellapp 段读入,当前源码仅见读取点,语义未在源码/文档中取证", en: "ghost (remote entity mirror across cells) distance parameter; read from the cellapp section, only the read site is present in the current source, semantics not evidenced", source: "kbe/src/lib/server/serverconfig.cpp:641-643", group: 'view' },
  "cellapp.ghostUpdateHertz": { zh: "ghost更新频率", en: "Update frequency process", source: "kbe/res/server/kbengine_defaults.xml:507", group: 'view' },
  "cellapp.ghostingMaxPerCheck": { zh: "ghost 每次检查上限参数;引擎从 cellapp 段读入,当前源码仅见读取点,语义未在源码/文档中取证", en: "ghost per-check cap parameter; read from the cellapp section, only the read site is present in the current source, semantics not evidenced", source: "kbe/src/lib/server/serverconfig.cpp:646-648", group: 'view' },
  "cellapp.ids": { zh: "entityID分配器，进入溢出范围则请求获取新的ID资源", en: "The entityID allocator, enter the overflow area will get the new ID's", source: "kbe/res/server/kbengine_defaults.xml:478", group: 'process' },
  "cellapp.ids.criticallyLowSize": { zh: "entityID 池告警阈值:低于该值即向 dbmgr 申请新 ID 段(引擎下限 100,且不得超过 dbmgr increasing_range/2)", en: "entityID pool warning threshold: below it the cellapp requests a new ID block from dbmgr (engine floor 100, never above dbmgr increasing_range/2)", source: "kbe/src/lib/server/serverconfig.cpp:585-590", group: 'process' },
  "cellapp.internalInterface": { zh: "指定接口地址，可配置网卡名、MAC、IP", en: "Interface address specified, configurable NIC/MAC/IP", source: "kbe/res/server/kbengine_defaults.xml:473", group: 'net' },
  "cellapp.loadSmoothingBias": { zh: "负载平衡滤波器指标值", en: "Load balancing Smoothing Bias value", source: "kbe/res/server/kbengine_defaults.xml:499", group: 'view' },
  "cellapp.profiles": { zh: "程序的性能分析开关(cprofile/pyprofile/eventprofile/networkprofile)", en: "Program profiling switches (cprofile/pyprofile/eventprofile/networkprofile)", source: "kbe/res/server/kbengine_defaults.xml:485-497", group: 'log' },
  "cellapp.profiles.cprofile": { zh: "如果设置为true，引擎启动时就会开始记录相关profile信息， 进程退出后将导出一份报告", en: "if is true, Engine start is completed, start to record profile information, Process exit will export a report.", source: "kbe/res/server/kbengine_defaults.xml:489", group: 'log' },
  "cellapp.profiles.eventprofile": { zh: "true = 启动即开始记录事件 profile,进程退出导出报告", en: "true = start recording the event profile at launch, a report is exported on process exit", source: "kbe/src/lib/server/serverconfig.cpp:609-612", group: 'log' },
  "cellapp.profiles.networkprofile": { zh: "true = 启动即开始记录网络 profile,进程退出导出报告", en: "true = start recording the network profile at launch, a report is exported on process exit", source: "kbe/src/lib/server/serverconfig.cpp:615-618", group: 'log' },
  "cellapp.profiles.pyprofile": { zh: "true = 启动即开始记录 Python profile,进程退出导出报告", en: "true = start recording the Python profile at launch, a report is exported on process exit", source: "kbe/src/lib/server/serverconfig.cpp:603-606", group: 'log' },
  "cellapp.shutdown": { zh: "服务端关闭过程的参数", en: "Parameter server shutdown process", source: "kbe/res/server/kbengine_defaults.xml:557", group: 'backup' },
  "cellapp.shutdown.perSecsDestroyEntitySize": { zh: "每秒销毁有base部分的entity的数量", en: "In per-seconds, The destruction of the number of entity's(has base)", source: "kbe/res/server/kbengine_defaults.xml:561", group: 'backup' },
  "cellapp.telnet_service": { zh: "Telnet服务, 如果端口被占用则向后尝试50001..", en: "Telnet service, if the port is occupied backwards to try 50001", source: "kbe/res/server/kbengine_defaults.xml:545", group: 'telnet' },
  "cellapp.telnet_service.default_layer": { zh: "命令默认层", en: "layer of default the command", source: "kbe/res/server/kbengine_defaults.xml:551", group: 'telnet' },
  "cellapp.telnet_service.password": { zh: "telnet 登录密码(引擎默认 pwd123456)", en: "telnet login password (engine default pwd123456)", source: "kbe/res/server/kbengine_defaults.xml:550", group: 'telnet' },
  "cellapp.telnet_service.port": { zh: "telnet 监听端口(引擎默认 50000;段注释:端口被占用则向后尝试 50001..)", en: "telnet listen port (engine default 50000; section note: when the port is taken the engine tries 50001.. next)", source: "kbe/res/server/kbengine_defaults.xml:545-550", group: 'telnet' },
  "cellapp.witness": { zh: "谁是观察者? 玩家就是观察者，观察到的信息会同步给客户端。 开发者可以设计为NPC/Monster在被观察时才激活AI，这样可以减少服务端的CPU消耗。参考Entity.onWitnessed", en: "Who is witness? Player is witness, The observed information will be synchronized to the client. Developers can be designed to: Activation (NPC / Monster) AI was observed when, This can reduce server CPU consumption. see also: Entity.onWitnessed.", source: "kbe/res/server/kbengine_defaults.xml:567", group: 'view' },
  "cellapp.witness.timeout": { zh: "当一个实体不再被观察者观察之后，实体并不会马上恢复为未被观察状态，在timeout(秒)时间范围内没有再次被观察则重置状态", en: "When the observer to stop observing entity, Entity does not recovery immediately to the initial-state, Not observed before timeout again, the recovery state.", source: "kbe/res/server/kbengine_defaults.xml:575", group: 'view' },
  "cellappmgr": { zh: "cellappmgr 进程:调度与监控 cellapp,维护 space 到 cell 的分配", en: "cellappmgr process: schedules and monitors cellapp, keeps spaces assigned to cells", source: "kbe/res/server/kbengine_defaults.xml:718-728", group: 'process' },
  "cellappmgr.SOMAXCONN": { zh: "listen监听队列最大值", en: "listen: Maximum listen queue", source: "kbe/res/server/kbengine_defaults.xml:719", group: 'net' },
  "cellappmgr.internalInterface": { zh: "指定接口地址，可配置网卡名、MAC、IP", en: "Interface address specified, configurable NIC/MAC/IP", source: "kbe/res/server/kbengine_defaults.xml:724", group: 'net' },
  "channelCommon": { zh: "内部组件通道与外部客户端通道的公共网络参数(超时/缓冲/窗口/加密/可靠 UDP/SSL)", en: "Common network parameters for internal component channels and external client channels (timeout/buffer/window/encryption/reliable UDP/SSL)", source: "kbe/res/server/kbengine_defaults.xml:101-199", group: 'net' },
  "channelCommon.encrypt_type": { zh: "加密通信，只对外部通道 可选择的加密方式 : 0: 无加密", en: "Encrypted communication, channel-external only Optional encryption No Encryption res\\key\\kbengine_private.key 1: Blowfish 2: RSA", source: "kbe/res/server/kbengine_defaults.xml:158", group: 'net' },
  "channelCommon.readBufferSize": { zh: "TCP socket读写缓冲大小", en: "socket send/recv buffer size", source: "kbe/res/server/kbengine_defaults.xml:110", group: 'net' },
  "channelCommon.readBufferSize.external": { zh: "外部通道 socket 读缓冲(字节):0 = 使用系统默认", en: "External channel socket read buffer in bytes; 0 = system default", source: "kbe/res/server/kbengine_defaults.xml:110-115", group: 'net' },
  "channelCommon.readBufferSize.internal": { zh: "内部通道 socket 读缓冲(字节):引擎默认 16M", en: "Internal channel socket read buffer in bytes (engine default 16M)", source: "kbe/res/server/kbengine_defaults.xml:110-114", group: 'net' },
  "channelCommon.reliableUDP": { zh: "可靠 UDP(RUDP)通道参数(队列/定时器/MTU/拥塞控制/Nagle)", en: "Reliable UDP (RUDP) channel parameters (queues/timers/MTU/congestion control/Nagle)", source: "kbe/res/server/kbengine_defaults.xml:168-194", group: 'net' },
  "channelCommon.reliableUDP.congestionControl": { zh: "false = 关闭拥塞控制", en: "false: disable congestion control", source: "kbe/res/server/kbengine_defaults.xml:191", group: 'net' },
  "channelCommon.reliableUDP.minRTO": { zh: "重传超时时间 RTO(毫秒)", en: "Retransmission TimeOut(millisec)", source: "kbe/res/server/kbengine_defaults.xml:183", group: 'net' },
  "channelCommon.reliableUDP.missAcksResend": { zh: "跳过 ACK 的重发次数,0 = 默认", en: "ACK skipping times, 0 is default", source: "kbe/res/server/kbengine_defaults.xml:185", group: 'net' },
  "channelCommon.reliableUDP.mtu": { zh: "MTU 大小,0 = 默认(1400)", en: "change MTU size, 0 is default(1400)", source: "kbe/res/server/kbengine_defaults.xml:188", group: 'net' },
  "channelCommon.reliableUDP.nodelay": { zh: "true = 关闭 Nagle 算法,数据包立即发送", en: "true = disable the Nagle algorithm, packets are sent immediately", source: "kbe/src/lib/server/serverconfig.cpp:476-479", group: 'net' },
  "channelCommon.reliableUDP.readPacketsQueueSize": { zh: "等价于 TCP RCV_BUF,单位为 UDP 包数", en: "Equivalent to TCP RCV_BUF, unit is the number of UDP-packages", source: "kbe/res/server/kbengine_defaults.xml:169", group: 'net' },
  "channelCommon.reliableUDP.readPacketsQueueSize.external": { zh: "外部通道的收包队列长度(UDP 包数)", en: "External channel receive packet queue length (UDP packets)", source: "kbe/res/server/kbengine_defaults.xml:170-172", group: 'net' },
  "channelCommon.reliableUDP.readPacketsQueueSize.internal": { zh: "内部通道的收包队列长度(UDP 包数)", en: "Internal channel receive packet queue length (UDP packets)", source: "kbe/res/server/kbengine_defaults.xml:170-172", group: 'net' },
  "channelCommon.reliableUDP.tickInterval": { zh: "内部更新定时器间隔(毫秒),0 = 默认(100 毫秒)", en: "internal update timer interval in millisec, 0 is default(100millisec)", source: "kbe/res/server/kbengine_defaults.xml:181", group: 'net' },
  "channelCommon.reliableUDP.writePacketsQueueSize": { zh: "等价于 TCP SND_BUF,单位为 UDP 包数", en: "Equivalent to TCP SND_BU, unit is the number of UDP-packages", source: "kbe/res/server/kbengine_defaults.xml:175", group: 'net' },
  "channelCommon.reliableUDP.writePacketsQueueSize.external": { zh: "外部通道的发包队列长度(UDP 包数)", en: "External channel send packet queue length (UDP packets)", source: "kbe/res/server/kbengine_defaults.xml:176-178", group: 'net' },
  "channelCommon.reliableUDP.writePacketsQueueSize.internal": { zh: "内部通道的发包队列长度(UDP 包数)", en: "Internal channel send packet queue length (UDP packets)", source: "kbe/res/server/kbengine_defaults.xml:176-178", group: 'net' },
  "channelCommon.sslCertificate": { zh: "HTTPS/WSS/SSL 通信所需的证书文件", en: "Certificate file required for HTTPS/WSS/SSL communication", source: "kbe/res/server/kbengine_defaults.xml:196", group: 'net' },
  "channelCommon.sslPrivateKey": { zh: "HTTPS/WSS/SSL 通信所需的私钥文件(与 sslCertificate 配对)", en: "Private key file required for HTTPS/WSS/SSL communication (pairs with sslCertificate)", source: "kbe/res/server/kbengine_defaults.xml:196-198", group: 'net' },
  "channelCommon.timeout": { zh: "最后一次通信时间超过此时间则被认定为超时通道， 服务器将踢出该通道（秒）", en: "If long (configurable value) no communication, channel will be kicked out of the server.", source: "kbe/res/server/kbengine_defaults.xml:102", group: 'net' },
  "channelCommon.timeout.external": { zh: "外部(客户端)通道空闲超时(秒):超过则该通道被服务器踢出", en: "External (client) channel idle timeout in seconds; the channel is kicked out by the server after it", source: "kbe/res/server/kbengine_defaults.xml:102-108", group: 'net' },
  "channelCommon.timeout.internal": { zh: "内部(组件间)通道空闲超时(秒):超过则该通道被服务器踢出", en: "Internal (component-to-component) channel idle timeout in seconds; the channel is kicked out by the server after it", source: "kbe/res/server/kbengine_defaults.xml:102-108", group: 'net' },
  "channelCommon.windowOverflow": { zh: "发送与接收窗口溢出值，0无限制", en: "the value of the send/receive window overflow, 0 is unlimited", source: "kbe/res/server/kbengine_defaults.xml:122", group: 'net' },
  "channelCommon.windowOverflow.receive": { zh: "接收窗口溢出限制:收到的条数/字节数超限即视为溢出,0 = 无限制", en: "Receive window overflow limits: incoming message/byte caps, 0 = unlimited", source: "kbe/res/server/kbengine_defaults.xml:145-155", group: 'net' },
  "channelCommon.windowOverflow.receive.bytes": { zh: "接收窗口:字节数溢出限制", en: "Receive window: byte-count overflow limit", source: "kbe/res/server/kbengine_defaults.xml:151-154", group: 'net' },
  "channelCommon.windowOverflow.receive.bytes.external": { zh: "外部通道的接收字节数上限(0 = 无限制)", en: "External channel receive byte cap (0 = unlimited)", source: "kbe/res/server/kbengine_defaults.xml:153", group: 'net' },
  "channelCommon.windowOverflow.receive.bytes.internal": { zh: "内部通道的接收字节数上限(0 = 无限制)", en: "Internal channel receive byte cap (0 = unlimited)", source: "kbe/res/server/kbengine_defaults.xml:152", group: 'net' },
  "channelCommon.windowOverflow.receive.messages": { zh: "接收窗口:消息条数溢出限制", en: "Receive window: message-count overflow limit", source: "kbe/res/server/kbengine_defaults.xml:146-150", group: 'net' },
  "channelCommon.windowOverflow.receive.messages.critical": { zh: "关键消息的接收条数上限", en: "Receive cap for critical messages", source: "kbe/res/server/kbengine_defaults.xml:147", group: 'net' },
  "channelCommon.windowOverflow.receive.messages.external": { zh: "外部通道的接收消息条数上限", en: "Receive message cap for the external channel", source: "kbe/res/server/kbengine_defaults.xml:149", group: 'net' },
  "channelCommon.windowOverflow.receive.messages.internal": { zh: "内部通道的接收消息条数上限", en: "Receive message cap for the internal channel", source: "kbe/res/server/kbengine_defaults.xml:148", group: 'net' },
  "channelCommon.windowOverflow.send": { zh: "发送窗口溢出限制:一个 tick 内发送的条数/字节数超限即视为溢出,0 = 无限制", en: "Send window overflow limits: per-tick message/byte caps, 0 = unlimited", source: "kbe/res/server/kbengine_defaults.xml:122-143", group: 'net' },
  "channelCommon.windowOverflow.send.bytes": { zh: "发送窗口:字节数溢出限制", en: "Send window: byte-count overflow limit", source: "kbe/res/server/kbengine_defaults.xml:139-142", group: 'net' },
  "channelCommon.windowOverflow.send.bytes.external": { zh: "外部通道的发送字节数上限(0 = 无限制)", en: "External channel send byte cap (0 = unlimited)", source: "kbe/res/server/kbengine_defaults.xml:141", group: 'net' },
  "channelCommon.windowOverflow.send.bytes.internal": { zh: "内部通道的发送字节数上限(0 = 无限制)", en: "Internal channel send byte cap (0 = unlimited)", source: "kbe/res/server/kbengine_defaults.xml:140", group: 'net' },
  "channelCommon.windowOverflow.send.messages": { zh: "发送窗口:消息条数溢出限制", en: "Send window: message-count overflow limit", source: "kbe/res/server/kbengine_defaults.xml:134-138", group: 'net' },
  "channelCommon.windowOverflow.send.messages.critical": { zh: "关键消息的发送条数上限", en: "Send cap for critical messages", source: "kbe/res/server/kbengine_defaults.xml:135", group: 'net' },
  "channelCommon.windowOverflow.send.messages.external": { zh: "外部通道的发送消息条数上限", en: "Send message cap for the external channel", source: "kbe/res/server/kbengine_defaults.xml:137", group: 'net' },
  "channelCommon.windowOverflow.send.messages.internal": { zh: "内部通道的发送消息条数上限", en: "Send message cap for the internal channel", source: "kbe/res/server/kbengine_defaults.xml:136", group: 'net' },
  "channelCommon.windowOverflow.send.tickSentBytes": { zh: "一个tick内发送的字节数溢出限制", en: "A tick, the value of the sent window overflow, 0 is unlimited", source: "kbe/res/server/kbengine_defaults.xml:127", group: 'net' },
  "channelCommon.windowOverflow.send.tickSentBytes.external": { zh: "外部通道:一个 tick 内允许发送的字节数(0 = 无限制)", en: "External channel: bytes allowed to be sent in one tick (0 = unlimited)", source: "kbe/res/server/kbengine_defaults.xml:127-132", group: 'net' },
  "channelCommon.windowOverflow.send.tickSentBytes.internal": { zh: "内部通道:一个 tick 内允许发送的字节数(0 = 无限制)", en: "Internal channel: bytes allowed to be sent in one tick (0 = unlimited)", source: "kbe/res/server/kbengine_defaults.xml:127-132", group: 'net' },
  "channelCommon.writeBufferSize": { zh: "TCP socket 写缓冲大小(字节),分内部/外部通道", en: "TCP socket write buffer size in bytes, split into internal/external channels", source: "kbe/res/server/kbengine_defaults.xml:110-120", group: 'net' },
  "channelCommon.writeBufferSize.external": { zh: "外部通道 socket 写缓冲(字节):0 = 使用系统默认", en: "External channel socket write buffer in bytes; 0 = system default", source: "kbe/res/server/kbengine_defaults.xml:117-119", group: 'net' },
  "channelCommon.writeBufferSize.internal": { zh: "内部通道 socket 写缓冲(字节):引擎默认 16M", en: "Internal channel socket write buffer in bytes (engine default 16M)", source: "kbe/res/server/kbengine_defaults.xml:117-118", group: 'net' },
  "dbmgr": { zh: "dbmgr 进程:数据库管理,账号校验与实体数据读写", en: "dbmgr process: database management, account verification and entity data read/write", source: "kbe/res/server/kbengine_defaults.xml:270-445", group: 'process' },
  "dbmgr.InterfacesServiceAddr": { zh: "Interfaces进程的地址（参考interfaces中地址配置）", en: "Address of Interfaces process", source: "kbe/res/server/kbengine_defaults.xml:296", group: 'account' },
  "dbmgr.InterfacesServiceAddr.addDefaultAddress": { zh: "如果为true，则自动将配置中的Interfaces地址加入到地址池，以免改动Interfaces端口需要修改多处", en: "If true, the Interfaces addresses in the config are added to the address pool automatically, so changing the Interfaces port does not require editing many places.", source: "kbe/res/server/kbengine_defaults.xml:305", group: 'account' },
  "dbmgr.InterfacesServiceAddr.enable": { zh: "如果enable为false则相关数据不转发到Interfaces进程 注意：如果为true，dbmgr认为数据将由interfaces交给第三方平台处理", en: "If false, related data is not forwarded to the Interfaces process. Note: when true, dbmgr treats the data as handed to the third-party platform via interfaces.", source: "kbe/res/server/kbengine_defaults.xml:300", group: 'account' },
  "dbmgr.InterfacesServiceAddr.item": { zh: "额外的 interfaces 地址条目(host + port),可配置多条分担压力", en: "Extra interfaces address entry (host + port), repeatable to spread the load", source: "kbe/res/server/kbengine_defaults.xml:309-314", group: 'account' },
  "dbmgr.InterfacesServiceAddr.item.host": { zh: "该 interfaces 条目的地址", en: "Address of this interfaces entry", source: "kbe/src/lib/server/serverconfig.cpp:957+961", group: 'account' },
  "dbmgr.InterfacesServiceAddr.item.port": { zh: "该 interfaces 条目的端口(0 = 引擎默认 KBE_INTERFACES_TCP_PORT)", en: "Port of this interfaces entry (0 = engine default KBE_INTERFACES_TCP_PORT)", source: "kbe/src/lib/server/serverconfig.cpp:958,962-965", group: 'account' },
  "dbmgr.SOMAXCONN": { zh: "listen监听队列最大值", en: "listen: Maximum listen queue", source: "kbe/res/server/kbengine_defaults.xml:441", group: 'net' },
  "dbmgr.account_system": { zh: "账号系统", en: "Account system", source: "kbe/res/server/kbengine_defaults.xml:374", group: 'account' },
  "dbmgr.account_system.accountDefaultDeadline": { zh: "新账号默认过期时间(秒, 引擎会加上当前时间)", en: "New account default expiration time (seconds, the engine will add the current time)", source: "kbe/res/server/kbengine_defaults.xml:391", group: 'account' },
  "dbmgr.account_system.accountDefaultFlags": { zh: "新账号默认标记(可组合，填写时按十进制格式) 常规标记 = 0x00000000 锁定标记 = 0x000000001 未激活标记 = 0x000000002", en: "Default flags a new account, Can be combined, Fill in decimal format when normal flag lock flag normal flag", source: "kbe/res/server/kbengine_defaults.xml:383", group: 'account' },
  "dbmgr.account_system.accountEntityScriptType": { zh: "账号Entity的名称", en: "Name of AccountEntity", source: "kbe/res/server/kbengine_defaults.xml:378", group: 'account' },
  "dbmgr.account_system.account_registration": { zh: "账号注册相关", en: "Account registration", source: "kbe/res/server/kbengine_defaults.xml:406", group: 'account' },
  "dbmgr.account_system.account_registration.enable": { zh: "是否开放注册", en: "Whether open registration", source: "kbe/res/server/kbengine_defaults.xml:410", group: 'account' },
  "dbmgr.account_system.account_registration.loginAutoCreate": { zh: "登录合法时游戏数据库找不到游戏账号则自动创建", en: "When logged in, the game database can not find the game account is automatically created", source: "kbe/res/server/kbengine_defaults.xml:415", group: 'account' },
  "dbmgr.account_system.account_resetPassword": { zh: "账号找回密码相关", en: "Account reset password", source: "kbe/res/server/kbengine_defaults.xml:396", group: 'account' },
  "dbmgr.account_system.account_resetPassword.enable": { zh: "是否开放重设密码", en: "Whether open reset password", source: "kbe/res/server/kbengine_defaults.xml:400", group: 'account' },
  "dbmgr.allowEmptyDigest": { zh: "是否检查defs-MD5", en: "Check whether the defs-MD5", source: "kbe/res/server/kbengine_defaults.xml:286", group: 'process' },
  "dbmgr.databaseInterfaces": { zh: "数据库接口", en: "database interfaces", source: "kbe/res/server/kbengine_defaults.xml:317", group: 'db' },
  "dbmgr.databaseInterfaces.default": { zh: "数据库接口名称 （可以定义多个不同的接口，但至少存在一个default） （Database interface name)", en: "Database interface name (you can define several different interfaces, but at least one \"default\" must exist).", source: "kbe/res/server/kbengine_defaults.xml:321", group: 'db' },
  "dbmgr.databaseInterfaces.default.auth": { zh: "数据库账号验证 （Database auth)", en: "Database authentication.", source: "kbe/res/server/kbengine_defaults.xml:341", group: 'db' },
  "dbmgr.databaseInterfaces.default.auth.encrypt": { zh: "为true则表示password是加密 的, 可防止明文配置", en: "rsa is true, password is RSA", source: "kbe/res/server/kbengine_defaults.xml:348", group: 'db' },
  "dbmgr.databaseInterfaces.default.auth.password": { zh: "数据库密码(encrypt = true 时为引擎约定的 RSA 密文,不落明文)", en: "Database password (when encrypt = true it is the engine-defined RSA ciphertext, never plaintext)", source: "kbe/res/server/kbengine_defaults.xml:346-351", group: 'db' },
  "dbmgr.databaseInterfaces.default.auth.username": { zh: "数据库账号名", en: "Database user name", source: "kbe/res/server/kbengine_defaults.xml:341-345", group: 'db' },
  "dbmgr.databaseInterfaces.default.databaseName": { zh: "数据库名称", en: "Database name", source: "kbe/res/server/kbengine_defaults.xml:354", group: 'db' },
  "dbmgr.databaseInterfaces.default.host": { zh: "数据库地址 （Database address)", en: "Database address.", source: "kbe/res/server/kbengine_defaults.xml:335", group: 'db' },
  "dbmgr.databaseInterfaces.default.numConnections": { zh: "数据库允许的连接数", en: "Number of connections allowed by the database", source: "kbe/res/server/kbengine_defaults.xml:359", group: 'db' },
  "dbmgr.databaseInterfaces.default.port": { zh: "数据库端口(0 = MySQL 默认 3306)", en: "Database port (0 = MySQL default 3306)", source: "kbe/src/lib/db_mysql/db_interface_mysql.cpp:166-167", group: 'db' },
  "dbmgr.databaseInterfaces.default.pure": { zh: "如果为true，则为纯净的数据库，引擎不创建实体表 （If true is pure database, engine does not create the entity table)", en: "If true this is a pure database: the engine does not create entity tables in it.", source: "kbe/res/server/kbengine_defaults.xml:325", group: 'db' },
  "dbmgr.databaseInterfaces.default.type": { zh: "数据库类型 （Database type )", en: "mysql、redis mysql, redis", source: "kbe/res/server/kbengine_defaults.xml:330", group: 'db' },
  "dbmgr.databaseInterfaces.default.unicodeString": { zh: "字符编码类型", en: "Character encoding type", source: "kbe/res/server/kbengine_defaults.xml:364", group: 'db' },
  "dbmgr.databaseInterfaces.default.unicodeString.characterSet": { zh: "数据库字符集(引擎默认 utf8mb4)", en: "Database character set (engine default utf8mb4)", source: "kbe/res/server/kbengine_defaults.xml:364-368", group: 'db' },
  "dbmgr.databaseInterfaces.default.unicodeString.collation": { zh: "数据库排序规则(引擎默认 utf8mb4_bin)", en: "Database collation (engine default utf8mb4_bin)", source: "kbe/res/server/kbengine_defaults.xml:364-369", group: 'db' },
  "dbmgr.debug": { zh: "debug模式下可输出读写操作信息", en: "Debug mode can output the read and write informations", source: "kbe/res/server/kbengine_defaults.xml:276", group: 'log' },
  "dbmgr.entryScriptFile": { zh: "脚本入口模块， 相当于main函数", en: "Entry module, like the main-function", source: "kbe/res/server/kbengine_defaults.xml:271", group: 'process' },
  "dbmgr.ids": { zh: "entityID分配器，进入溢出范围则请求获取新的ID资源", en: "The entityID allocator, enter the overflow area will get the new ID's", source: "kbe/res/server/kbengine_defaults.xml:434", group: 'process' },
  "dbmgr.ids.increasing_range": { zh: "dbmgr 侧 entityID 分配器一次申请的 ID 段增量", en: "entityID allocator step on the dbmgr side: how many IDs are requested at once", source: "kbe/src/lib/server/serverconfig.cpp:943-946", group: 'process' },
  "dbmgr.internalInterface": { zh: "指定接口地址，可配置网卡名、MAC、IP", en: "Interface address specified, configurable NIC/MAC/IP", source: "kbe/res/server/kbengine_defaults.xml:291", group: 'net' },
  "dbmgr.shareDB": { zh: "是否共享数据库", en: "Whether to share the database", source: "kbe/res/server/kbengine_defaults.xml:281", group: 'db' },
  "dbmgr.telnet_service": { zh: "Telnet服务, 如果端口被占用则向后尝试32001..", en: "Telnet service, if the port is occupied backwards to try 32001", source: "kbe/res/server/kbengine_defaults.xml:422", group: 'telnet' },
  "dbmgr.telnet_service.default_layer": { zh: "命令默认层", en: "layer of default the command", source: "kbe/res/server/kbengine_defaults.xml:428", group: 'telnet' },
  "dbmgr.telnet_service.password": { zh: "telnet 登录密码(引擎默认 pwd123456)", en: "telnet login password (engine default pwd123456)", source: "kbe/res/server/kbengine_defaults.xml:427", group: 'telnet' },
  "dbmgr.telnet_service.port": { zh: "telnet 监听端口(引擎默认 32000;段注释:端口被占用则向后尝试 32001..)", en: "telnet listen port (engine default 32000; section note: when the port is taken the engine tries 32001.. next)", source: "kbe/res/server/kbengine_defaults.xml:422-427", group: 'telnet' },
  "debugEntity": { zh: "是否输出entity的创建， 脚本获取属性， 初始化属性等调试信息， 以及def信息", en: "Whether the output the logs: create the entity, Script get attributes, Initialization attributes information, Def information.", source: "kbe/res/server/kbengine_defaults.xml:79", group: 'log' },
  "email_service_config": { zh: "Email服务, 提供账号验证， 密码找回等等。", en: "Email services, providing the account verification, password recovery, etc.", source: "kbe/res/server/kbengine_defaults.xml:229", group: 'account' },
  "gameUpdateHertz": { zh: "游戏逻辑处理频率HZ", en: "Update frequency process, HZ", source: "kbe/res/server/kbengine_defaults.xml:2", group: 'process' },
  "interfaces": { zh: "interfaces 进程:对接第三方计费/账号等外部系统,多组游戏服务端可共用一个 interfaces", en: "interfaces process: bridges to third-party billing/account systems; several game servers can share one interfaces", source: "kbe/res/server/kbengine_defaults.xml:234-268", group: 'process' },
  "interfaces.SOMAXCONN": { zh: "listen监听队列最大值", en: "listen: Maximum listen queue", source: "kbe/res/server/kbengine_defaults.xml:252", group: 'net' },
  "interfaces.entryScriptFile": { zh: "脚本入口模块， 相当于main函数", en: "Entry module, like the main-function", source: "kbe/res/server/kbengine_defaults.xml:235", group: 'process' },
  "interfaces.host": { zh: "interfaces的地址，多组游戏服务端可以共用一个interfaces", en: "interfaces address, multiple gameserver can share a interfaces", source: "kbe/res/server/kbengine_defaults.xml:240", group: 'net' },
  "interfaces.orders_timeout": { zh: "订单超时(秒)", en: "Orders timeout(seconds)", source: "kbe/res/server/kbengine_defaults.xml:247", group: 'account' },
  "interfaces.port_max": { zh: "interfaces 监听端口范围上限", en: "Upper bound of the interfaces listen port range", source: "kbe/src/lib/server/serverconfig.cpp:516-519", group: 'net' },
  "interfaces.port_min": { zh: "interfaces 监听端口范围下限", en: "Lower bound of the interfaces listen port range", source: "kbe/src/lib/server/serverconfig.cpp:507-513", group: 'net' },
  "interfaces.telnet_service": { zh: "Telnet服务, 如果端口被占用则向后尝试33001..", en: "Telnet service, if the port is occupied backwards to try 33001", source: "kbe/res/server/kbengine_defaults.xml:257", group: 'telnet' },
  "interfaces.telnet_service.default_layer": { zh: "命令默认层", en: "layer of default the command", source: "kbe/res/server/kbengine_defaults.xml:263", group: 'telnet' },
  "interfaces.telnet_service.password": { zh: "telnet 登录密码(引擎默认 pwd123456)", en: "telnet login password (engine default pwd123456)", source: "kbe/res/server/kbengine_defaults.xml:262", group: 'telnet' },
  "interfaces.telnet_service.port": { zh: "telnet 监听端口(引擎默认 33000;段注释:端口被占用则向后尝试 33001..)", en: "telnet listen port (engine default 33000; section note: when the port is taken the engine tries 33001.. next)", source: "kbe/res/server/kbengine_defaults.xml:257-262", group: 'telnet' },
  "logger": { zh: "logger 进程:收集各组件日志的独立进程", en: "logger process: standalone process collecting logs from every component", source: "kbe/res/server/kbengine_defaults.xml:904-941", group: 'process' },
  "logger.SOMAXCONN": { zh: "listen监听队列最大值", en: "listen: Maximum listen queue", source: "kbe/res/server/kbengine_defaults.xml:937", group: 'net' },
  "logger.entryScriptFile": { zh: "脚本入口模块， 相当于main函数", en: "Entry module, like the main-function", source: "kbe/res/server/kbengine_defaults.xml:905", group: 'process' },
  "logger.internalInterface": { zh: "指定接口地址，可配置网卡名、MAC、IP", en: "Interface address specified, configurable NIC/MAC/IP", source: "kbe/res/server/kbengine_defaults.xml:910", group: 'net' },
  "logger.telnet_service": { zh: "Telnet服务, 如果端口被占用则向后尝试34001..", en: "Telnet service, if the port is occupied backwards to try 34001", source: "kbe/res/server/kbengine_defaults.xml:925", group: 'telnet' },
  "logger.telnet_service.default_layer": { zh: "命令默认层", en: "layer of default the command", source: "kbe/res/server/kbengine_defaults.xml:931", group: 'telnet' },
  "logger.telnet_service.password": { zh: "telnet 登录密码(引擎默认 pwd123456)", en: "telnet login password (engine default pwd123456)", source: "kbe/res/server/kbengine_defaults.xml:930", group: 'telnet' },
  "logger.telnet_service.port": { zh: "telnet 监听端口(引擎默认 34000;段注释:端口被占用则向后尝试 34001..)", en: "telnet listen port (engine default 34000; section note: when the port is taken the engine tries 34001.. next)", source: "kbe/res/server/kbengine_defaults.xml:925-930", group: 'telnet' },
  "logger.tick_max_buffered_logs": { zh: "单个app(baseapp, cellapp, 等等..)进程上, 一个tick最多缓存的log数量", en: "The number of single-process(baseapp, cellapp, etc..), The number of log a tick buffer.", source: "kbe/res/server/kbengine_defaults.xml:915", group: 'log' },
  "logger.tick_sync_logs": { zh: "单个app(baseapp, cellapp, 等等..)进程上, 一个tick同步给logger的log数量", en: "The number of single-process(baseapp, cellapp, etc..), A tick synchronization to the number of logger", source: "kbe/res/server/kbengine_defaults.xml:920", group: 'log' },
  "loginapp": { zh: "loginapp 进程:登录网关,处理登录、账号创建与服务器列表下发", en: "loginapp process: login gateway handling login, account creation and the server list", source: "kbe/res/server/kbengine_defaults.xml:742-812", group: 'process' },
  "loginapp.SOMAXCONN": { zh: "listen监听队列最大值", en: "listen: Maximum listen queue", source: "kbe/res/server/kbengine_defaults.xml:782", group: 'net' },
  "loginapp.account_type": { zh: "账号的类型 1: 普通账号 2: email账号(需要激活) 3: 智能账号(自动识别Email， 普通号码等)", en: "Account types Normal Account Email Account, Note: activation required. Smart Account (Email or Normal, etc.)", source: "kbe/res/server/kbengine_defaults.xml:787", group: 'account' },
  "loginapp.encrypt_login": { zh: "加密登录信息 可选择的加密方式 : 0: 无加密", en: "The encrypted user login information Optional encryption No Encryption res\\key\\kbengine_private.key 1: Blowfish 2: RSA", source: "kbe/res/server/kbengine_defaults.xml:772", group: 'account' },
  "loginapp.entryScriptFile": { zh: "脚本入口模块， 相当于main函数", en: "Entry module, like the main-function", source: "kbe/res/server/kbengine_defaults.xml:743", group: 'process' },
  "loginapp.externalAddress": { zh: "强制指定外部IP地址或者域名，在某些网络环境下，可能会使用端口映射的方式来访问局域网内部的KBE服务器，那么KBE在当前 的机器上获得的外部地址是局域网地址，此时某些功能将会不正常。例如：账号激活邮件中给出的回调地址, 登录baseapp。 注意：服务端并不会检查这个地址的可用性，因为无法检查。", en: "Forced to specify an external IP-address or Domain-name, In some server environment, May use the port mapping to access KBE, So KBE on current machines on the external IP address may be a LAN IP address, Then some functions will not normal. For example: account activation email address given callback. Note: the availability of server does not check the address, because cannot check", source: "kbe/res/server/kbengine_defaults.xml:754", group: 'net' },
  "loginapp.externalInterface": { zh: "对外接口地址(可配置网卡名、MAC 或 IP),留空由引擎自动探测", en: "External interface address (NIC name, MAC or IP); empty means the engine detects it", source: "kbe/res/server/kbengine_defaults.xml:748-752", group: 'net' },
  "loginapp.externalTcpPorts_max": { zh: "暴露给客户端的 TCP 端口范围上限(0 = 使用默认)", en: "Upper bound of the TCP port range exposed to clients (0 = use default)", source: "kbe/res/server/kbengine_defaults.xml:764-768", group: 'net' },
  "loginapp.externalTcpPorts_min": { zh: "暴露给客户端的端口范围", en: "Exposed to the client port range", source: "kbe/res/server/kbengine_defaults.xml:764", group: 'net' },
  "loginapp.externalUdpPorts_max": { zh: "暴露给客户端的 UDP 端口范围上限(-1 = 不启用)", en: "Upper bound of the UDP port range exposed to clients (-1 = disabled)", source: "kbe/res/server/kbengine_defaults.xml:764-770", group: 'net' },
  "loginapp.externalUdpPorts_min": { zh: "暴露给客户端的 UDP 端口范围下限(-1 = 不启用)", en: "Lower bound of the UDP port range exposed to clients (-1 = disabled)", source: "kbe/res/server/kbengine_defaults.xml:764-769", group: 'net' },
  "loginapp.http_cbhost": { zh: "http回调接口，处理认证、密码重置等 （注意：http_cbhost一般会被引擎替换为externalInterface或者externalAddress，仅第一个loginapp才会开启这个服务）", en: "Http-callback interface, handling authentication, password reset, etc.", source: "kbe/res/server/kbengine_defaults.xml:794", group: 'account' },
  "loginapp.http_cbport": { zh: "http 回调端口:处理认证、密码重置等回调", en: "HTTP callback port: handles authentication, password reset and similar callbacks", source: "kbe/src/lib/server/serverconfig.cpp:1320-1322", group: 'account' },
  "loginapp.internalInterface": { zh: "指定接口地址，可配置网卡名、MAC、IP", en: "Interface address specified, configurable NIC/MAC/IP", source: "kbe/res/server/kbengine_defaults.xml:748", group: 'net' },
  "loginapp.telnet_service": { zh: "Telnet服务, 如果端口被占用则向后尝试31001..", en: "Telnet service, if the port is occupied backwards to try 31001", source: "kbe/res/server/kbengine_defaults.xml:801", group: 'telnet' },
  "loginapp.telnet_service.default_layer": { zh: "命令默认层", en: "layer of default the command", source: "kbe/res/server/kbengine_defaults.xml:807", group: 'telnet' },
  "loginapp.telnet_service.password": { zh: "telnet 登录密码(引擎默认 pwd123456)", en: "telnet login password (engine default pwd123456)", source: "kbe/res/server/kbengine_defaults.xml:806", group: 'telnet' },
  "loginapp.telnet_service.port": { zh: "telnet 监听端口(引擎默认 31000;段注释:端口被占用则向后尝试 31001..)", en: "telnet listen port (engine default 31000; section note: when the port is taken the engine tries 31001.. next)", source: "kbe/res/server/kbengine_defaults.xml:801-806", group: 'telnet' },
  "machine": { zh: "machine 进程:探测与组网守护,负责多物理机组网与进程发现", en: "machine process: discovery/cluster guardian for multi-machine setups and process discovery", source: "kbe/res/server/kbengine_defaults.xml:814-831", group: 'process' },
  "machine.addresses": { zh: "服务组使用多台硬件组成网络，在某些网络环境由于路由器的设置不允许UDP广播造成跨物理机组网不成功时 可在此填入所有相关物理机的地址，引擎将会向具体的地址发送探测包来完成组网。", en: "When the network is composed of a plurality of hardware, the specific network address is detected.", source: "kbe/res/server/kbengine_defaults.xml:823", group: 'net' },
  "machine.addresses.item": { zh: "参与组网的物理机地址(路由器禁 UDP 广播时逐台填写,引擎定向发探测包)", en: "Machine address used for clustering (fill in per machine when UDP broadcast is blocked; the engine probes these addresses directly)", source: "kbe/src/lib/server/serverconfig.cpp:1396-1401", group: 'net' },
  "machine.externalTcpPorts_max": { zh: "暴露给工具的 TCP 端口范围上限(0 = 使用默认)", en: "Upper bound of the TCP port range exposed to tools (0 = use default)", source: "kbe/res/server/kbengine_defaults.xml:815-819", group: 'net' },
  "machine.externalTcpPorts_min": { zh: "暴露给客户端的端口范围", en: "Exposed to the tools port range", source: "kbe/res/server/kbengine_defaults.xml:815", group: 'net' },
  "machine.externalUdpPorts_max": { zh: "暴露给工具的 UDP 端口范围上限(0 = 不启用)", en: "Upper bound of the UDP port range exposed to tools (0 = disabled)", source: "kbe/res/server/kbengine_defaults.xml:815-821", group: 'net' },
  "machine.externalUdpPorts_min": { zh: "暴露给工具的 UDP 端口范围下限(0 = 不启用)", en: "Lower bound of the UDP port range exposed to tools (0 = disabled)", source: "kbe/res/server/kbengine_defaults.xml:815-820", group: 'net' },
  "packetAlwaysContainLength": { zh: "非0则不优化， 不带包长信息的包强制都携带长度信息， 某些情况下方便某些前端对接协议 什么样的包不带长度信息? 所有能够预先计算出包大小的且永远不变的包不带长度信息， 如果有可变字符串参数则一定需要带长度信息", en: "Non-0 is not optimized, Force all packets contain length information, Some convenient docking protocol client. What of data packet length information does not? All packages can be calculated in advance and never change the size of the package with no length information.", source: "kbe/res/server/kbengine_defaults.xml:12", group: 'net' },
  "publish": { zh: "发布状态与脚本版本段(state:0 = debug,1 = release;script_version:脚本层版本号)", en: "Release state and script version section (state: 0 = debug, 1 = release; script_version: script-layer version)", source: "kbe/res/server/kbengine_defaults.xml:85-99", group: 'process' },
  "publish.script_version": { zh: "脚本层发布的版本号", en: "Script layer released version number", source: "kbe/res/server/kbengine_defaults.xml:95", group: 'process' },
  "publish.state": { zh: "发布状态, 可在脚本中获取该值。 KBEngine.publish 其他自定义", en: "apps released state, This value can be obtained in the script. KBEngine.publish() Other custom Type: Integer8 0 : debug 1 : release", source: "kbe/res/server/kbengine_defaults.xml:86", group: 'process' },
  "root": { zh: "KBEngine 配置根节点:全局配置与各进程(baseapp/cellapp/dbmgr/...)配置段都挂在它下面", en: "KBEngine configuration root: holds the global settings and every per-process section (baseapp/cellapp/dbmgr/...)", source: "kbe/res/server/kbengine_defaults.xml:1", group: 'general' },
  "shutdown_time": { zh: "关服倒计时(秒)", en: "Countdown to shutdown the server(seconds)", source: "kbe/res/server/kbengine_defaults.xml:201", group: 'process' },
  "shutdown_waittick": { zh: "关闭服务器的时候， 如果有未完成的任务， 服务器需要等待任务结束。 每Tick（秒）检查一次", en: "Shutdown the server, if you have not completed the task, the server needs to wait for the end of the mission. Time(seconds) for each waiting.", source: "kbe/res/server/kbengine_defaults.xml:206", group: 'process' },
  "thread_pool": { zh: "线程池参数(超时与线程数量)", en: "Thread pool parameters (timeout and thread counts)", source: "kbe/res/server/kbengine_defaults.xml:218-227", group: 'process' },
  "thread_pool.init_create": { zh: "进程启动时创建的线程数(引擎下限 1)", en: "Threads created when the process starts (engine enforces a minimum of 1)", source: "kbe/src/lib/server/serverconfig.cpp:221-224", group: 'process' },
  "thread_pool.max_create": { zh: "线程池允许的最大线程数(引擎下限 1)", en: "Maximum threads the pool may create (engine enforces a minimum of 1)", source: "kbe/src/lib/server/serverconfig.cpp:233-236", group: 'process' },
  "thread_pool.pre_create": { zh: "预创建的备用线程数(引擎下限 1)", en: "Pre-created spare threads (engine enforces a minimum of 1)", source: "kbe/src/lib/server/serverconfig.cpp:227-230", group: 'process' },
  "thread_pool.timeout": { zh: "默认超时时间(秒)", en: "default timeout(seconds)", source: "kbe/res/server/kbengine_defaults.xml:219", group: 'process' },
  "trace_packet": { zh: "数据包跟踪:把收发的数据包以文本输出到 log 供调试(段内含 debug_type/use_logfile/disables)", en: "Packet tracing: dump sent/received packets to the log for debugging (holds debug_type/use_logfile/disables)", source: "kbe/res/server/kbengine_defaults.xml:21-36", group: 'log' },
  "trace_packet.debug_type": { zh: "数据包跟踪输出格式:0 = 不输出,1 = 16 进制,2 = 字符流,3 = 10 进制;取值 >3 按 0 处理", en: "Packet-trace output format: 0 = off, 1 = hex, 2 = string stream, 3 = decimal; values above 3 are treated as 0", source: "kbe/src/lib/server/serverconfig.cpp:140-145", group: 'log' },
  "trace_packet.disables": { zh: "包跟踪排除名单:这里列出的消息名不再输出跟踪日志(高频消息在此屏蔽;条目 Encrypted::packets 表示不跟踪加密包)", en: "Packet-trace exclusion list: listed message names are not traced (high-frequency messages are filtered here; the entry \"Encrypted::packets\" also turns off tracing of encrypted packets)", source: "kbe/src/lib/server/serverconfig.cpp:151-166", group: 'log' },
  "trace_packet.disables.item": { zh: "不参与包跟踪的消息名(形如 模块::消息,可配置多条)", en: "Message name excluded from packet tracing (Module::message, repeatable)", source: "kbe/src/lib/server/serverconfig.cpp:157-164", group: 'log' },
  "trace_packet.use_logfile": { zh: "是否把包内容单独写入一个 log 文件(文件名形如 appname_packetlogs.log)", en: "Whether packet content goes to a dedicated log file (named like appname_packetlogs.log)", source: "kbe/src/lib/server/serverconfig.cpp:147-149", group: 'log' },
};

/**
 * 找不到含义的自定义配置项(kbengine.xml 里自加、引擎默认配置与文档都没有)统一
 * 归入「自定义配置」子分类并标注「未识别」——不猜语义。
 */
export const SERVER_CONFIG_UNKNOWN_DOC: ServerConfigItemDoc = {
  zh: '未在 KBEngine 引擎默认配置(kbe/res/server/kbengine_defaults.xml)与官方文档中找到该项,含义未识别;如需说明请补进文案库 src/serverConfigCatalog.ts',
  en: 'Not found in the KBEngine engine defaults (kbe/res/server/kbengine_defaults.xml) nor the official docs, meaning unrecognized; document it in src/serverConfigCatalog.ts',
  source: '',
  group: 'custom'
};

/** VS Code 显示语言是否中文(zh-cn/zh-tw/... 均按中文出注释,对齐 summaryForLanguage) */
export function isZhConfigLanguage(language: string | undefined): boolean {
  return (language ?? '').toLowerCase().startsWith('zh');
}

/** 按显示语言取文案;该语言缺位时回落另一种语言(不返回空串) */
export function configItemDocBody(
  doc: Pick<ServerConfigItemDoc, 'zh' | 'en'>,
  language: string | undefined
): string {
  if (isZhConfigLanguage(language)) {
    return doc.zh || doc.en;
  }
  return doc.en || doc.zh;
}

// 裸键索引:只收录「末段在库内唯一」的键,供无包裹段的解析路径回落(与
// serverConfigHover 的 `段.标签` → `标签` 查表口径一致;歧义键不收,宁可判
// 未识别也不张冠李戴)。
const BARE_NAME_INDEX: Readonly<Record<string, ServerConfigItemDoc>> = (() => {
  const count = new Map<string, number>();
  for (const key of Object.keys(SERVER_CONFIG_ITEM_DOCS)) {
    const bare = key.slice(key.lastIndexOf('.') + 1);
    count.set(bare, (count.get(bare) ?? 0) + 1);
  }
  const index: Record<string, ServerConfigItemDoc> = {};
  for (const key of Object.keys(SERVER_CONFIG_ITEM_DOCS)) {
    const bare = key.slice(key.lastIndexOf('.') + 1);
    if (count.get(bare) === 1) {
      index[bare] = SERVER_CONFIG_ITEM_DOCS[key];
    }
  }
  return index;
})();

/**
 * 按节点路径查文案:先查整路径,再查去掉配置根段的路径,最后查无歧义裸键。
 * 三段都落空返回 null(调用方按「自定义配置·未识别」处理)。
 */
export function findServerConfigItemDoc(pathSegments: readonly string[]): ServerConfigItemDoc | null {
  if (pathSegments.length === 0) {
    return null;
  }
  const candidates = [pathSegments.join('.'), pathSegments.slice(1).join('.'), pathSegments[pathSegments.length - 1]];
  for (const candidate of candidates) {
    const doc = SERVER_CONFIG_ITEM_DOCS[candidate];
    if (doc) {
      return doc;
    }
  }
  return BARE_NAME_INDEX[candidates[2]] ?? null;
}
