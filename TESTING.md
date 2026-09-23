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

vitest 覆盖率(2026-09-23,`pnpm test:coverage`):

| 指标 | 值 |
|------|-----|
| Statements | 16.63% |
| Branches | 14.33% |
| Functions | 16.84% |
| Lines | 16.72% |

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
| kbengineProtocol.ts | 49.4% | 28.8% |
| entityMapping.ts | 14.3% | 14.8% |

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
