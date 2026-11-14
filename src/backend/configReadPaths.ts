/**
 * KSEM-CFG-01 配置读取路径登记册(纯核心,零 vscode 依赖)。
 *
 * 验收口径(todo.md SEM-031,旧 KSEM-CFG-01):登记引擎 defaults/custom/
 * 覆盖层、项目 XML/JSON/JSONC/Python 配置对象及真实读取函数;区分 schema
 * 已有和只存在文档目录。
 *
 * 每条 lane 登记四件事:
 *  - layers:引擎加载层序(defaults→custom 覆盖)+ 加载点锚;
 *  - readers:真实读取函数锚(引擎 C++ / Rust 纯核 / TS 面 / 声明);
 *  - schemaFaces:扩展已有解析与消费面(可点真位);
 *  - docsOnlyFaces:只存在文档目录、无代码接线的设计面。
 *
 * status 判据(与测试锁死):
 *  - 'schema-covered'   引擎读取有对应扩展解析+消费面(rustCore/tsCore
 *    reader 齐且 schemaFaces 非空);
 *  - 'parser-core-only' 纯解析核在、文件发现/读取接线只存在于文档;
 *  - 'docs-only'        仅文档设计,无任何代码;
 *  - 'not-covered'      引擎读取但扩展无读取/解析面。
 *
 * 引擎 C++ 锚点出处=仓库知识库与 registry 文档(C++ 源码本地未检出,
 * 行号以已核对的知识库条目为准,见各锚点括注);仓库锚点=path:line
 * 真位可点,测试用 fs 校验文件存在,杜绝虚构读取器。
 */

export type ConfigLaneStatus =
  | 'schema-covered'
  | 'parser-core-only'
  | 'docs-only'
  | 'not-covered';

export type ConfigReaderRole = 'engine' | 'rustCore' | 'tsCore' | 'declaration';

export interface ConfigLoadLayer {
  /** 层名:defaults / custom / 单层 */
  name: string;
  /** 引擎按此资源路径调用 loadConfig(客户端/服务端同前缀 'server/') */
  file: string;
  /** defaults 层恒在;custom 层缺失容忍面见 notes(不硬造引擎行为) */
  required: boolean;
  /** 真实加载锚:引擎行号(知识库出处)或 registry 文档 */
  loadAnchor: string;
}

export interface ConfigReaderAnchor {
  role: ConfigReaderRole;
  /** 仓库锚 'path:line 说明' 或引擎锚 'file:line(知识库出处)' */
  anchor: string;
}

export interface ConfigReadPathEntry {
  lane: string;
  title: string;
  layers: readonly ConfigLoadLayer[];
  readers: readonly ConfigReaderAnchor[];
  /** 覆盖层/覆写面(引擎二文件覆盖之外的解析期覆写) */
  overlays?: readonly string[];
  schemaFaces: readonly string[];
  docsOnlyFaces: readonly string[];
  notes?: readonly string[];
  status: ConfigLaneStatus;
}

const SERVER_CONFIG_ENTRY: ConfigReadPathEntry = {
  lane: 'server-config',
  title: '引擎服务端 XML 配置(kbengine_defaults.xml → kbengine.xml)',
  layers: [
    {
      name: 'defaults',
      file: 'server/kbengine_defaults.xml',
      required: true,
      loadAnchor: 'kbemain.h:71 loadConfig("server/kbengine_defaults.xml")(docs/knowledge/startup-flow-and-stack.md:54)',
    },
    {
      name: 'custom',
      file: 'server/kbengine.xml',
      required: false,
      loadAnchor: 'kbemain.h:74 loadConfig("server/kbengine.xml")(同上;第二次调用逐键覆盖)',
    },
  ],
  readers: [
    { role: 'engine', anchor: 'kbe/src/lib/server/kbemain.h:66-75 loadConfig() 内联两文件序列(docs/knowledge/startup-flow-and-stack.md:54)' },
    { role: 'engine', anchor: 'serverconfig.cpp:104 ServerConfig::loadConfig 入口(docs/review/2026-11-12-ksem-bas-02-engine-contract-registry.md:78)' },
    { role: 'rustCore', anchor: 'crates/kode-parser/src/config.rs:131 parse_config(容错 XML 解析,source_comments 采集)' },
    { role: 'rustCore', anchor: 'crates/kode-parser/src/config.rs:342 merge_config_xml(defaults→custom 逐键覆盖)' },
    { role: 'tsCore', anchor: 'src/serverConfigResolve.ts:307 ensureConfigResolved($/kode/config/resolve:定位+读取+交付 Rust 解析)' },
    { role: 'tsCore', anchor: 'src/serverConfigFallbackCore.ts (TS 兜底解析臂,resolver:ts)' },
    { role: 'tsCore', anchor: 'src/serverConfigMerge.ts:201 buildMergedConfigTree(默认树→自定义树合成)' },
    { role: 'tsCore', anchor: 'src/backend/serverConfigCatalog.ts:81 SERVER_CONFIG_ITEM_DOCS(项级注解,引擎锚 kbengine_defaults.xml:588-716)' },
  ],
  overlays: [
    'ConfigResolveOverrides(src/serverConfigMerge.ts:201 入参;资产根/自定义路径解析期覆写)',
    '虚拟最终配置文档(KBEngine: Final Config 视图;kbengine.showFinalConfigOnOpen / finalConfigComments / autoRefreshFinalConfig 设置)',
  ],
  schemaFaces: [
    '补全/悬停/项级注解链(serverConfigCatalog + serverConfigAnnotations)',
    '最终配置虚拟文档(合并视图+源注释回显)',
    'configContractDiagnostics(配置契约诊断族)',
  ],
  docsOnlyFaces: [],
  notes: [
    '引擎告警文本把邮件服务称 email_service.xml,实为所载 XML 的 section(serverconfig.cpp _updateEmailInfos ~:1710),无独立文件加载',
    'custom 层 required=false 表扩展解析臂 locate 失败回落 defaults(serverConfigFallbackCore);引擎自身对 kbengine.xml 缺失的容忍面未逐行核,不在此断言',
  ],
  status: 'schema-covered',
};

const FIXED_MESSAGES_ENTRY: ConfigReadPathEntry = {
  lane: 'fixed-messages',
  title: '固定消息表两文件(messages_fixed_defaults.xml → messages_fixed.xml)',
  layers: [
    {
      name: 'defaults',
      file: 'server/messages_fixed_defaults.xml',
      required: true,
      loadAnchor: 'message_handler.cpp:40 FixedMessages::loadConfig 固定表必载(fixed_messages.cpp:29-74,docs/kbengine-wire-protocol.md:182)',
    },
    {
      name: 'custom',
      file: 'server/messages_fixed.xml',
      required: false,
      loadAnchor: 'message_handler.cpp:41(显式 notFoundError=false,缺失容忍由引擎源码钉死)',
    },
  ],
  readers: [
    { role: 'engine', anchor: 'kbe/src/lib/network/fixed_messages.cpp:29-74 FixedMessages::loadConfig(docs/kbengine-wire-protocol.md:182)' },
    { role: 'rustCore', anchor: 'crates/kode-kbengine-schema/src/messages.rs:107 build_message_table(defaults XML + Option 项目覆写 XML)' },
    { role: 'tsCore', anchor: 'src/backend/messageTableEntity.ts ($/kode/messageTable/build:buildMessageTableInRust Rust-first,TS 兜底)' },
  ],
  schemaFaces: [
    '静态消息表(id/长度/args)与项目 override 合并面(KSEM-BAS-02 引擎契约登记)',
    'defs-md5 摘要面(SER-13):消息表进引擎握手 digest,SilentRisk 分类的判据面',
  ],
  docsOnlyFaces: [],
  status: 'schema-covered',
};

const CLIENT_CONFIG_ENTRY: ConfigReadPathEntry = {
  lane: 'client-config',
  title: '客户端/机器人侧 XML 配置(与服务端同构两文件)',
  layers: [
    {
      name: 'defaults',
      file: 'server/kbengine_defaults.xml',
      required: true,
      loadAnchor: 'client_lib/kbemain.h:57-102 客户端/机器人变体两文件同构(docs/knowledge/startup-flow-and-stack.md:60)',
    },
    {
      name: 'custom',
      file: 'server/kbengine.xml',
      required: false,
      loadAnchor: 'client_lib/kbemain.h 同上变体内 loadConfig 序列',
    },
  ],
  readers: [
    { role: 'engine', anchor: 'kbe/src/lib/client_lib/kbemain.h:57-102(docs/knowledge/startup-flow-and-stack.md:60)' },
    { role: 'engine', anchor: 'client_lib/config.cpp:50 Config::loadConfig' },
  ],
  schemaFaces: [],
  docsOnlyFaces: [],
  notes: [
    '扩展为服务端/实体开发向:客户端配置树无 TS/Rust 读取面(2026-11-14 登记时点),登记为 not-covered 勿称已有',
  ],
  status: 'not-covered',
};

const PROJECT_DEFS_ENTRY: ConfigReadPathEntry = {
  lane: 'project-defs',
  title: '实体定义链(types.xml → alias.xml → entities.xml → entities/*.def)',
  layers: [
    {
      name: 'defs-tree',
      file: 'res/server/types.xml + entities.xml + entities/*.def(alias 经 aliasDiscovery 设置发现)',
      required: true,
      loadAnchor: 'KSEM-BAS-02 引擎契约登记 docs/review/2026-11-12-ksem-bas-02-engine-contract-registry.md:72(merge 序 parent→interface→self)',
    },
  ],
  readers: [
    { role: 'rustCore', anchor: 'crates/kode-kbengine-schema/src/builder.rs (项目 schema 构建,merge 序 parent→interface→self)' },
    { role: 'tsCore', anchor: 'src/definitionWorkspace.ts (def/types 文档解析工作区,CustomTypeInfo 高保真面)' },
  ],
  schemaFaces: [
    'defs-md5 摘要面(SER-13):property.cpp:53-64/method.cpp:28-30/datatype.cpp:95-96 喂点,entity_app.h:1250-1257 握手闸(compat.rs 头注)',
    'wire 布局面(WireSchema/wire_codec,SER-12/14 golden 语录)',
    '补全/悬停/诊断/CodeLens 全消费面(definitionWorkspace 派生)',
  ],
  docsOnlyFaces: [],
  status: 'schema-covered',
};

const EXTENSION_SETTINGS_ENTRY: ConfigReadPathEntry = {
  lane: 'extension-settings',
  title: '扩展 kbengine.* 设置(JSONC 通道,146 键)',
  layers: [
    {
      name: 'settings-jsonc',
      file: 'package.json contributes.configuration.properties(用户/工作区 settings.json JSONC)',
      required: false,
      loadAnchor: 'package.json:195 contributes.configuration(getConfiguration("kbengine") 读取)',
    },
  ],
  readers: [
    { role: 'declaration', anchor: 'package.json contributes.configuration.properties(146 键声明式 schema,JSONC 通道)' },
    { role: 'tsCore', anchor: 'src/serverConfigResolve.ts:141 config.get("assetsRoot")(各模块 getConfiguration("kbengine") 读取先例)' },
  ],
  schemaFaces: [
    '声明式键 schema(package.json)+ 各模块读取面(诊断开关/路径指引/视图行为)',
  ],
  docsOnlyFaces: [],
  notes: [
    '扩展自有设置,非引擎配置文件;entityDefsPath/entitiesXmlPath/binPath/assetsRoot 指引扩展定位引擎与项目资产',
  ],
  status: 'schema-covered',
};

const SERIALIZATION_SCHEMA_ENTRY: ConfigReadPathEntry = {
  lane: 'serialization-schema',
  title: '项目序列化结构(.kbengine/serialization.json)',
  layers: [
    {
      name: 'serialization',
      file: '.kbengine/serialization.json',
      required: false,
      loadAnchor: '无引擎读取锚;设计 docs/review/2026-11-14-ksem-ser-08-project-schema-design.md(SER-08)',
    },
  ],
  readers: [
    { role: 'tsCore', anchor: 'src/backend/jsonChainPropagation.ts:80 parseSerializationSchema(内容级纯核,SER-10;无文件发现/读取接线;CFG-07 起消费 json.load 面)' },
  ],
  schemaFaces: [],
  docsOnlyFaces: [
    'docs/review/2026-11-14-ksem-ser-08-project-schema-design.md(SER-08 设计:文件发现/读取/触发链接线未做)',
    'todo.md SEM-026(SER-10)收口注:文件级接线为未接线车道',
  ],
  notes: [
    '纯核已能解析内容;文件发现/读取/触发链只在文档目录——登记为 parser-core-only,勿称已有读取器',
  ],
  status: 'parser-core-only',
};

const PYTHON_RESOURCE_IO_ENTRY: ConfigReadPathEntry = {
  lane: 'python-resource-io',
  title: 'Python 脚本配置读取原语(KBEngine 资源 IO)',
  layers: [
    {
      name: 'script-config',
      file: '脚本自选配置文件(XML/JSON/JSONC 任一,经 KBEngine 资源 IO)',
      required: false,
      loadAnchor: 'KBEngine.open/hasRes/getResFullPath/listPathRes/matchPath(docs/knowledge/api-core-concepts.md:56;baseapp/KBEngine.md:90-786)',
    },
  ],
  readers: [
    { role: 'engine', anchor: 'KBEngine 资源 IO 原语(docs/knowledge/api-core-concepts.md:56)' },
  ],
  schemaFaces: [],
  docsOnlyFaces: [
    'docs/knowledge/api-core-concepts.md:56(资源 IO 原语清单;引擎 Python API 文档面)',
  ],
  notes: [
    '引擎 Python 侧无专门配置对象 API(未检出 getAppConfig 类入口);脚本经资源 IO 原语自读配置文件',
    '扩展侧:API 文档面覆盖函数文档(kbengine.hover.apiDocs / kbengine.python.apiMetadata);项目配置文件发现/解析面无——not-covered',
  ],
  status: 'not-covered',
};

/** 登记册全量(顺序=lane 逻辑分组:引擎配置→消息→客户端→defs→扩展→JSON→Python)。 */
export const CONFIG_READ_PATH_ENTRIES: readonly ConfigReadPathEntry[] = [
  SERVER_CONFIG_ENTRY,
  FIXED_MESSAGES_ENTRY,
  CLIENT_CONFIG_ENTRY,
  PROJECT_DEFS_ENTRY,
  EXTENSION_SETTINGS_ENTRY,
  SERIALIZATION_SCHEMA_ENTRY,
  PYTHON_RESOURCE_IO_ENTRY,
];

export function configReadPathByLane(lane: string): ConfigReadPathEntry | undefined {
  return CONFIG_READ_PATH_ENTRIES.find((entry) => entry.lane === lane);
}

export interface ConfigReadPathStatusSummary {
  covered: number;
  parserCoreOnly: number;
  docsOnly: number;
  notCovered: number;
}

/** 状态计数(诊断/登记视图消费;测试锁死口径)。 */
export function configReadPathStatusSummary(
  entries: readonly ConfigReadPathEntry[] = CONFIG_READ_PATH_ENTRIES,
): ConfigReadPathStatusSummary {
  const summary: ConfigReadPathStatusSummary = {
    covered: 0,
    parserCoreOnly: 0,
    docsOnly: 0,
    notCovered: 0,
  };
  for (const entry of entries) {
    switch (entry.status) {
      case 'schema-covered':
        summary.covered += 1;
        break;
      case 'parser-core-only':
        summary.parserCoreOnly += 1;
        break;
      case 'docs-only':
        summary.docsOnly += 1;
        break;
      case 'not-covered':
        summary.notCovered += 1;
        break;
    }
  }
  return summary;
}

const REPO_ANCHOR_ROOTS = ['src/', 'crates/', 'scripts/', 'tests/'];

/**
 * 仓库锚点文件存在性核验用的路径提取:
 * 'src/x.ts:307 说明' / 'crates/.../config.rs:131 说明' / 'package.json:195 ...'
 * → 去掉行号尾巴,仅保留仓库相对路径。引擎锚(kbe/...、client_lib/...、
 * 无路径、docs/ 知识库、engine API 名)一律返回 null——它们不由仓库 fs 核验。
 */
export function repoPathFromAnchor(anchor: string): string | null {
  const head = anchor.split(/\s/, 1)[0];
  if (head.startsWith('package.json')) {
    return 'package.json';
  }
  if (!REPO_ANCHOR_ROOTS.some((root) => head.startsWith(root))) {
    return null;
  }
  return head.replace(/:\d+.*$/, '');
}
