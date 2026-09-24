# Kode 测试说明

本项目采用**双层测试架构**,所有断言都必须基于真实行为,严禁为凑覆盖率写假断言。

## 架构划分

| 层 | 框架 | 位置 | 职责 |
|----|------|------|------|
| 纯逻辑层 | vitest | `tests/` | 不依赖 vscode API 的模块:def 解析、元数据、钩子数据、片段、日志解析、Python 补全上下文等 |
| vscode 集成层 | mocha + @vscode/test-electron | `src/test/suite/` | 需要真实 vscode API 的用例:补全/hover/诊断提供者、explorer、扩展激活、require 缓存隔离的集成测试 |

两套用 vitest 的 `include: ['tests/**/*.test.ts']` 与 tsconfig 的 `exclude: ["tests"]` 严格隔离。

## 运行

```bash
pnpm test           # 全量: vitest + 编译 + @vscode/test-electron mocha
pnpm test:unit      # 仅 vitest
pnpm test:coverage  # vitest + v8 覆盖率(输出 coverage/)
```

## 引擎源码条件测试

`tests/helpers/engineRoot.ts` 解析 KBEngine 源码根目录:优先环境变量 `KBENGINE_ROOT`,
否则按同级检出约定 `../kbengine`。存在时,以下"数据 vs 引擎源码"校验用例会真实执行
(本地检出 `/home/cui/workspaces/kbengine` 下全部通过);源码不存在时自动 skip:

- **hooks**:36 个回调名逐条在引擎 `cellapp/entity.cpp`、`baseapp/entity.cpp`、
  `baseapp/proxy.cpp`、`cellapp/witness.cpp` 中以字符串字面量出现;每条
  `sourceLocation` 的 file:line 打开后该行必须正好包含对应回调名(逐行配对验证)。
- **类型**:补全宣称的每个类型名必须在 `DataTypes::initialize` 注册表中有
  `addDataType("...")` 字面量;`ARRAY` 必须有 `<of>` 解析路径;`FIXED_DICT` 必须只经
  `DataTypes::loadTypes`(types.xml 别名)入口;`BOOL`/`TUPLE` 必须在
  `kbe/src/lib/entitydef/` 全目录中不存在带引号字面量。
- **Flags / DetailLevel**:每个名称在 `entitydef.cpp` 中有对应字面量。

> 本地复现 CI 口径:设 `KBENGINE_ROOT=off` 强制 `resolveEngineRoot()` 返回 null
> (本地同级 kbengine 检出会使命令式 fallback 命中,仅"不设环境变量"复现不了 CI)。
> skipIf 的 describe 回调体在注册期仍会执行,各条件 suite 顶部对 null root 有
> 显式 guard,收集阶段不会触碰任何引擎文件路径。

## 当前覆盖率(v8,全 `src/**` 口径,如实统计,不做剔除美化)

vitest 覆盖率(2026-09-24,`pnpm test:coverage`):

| 指标 | 值 |
|------|-----|
| Statements | 32.46% |
| Branches | 27.15% |
| Functions | 35.26% |
| Lines | 32.57% |

纯逻辑层明细:

| 模块 | Lines | Branch |
|------|-------|--------|
| hooks.ts | 100% | 100% |
| kbengineMetadata.ts | 100% | 100% |
| pythonLanguageUtils.ts | 100% | 90.9% |
| workspacePath.ts | 100% | 100% |
| defParser.ts | 90.5% | 82.7% |
| definitionSemantics.ts | 92.2% | 83.9% |
| logParser.ts | 100% | 98.3% |
| kbengineProtocol.ts | 60.0% | 34.2% |
| entityMapping.ts | 14.3% | 14.8% |
| monitoringCollector.ts | 38.1% | 32.0% |
| entityDependency.ts | 15.9% | 9.0% |
| databaseSchema.ts | 52.7% | 38.8% |
| logCollector.ts | 68.9% | 41.9% |
| codeGenerator.ts | 51.3% | 48.6% |
| definitionWorkspace.ts | 84.0% | 72.6% |

logParser 的语句与函数已全覆盖(剩余 1.7% 分支为 v8 汇总的边界粒度);
其中锁定了一个实现现状:`getLevelName` 的 switch 无 default 分支,越界
级别值返回 undefined,而 `getLevelIcon`/`getLevelColor` 有 default——
三函数不一致,测试如实记录,是否统一留待后续决策。

kbengineProtocol 的编解码纯函数(帧构造、组件广播包解析、watcher 帧解析)已
全覆盖;未达更高的部分是 `discoverLocalComponents`/`queryWatcherPath` 两个
真实 UDP/TCP socket 客户端,不属纯逻辑可测域。协议测试里另有引擎条件用例:
COMPONENT_NAMES 逐项对齐 `COMPONENT_TYPE` 枚举(common.h)、广播端口
20086=KBE_PORT_START+86 与 watcher 回调 msgid 65502 的源码字面验证——
并已据此修出真实缺陷:原 COMPONENT_NAMES 缺 TOOL_TYPE=14('tool')。

entityMapping 的底部纯函数池(方法归属绑定键、八字段身份比对含
propertyPath/sourceChain 归一、Python 文件路径推断组件/接口/实体与方法段、
路径去重、正则转义、行号/列号、`def` 块与 `self.*` 调用提取)已覆盖;
14.3% 的剩余部分是 EntityMappingManager 类本体,深度依赖 vscode
(ExtensionContext/FileSystemWatcher),由 mocha/@vscode/test-electron 侧
100 个用例覆盖。纯函数仅加了 `export`,无任何行为变更。

monitoringCollector 的状态机(暂停/恢复、刷新间隔、启动前后安全的
stop/dispose)、按组件的历史切片、系统总览聚合、watcher 值数值归一
(resolveNumber/resolveBooleanLabel)与 uint64 安全钳制已覆盖;38.1%
的剩余部分是 refresh/refreshNow 等真实发起 machine discovery 与
watcher 查询的 socket 路径,不属纯逻辑可测域。vscodeStub 相应补了
最小 EventEmitter 与 ExtensionContext 占位(真实事件行为仍由 mocha 层覆盖)。

entityDependency 底部四个 XML 解析纯函数(标签体提取、保留名子块提取、
标签剥离、引用三元组去重)已覆盖,并锁定实现语义:非贪婪匹配在首个同名
闭标签截断;保留名包裹块(如 BaseMethods)整体跳过、内层不再展开——
这正是类内"先取 Properties body 再解析子块"两段式调用成立的前提。
15.9% 的剩余部分是 EntityDependencyAnalyzer 类本体,依赖 vscode 文件读取,
由 mocha 层覆盖。

databaseSchema 的虚拟文档 URI/文档识别、schema 文本渲染、表/字段行定位、
mysql 表生成(合成 position/direction 列、ARRAY 子表、FIXED_DICT 平铺
前缀列、VECTOR 展开列、同名去重)与 `scripts/entity_defs` 端到端快照
(真实 def 文件 → 快照 → tbl_Hero/sm_hp/tbl_Hero_bag)已覆盖,并锁定
mysql 列型映射事实(UINT32 → `int unsigned`);47.3% 的剩余部分是
def→属性描述符的深解析(parsePropertyNode 递归等,由端到端用例间接穿透)
与 Provider 生命周期。

logCollector 的状态机(初始未连接、connect 按实现现状拒绝 logger
watcher 协议并落 Error 状态、断开/销毁安全与幂等)、状态事件序列、
环形缓冲截断(maxBufferSize 裁掉最老条目)、按级别/组件过滤、大小写
不敏感与正则检索(非法正则降级为空列表)已覆盖;31.1% 的剩余部分是
sendHeartbeat/sendDeregister 的 socket 写路径与心跳/重连定时器,
不属纯逻辑可测域。

codeGenerator 的纯生成器已覆盖(entities.xml 注册行、def 属性/方法块
含 Exposed/Arg/Default/Persistent/DatabaseLength/DetailLevel/Identifier
各可选的渲染与省略、Python 方法签名与 docstring、def 文档骨架、Python
类名按域取后缀 Cell/Base/原样、onEnterWorld 仅 Cell 实体、Base/Cell
方法段、输出路径解析三态:绝对原样/无关相对原样/scripts/entity_defs
解析到定义根且无目录时回落约定绝对路径、五个内置模板与未知模板回落)。
48.7% 的剩余部分是向导编排(showWizard/QuickPick/写文件/注册 entities.xml),
由 mocha 层覆盖。私有生成方法经实例直调,测真实行为,零 mock。

definitionWorkspace 的纯工作区解析已在真实临时文件树上覆盖(22 用例):
目录布局(entityDefsRoot 候选解析与"目录不存在回落约定路径"、存在性文件
entities.xml/types.xml 无回落保持 null、entityScriptsRoot=定义根父目录、
user_type 根候选序列)、entities.xml 实体注册解析(文档序、按名去重、
has*Declared=属性存在性与 has*=值语义分离)、运行时档案三态(declared/
inferred/disabled:声明值直接生效、未声明由脚本存在推断、显式 false 归
disabled;runtimeRoles 拼接、Client Entity/Server Only 与 Registered on/
Registered, but no runtime role enabled 标签)、types.xml 自定义类型
(aliasType/rawValue 剔除 implementedBy/Properties、属性按名排序、声明行
号、implementedBy→user_type python 实现文件解析)、entity def 文件与
四类别(type/entity/interface/component)条目解析(注册实体与未注册 def
合并、registered 优先后按名排序)。未覆盖部分是依赖 vscode 文档定位的
getWorkspaceRootForDocument 分支与条目结构渲染细节。

说明:

- 0% 的模块全部是依赖 vscode API 的模块(其行为由 mocha/@vscode/test-electron
  侧的 99 个用例覆盖,两个 runner 的覆盖率不做工具级合并)。
- 总体百分比低是因为分母包含全部 23 个源码文件;随纯逻辑测试推进持续抬升,
  每次抬升后更新本表。

## 近期由测试发现并修复的真实缺陷

- `workspacePath.ts` win32 分支在非 Windows 主机上因平台隐式 `path.join` 产出生
  混合分隔符的路径 → 改为显式 `path.win32.join`。
- `snippets/kbengine.json` 的 `ARRAY<x>` 内联写法引擎不解析(FixedArrayType 强制
  `<of>` 子节点)→ snippet 改为引擎真实语法。
- 片段选择列表与补全元数据中的 `BOOL`/`TUPLE` 在引擎类型注册表中不存在 → 全部剔除,
  并由测试锁定不得回归。
