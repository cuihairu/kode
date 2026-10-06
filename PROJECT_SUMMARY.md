# Kode - 项目状态总结

## 已完成的工作

### 仓库设置
- [克隆仓库到本地]
- [配置 git 用户信息]
- [创建完整的项目结构]
- [推送到 GitHub]

### 版本信息
- **版本号**: 0.1.0
- **许可证**: Apache-2.0
- **发布者**: cuihairu

### 核心功能实现

#### 1. 语法高亮
- [源码对齐的基础/容器/细节语义高亮]
- [容器类型 (ARRAY, FIXED_DICT, TUPLE)]
- [源码对齐的 Flags / DetailLevel]
- [XML 标签和属性]

#### 2. 智能提示 (IntelliSense)
- [类型自动补全]
- [Flags 智能提示]
- [DetailLevel 提示]
- [XML 标签提示]
- [**钩子方法自动补全 (36 hooks,全部带源码调用位置)**]

#### 3. 代码片段
- [11 个常用模板(.def)+ 4 个 Python 热更模板 + 2 个 types.xml 类型别名模板]
- [kbe-prop - 基础属性]
- [kbe-vector3 - VECTOR3 属性]
- [kbe-array - 数组属性]
- [types.xml 专用: kbe-fixed-dict / kbe-array-alias(FIXED_DICT 在当前引擎版本仅支持经 types.xml 别名声明,引擎不解析 .def 内联 FIXED_DICT;TUPLE 类型在引擎注册表中不存在,已剔除)]
- [kbe-prop-db - 带数据库长度]
- [kbe-prop-detail - 带细节级别]
- [kbe-client-method - 客户端方法]
- [kbe-base-method - BaseApp 方法]
- [kbe-cell-method - CellApp 方法]
- [kbe-method-multi - 多参数方法]
- [kbe-comment - 注释模板]
- [kbe-entity-reg - 实体注册]
- [kbe-hot-reload-entity - 实体热更新]
- [kbe-hot-reload-script - 脚本热更新]
- [kbe-hot-reload-best-practice - 热更新最佳实践]
- [kbe-is-reload - 检查热更新状态]

#### 4. 悬停文档
- [类型详细说明]
- [Flags 用途解释]
- [使用建议]
- [**钩子完整文档**]
  - 调用时机
  - 函数签名
  - 使用示例
  - 源码位置

#### 5. 跳转定义
- [从 entities.xml 跳转到 .def 文件]

#### 6. 语法检查
- [实时语法验证]
- [源码可证实的 Flags / DetailLevel / 必填字段校验]
- [类型有效性检查]

#### 7. 实体浏览器
- [侧边栏显示所有实体]
- [实体类型标识]
- [快速导航]

#### 8. 钩子系统 [新增]
- [36 个 KBEngine 实体脚本回调（全部经引擎源码逐条核实）]
- [10 个分类]
- [完整的钩子数据 (src/hooks.ts)]
- [智能提示支持]
- [悬停文档支持]

#### 9. 热更新支持 [新增]
- [11 def + 4 Python 热更 + 2 types.xml 片段]
- [KBEngine.reloadScript() 智能提示]
- [importlib.reload() Python 脚本热更新]
- [重载相关悬停文档和示例]

#### 10. 服务器管理 [新增]
- [10 个组件管理（machine, logger, dbmgr, baseappmgr, cellappmgr, loginapp, baseapp, cellapp, bots, interfaces）]
- [启动/停止/重启控制]
- [实时状态显示]
- [进程 PID 显示]
- [组件独立日志输出]
- [状态栏集成]
- [源码：src/serverManager.ts]

#### 11. 日志查看集成 [新增]
- [logger 连接入口与状态说明]
- [日志解析器（文本和二进制格式）]
- [WebView 可视化界面]
- [多级过滤（级别、组件、关键词）]
- [正则表达式搜索]
- [日志导出（txt/log/json）]
- [彩色日志级别显示]
- [源码：src/logCollector.ts, src/logParser.ts, src/logWebView.ts]

#### 12. Python 调试支持 [新增]
- [自定义调试配置（.kbengine/debug.json）]
- [组件特定调试设置]
- [自动生成 launch.json 配置]
- [支持启动调试和附加到进程]
- [路径映射和环境变量]
- [源码：src/debugConfig.ts]

#### 13. 监控面板 [新增]
- [基于 machine + watcher 的运行态监控]
- [CPU、内存、实体数量与已核实 watcher 指标展示]
- [系统概览卡片]
- [组件详细指标卡片]
- [可视化图表（Chart.js）]
- [数据导出（JSON）]
- [源码：src/monitoringCollector.ts, src/monitoringWebView.ts]

#### 14. Python [Def 双向跳转 ⭐ 新增]
- [实体定义映射管理器]
- [从 .def 跳转到 Python（已有）]
- [**从 Python 跳转回 .def 文件**]
- [**Python 文件智能提示（属性和方法）**]
- [自动扫描 .def 文件和 Python 文件]
- [支持多个 Python 路径配置]
- [源码：src/entityMapping.ts]

#### 15. 实体依赖关系图 [新增]
- [自动分析实体继承关系]
- [可视化实体依赖图（Mermaid.js）]
- [支持继承关系显示]
- [统计信息面板（实体数量、最大深度等）]
- [从图跳转到实体定义文件]
- [支持导出图表（PNG/SVG）]
- [源码：src/entityDependency.ts, src/entityDependencyWebView.ts]

#### 16. 代码生成器 [新增]
- [实体创建向导]
- [10 个预定义模板（账号、角色、NPC、物品、怪物、场景、公会、队伍、邮件、空实体）]
- [自动生成 .def 文件]
- [自动生成 Python 文件]
- [自动在 entities.xml 中注册]
- [支持自定义属性和方法]
- [源码：src/codeGenerator.ts]

#### 17. 重构支持（.def 属性/方法重命名）
- [.def 文件内 F2 重命名属性/方法（原生 RenameProvider，无命令贡献点）]
- [同文件同名声明与 Flags 作用域变体视为同一文本符号一并更新（引擎按三域分立建条目，改名不改变装载合法性）]
- [传播边对齐引擎装载路径（批96 复核）：Parent/接口名按引擎 getKey 取首个子节点（文本或元素），实体/组件/接口各按引擎目录解析，接口文件不读 Parent，直取形态接口引用不跟随]
- [如实边界：Python 侧引用、entities.xml、types.xml 不在重命名范围；新名同名冲突不做装载校验]
- [源码：src/defRenamer.ts（纯逻辑）、src/languageProviders.ts（KBEngineRenameProvider）]

#### 18. 性能分析建议
- [工作区全量 .def 静态分析（命令 `kbengine.def.analyze`）]
- [8 个检查项：幻影类型、缺 Type、重复 Type、重广播开销、冗余 DetailLevel、Python 关键字标识符、方法属性同名、引擎受限名(批99)]
- [批96 引擎复核：客户端可见旗标集取 ENTITY_CLIENT_DATA_FLAGS 真值，同名冲突/缺 Type 按「装载失败」表述，关键字按「引擎不失败、脚本不可访问」表述，重复 <Type> 按引擎首取语义表述；同名检查限单文件]
- [报告写入「KBEngine Def 分析」输出面板并以诊断落入问题列表]
- [源码：src/defAnalyzer.ts]

#### 19. 代码片段生成器
- [选区生成自定义片段（命令 `kbengine.snippets.generateFromSelection`）]
- [片段语法转义（`$`/`\`）+ 公共缩进剥离，合并写入 `.vscode/kbengine-custom.code-snippets`]
- [同名条目覆盖有警告；坏 JSON 片段文件拒绝改写]
- [源码：src/snippetGenerator.ts]

### 文档
- [README.md - 项目说明]
- [CHANGELOG.md - 变更日志]
- [CONTRIBUTING.md - 贡献指南]
- [TESTING.md - 测试架构与批次台账]
- [COMPLETED_FEATURES.md - 已完成功能清单]
- [KBENGINE_SOURCE_AUDIT_PLAN.md - 引擎源码对照计划]
- [docs/ - VitePress 文档站（11 个页面，`pnpm run docs:dev` 预览）]
- [resources/docs/ - 早期设计与命名文档（3 个）]

### 开发配置
- [package.json - 扩展配置]
- [tsconfig.json - TypeScript 配置]
- [language-configuration.json - 语言配置]
- [.vscode/launch.json - 调试配置]
- [.vscode/tasks.json - 任务配置]
- [.vscode/extensions.json - 扩展推荐]
- [.gitignore - Git 忽略规则]
- [.npmignore - NPM 忽略规则]

## 项目结构

```
kode/
├── .vscode/
│   ├── extensions.json       # 扩展推荐
│   ├── launch.json           # 调试配置
│   └── tasks.json            # 任务配置
├── docs/                     # VitePress 文档站 (11 个 .md)
├── resources/
│   ├── logo.png              # 用户设计资产（Marketplace 图标/活动栏）
│   └── docs/                 # 早期文档 (3 个 .md)
├── snippets/
│   ├── kbengine.json         # def 代码片段 (11个)
│   ├── kbengine-python.json  # Python 热更片段 (4个)
│   └── kbengine-types-xml.json # types.xml 别名片段 (2个)
├── src/                      # 27 个 TypeScript 文件，17684 行
│   ├── extension.ts          # 扩展入口（命令装配/注册面）
│   ├── languageProviders.ts  # 补全/悬停/诊断/跳转/重命名 Provider
│   ├── defParser.ts          # .def 解析与文本定位
│   ├── defRenamer.ts         # .def 重命名纯逻辑
│   ├── defAnalyzer.ts        # 性能分析静态检查
│   ├── snippetGenerator.ts   # 自定义片段生成纯逻辑
│   ├── definitionSemantics.ts      # 定义语义与继承合并
│   ├── definitionWorkspace.ts      # 定义工作区解析
│   ├── databaseSchema.ts     # 数据库 schema 虚拟文档
│   ├── explorerProviders.ts  # 实体浏览器/服务器树
│   ├── kbengineMetadata.ts   # 引擎元数据（类型/Flags/DetailLevel）
│   ├── kbengineProtocol.ts   # machine 发现与 watcher 协议编解码
│   ├── hooks.ts              # 钩子数据 (36 hooks,含源码调用位置)
│   ├── serverManager.ts      # 服务器管理器
│   ├── serverCommandTarget.ts # 服务器命令目标解析
│   ├── logCollector.ts       # 日志收集器
│   ├── logParser.ts          # 日志解析器
│   ├── logWebView.ts         # 日志 WebView
│   ├── debugConfig.ts        # 调试配置管理器
│   ├── monitoringCollector.ts # 监控数据收集器
│   ├── monitoringWebView.ts  # 监控面板 WebView
│   ├── entityMapping.ts      # Python-Def 映射管理器
│   ├── pythonLanguageUtils.ts # Python 补全上下文工具
│   ├── entityDependency.ts   # 实体依赖分析器
│   ├── entityDependencyWebView.ts # 依赖图 WebView
│   ├── codeGenerator.ts      # 代码生成器 (10 模板)
│   ├── workspacePath.ts      # 跨平台路径工具
│   └── test/                 # mocha 编译产物烟测 (11 用例)
├── syntaxes/
│   ├── kbengine.tmLanguage.json  # 语法高亮规则
│   └── kbengine-color-theme.json # 主题
├── tests/                    # vitest 测试 (83 文件 999 用例,含 sim/fake-vscode 设施)
├── .gitignore
├── .npmignore
├── CHANGELOG.md              # 变更日志
├── COMPLETED_FEATURES.md     # 已完成功能清单
├── CONTRIBUTING.md           # 贡献指南
├── KBENGINE_SOURCE_AUDIT_PLAN.md # 引擎源码对照计划
├── LICENSE                   # Apache-2.0 许可证
├── README.md                 # 项目说明
├── TESTING.md                # 测试架构与批次台账
├── language-configuration.json
├── package.json              # 扩展配置 (v0.1.0)
└── tsconfig.json             # TypeScript 配置
```

## 钩子系统详情

### 支持的钩子分类 (10 个,共 36 个回调)

全部条目依据 KBEngine 引擎源码取证:每个回调的 `sourceLocation` 指向引擎调用该脚本回调的
确切位置(`Py_BuildValue` / `SCRIPT_OBJECT_CALL_ARGS` 调用行),签名参数亦取自该处格式串。
曾在早期版本列出、但未在源码中出现的回调名(如 onCreate/onLogon/onRemoteCall 等)已全部剔除。

| 分类 | 钩子数量 | 回调 |
|------|----------|------|
| **lifecycle** | 3 | onDestroy, onTimer, onRestore |
| **database** | 2 | onWriteToDB, onPreArchive |
| **movement** | 4 | onMove, onMoveOver, onMoveFailure, onTurn |
| **space** | 3 | onEnterSpace, onLeaveSpace, onSpaceGone |
| **teleport** | 3 | onTeleport, onTeleportSuccess, onTeleportFailure |
| **trap** | 3 | onEnterTrap, onLeaveTrap, onLeaveTrapID |
| **cell** | 6 | onGetCell, onCreateCellFailure, onEnteredCell, onEnteringCell, onLeavingCell, onLeftCell |
| **witness** | 6 | onGetWitness, onLoseWitness, onWitnessed, onEnteredView, onUpdateBegin, onUpdateEnd |
| **control** | 1 | onLoseControlledBy |
| **client** | 5 | onClientEnabled, onLogOnAttempt, onClientDeath, onClientGetCell, onStreamComplete |

**总计**: 36 个钩子

### 钩子数据文件

- **位置**: `src/hooks.ts`
- **导出**:
  - `KBENGINE_HOOKS` - 所有钩子数据
  - `getHooksByCategory()` - 按分类获取钩子
  - `getHookByName()` - 根据名称查找钩子
  - `HOOK_CATEGORY_NAMES` - 分类中文名

## 下一步计划

### MVP 完善
- [x] 测试所有功能(批88:17 项已完成功能逐项验证,全部有自动化用例覆盖)
- [x] 修复发现的问题(批88:tmLanguage 与引擎注册表对齐等修复,均带回归锁)
- [x] 添加单元测试(vitest 功能层 999 用例 + mocha 编译产物烟测层 11 用例双层,详见 TESTING.md)
- [x] 优化性能(批92:validateDocument −46%、全文件分词 −17%,行为以 golden 回归锁)

### 发布准备
- [x] 创建扩展图标(已由用户设计资产 resources/logo.png 满足,批90 恢复用户资产口径)
- [ ] 准备 Marketplace 截图
- [ ] 完善文档
- [ ] 发布到 VSCode Marketplace

### 未来功能
- [x] Python 集成 (从 Python 跳转到 .def) ✅ 已完成
- [x] 实体依赖关系图 ✅ 已完成
- [x] 代码生成器 ✅ 已完成
- [x] 重构支持 (重命名属性/方法)→ 批58 落地为 .def 面重命名（见功能 17）
- [x] 性能分析建议 → 批91 落地（见功能 18）

## 快速命令

```bash
# 开发
pnpm install              # 安装依赖
pnpm run compile          # 编译
pnpm run watch            # 监听模式编译
code .                   # 在 VSCode 中打开，然后按 F5 调试

# 测试
pnpm test                # 运行测试
pnpm run lint            # 代码检查

# 发布
pnpm run package         # 打包扩展
pnpm run publish         # 发布到 Marketplace
```

## 项目亮点

1. **完整的钩子系统** - 36 个钩子，每个都有详细文档与源码调用位置
2. **源码级文档** - 包含源码位置，便于深入研究
3. **实用的代码片段** - 11 个 def 模板 + 4 个 Python 热更模板 + 2 个 types.xml 模板(全部经引擎源码核实)
4. **专业的项目结构** - 符合 VSCode 扩展最佳实践
5. **详细的文档** - 从设计到开发的完整文档

## 统计数据

- **代码文件**: 27 个 TypeScript 文件（src/，不含 src/test 烟测，实测）
- **钩子数量**: 36 个
- **代码片段**: 11 def + 4 Python + 2 types.xml
- **预定义实体模板**: 10 个
- **文档页数**: 21 个 Markdown（仓库根 7 + docs/ 11 + resources/docs 3）
- **总行数**: 17684 行（src/ TypeScript，实测）

---

**项目地址**: https://github.com/cuihairu/kode

**当前版本**: 0.1.0

**许可证**: Apache-2.0
