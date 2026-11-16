# RUST-151 审计结案:Python version / 语法方言 / 引擎支持版本与 workspace profile 区分

日期:2026-11-17
性质:审计结案(基线零改动)——三要素现状逐面核实,「明确」与「workspace 区分」均已由既有面满足。

## 三要素现状

### 1. KBEngine 引擎支持版本——已明确

- 设置键 `kbengine.engineVersion`(window,默认 `3.7.3`):src/engineVersion.ts 全套——预设常量表(3.7.3/3.7.2/3.6.3/fork-3.12/2.5.10)、容错归一(非字符串/空串回落默认)、精确键变更事件播报(KB-VER-001 交付,6bae154 线);
- 消费面:knowledge-base 分层标注与诊断版本门控(hoverBuilders/completion 的 KB-VER-002 分层标注、KB-VER-003 越界提示)、fork 前缀口径(fork- 前缀抑制 fork 标注;无前缀 fork 版本保守标注,docs/guide/configuration.md:190);
- 项目打开时从引擎安装的版本 marker 差异化建议(一键提供,绝不自动应用;忽略按 workspace 记忆)。

### 2. Python version——已明确

- 设置键 `kbengine.infer.pythonVersion`(window,默认 `3.7`):pyrefly infer `--python-version` 的目标,描述与文档(docs/guide/configuration.md:313)均声明语义=「KBEngine 内嵌解释器版本;官方最小支持 3.5」;
- pyrightconfig 同步面不写 pythonVersion(用户显式配置不干预)——用户侧 pythonVersion 与引擎内嵌版本错位属用户显式选择,扩展如实不接管(登记为边界)。

### 3. 语法方言——已明确

- 方言定义=引擎内嵌 CPython 的语法版本(`kbengine.infer.pythonVersion` 描述声明);官方最小 3.5,默认按 3.7;
- 扩展自有解析面(正则扫描器+Rust 侧 ruff AST 容错解析)按超集语法容错解析,不做版本敏感的语法拒绝(语义面按引擎版本门控走 engineVersion,不走 python 方言分支)——ruff_python_parser 未显式设 target version,容错解析超集口径如实登记;
- 采集机 Python(工具链)与引擎内嵌 Python 是两层级,FLOW-024 勘误在案(sys.monitoring 3.12+ 属采集机能力,引擎 3.7.3 内嵌 python 不具备)——混同已勘误。

## workspace profile 区分——已由 settings 层次天然满足

两键均为 window scope:**每个 workspace 的 .vscode/settings.json 可独立设置**(VSCode 配置层次:window 键在 user/workspace/folder 三层解析,workspace 层覆盖 user 层)。「以 workspace profile 区分」=不同项目开不同窗口、各自 workspace settings 各自设版本——这正是 KBEngine 项目形态(一个项目一个引擎集成,一个 workspace 一套 scripts/引擎根)。

同一窗口内逐 folder 的 resource 级区分**裁定不做**:消费面 getEngineVersion() 无 uri 参数、全部门控调用点不需逐根版本;多根 workspace=同一项目的多目录(scripts/assets 分根),不是多个引擎项目。engineVersion 的建议忽略记忆已是 per workspace(文档 :190 尾句)。

## 结论

任务三要素(明确 Python version、语法方言、引擎支持版本;workspace profile 区分)现状全部满足:两配置键+描述文案+docs/guide/configuration.md 对账行(:190/:193/:313)+预设表+建议面+workspace 级记忆。基线零改动,登记两边界(用户 pyrightconfig pythonVersion 不接管;ruff 超集容错解析无 target version)。
