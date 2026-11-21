# RUST-202..217 决策纪要:PLUG 家族整体撤销

日期:2026-11-21。本纪要收口 RUST-202..217(旧 PLUG-001..016,主 todo 排队项 16 项)的拍板。结论:**按 2026-11-17 侦察对账判定,PLUG 家族整体撤销(不建),本批为纯决策收口(零代码增量)。**

## 决策

- **已代决**(巡检代决授权 FW1016D:待拍板项按推荐方案直接执行+仓内标「已代决」):采纳 2026-11-17 侦察对账推荐方案**①PLUG 家族整体撤销**。
- 推荐方案判定依据:产品当前无插件需求;全仓零 kode-plugin 面(src/docs 无 `kode-plugin.json` 任何出现,无插件宿主/loader/schema 消费方,无插件作者与插件生态);为不存在加载器与作者的生态定义 schema/扩展点/配额/隔离属**仪式性死工件(比无更糟)**;同 RUST-189 CommandDefinition/RUST-191 REPL 判例「无消费者的新抽象不建」;PLUG 家族(202..217)是连贯子系统,单交付任何一项都无法形成可用插件面。
- 产品扩展点角色由 **VS Code 扩展自身**承载:`kbengine.*` 设置键族 + `package.json` contributes + Rust `$/kode` RPC 注册表(受控扩展面)。
- 复启条件:若立真消费场景(明确第一位插件作者与要解决的真扩展需求),按家族逐行产品化,届时 **RUST-202 先行**(203..217 均依赖 schema)。

## 家族成员 → 既有等价面映射

| 行 | 旧编号 | 要求 | 既有等价/相邻面 | 判定 |
| --- | --- | --- | --- | --- |
| RUST-202 | PLUG-001 | `kode-plugin.json` schema | 无等价面:为不存在加载器与作者的生态定义 schema=死工件 | 撤销 |
| RUST-203 | PLUG-002 | 九类扩展点 | `kbengine.*` 设置键族+`package.json` contributes+Rust `$/kode` RPC 注册表(受控面) | 撤销 |
| RUST-204 | PLUG-003 | 插件只请求稳定 DTO,不暴露 mutable graph | `$/kode/*` RPC 全集 35 项(RUST-055 契约门钉形状:请求/响应信封+纯数据结构,零 mutable graph 暴露) | 撤销 |
| RUST-205 | PLUG-004 | CPU/超时/内存/输出大小/并发配额 policy | IndexScheduler 交互冷却+RPC lane 划分(Interactive/Cpu)+墙钟预算断言族 | 撤销 |
| RUST-206 | PLUG-005 | 安全隔离(trusted built-in/显式授权/声明能力) | workspace trust manifest 闸(RUST-198:扩展自身未信任工作区零执行) | 撤销 |
| RUST-207 | PLUG-006 | 宿主崩溃/挂起/协议不兼容自动停用 | 核心功能不经插件(kbengine 扩展单体),「保留核心功能」天然成立 | 撤销 |
| RUST-208 | PLUG-007 | 贡献顺序显式 builtin<profile<workspace+冲突显示来源 | 配置合并视图(RUST-180 来源/优先级/冲突四维)+VS Code 设置分层(user<workspace) | 撤销 |
| RUST-209 | PLUG-008 | 插件 API SemVer/版本协商/弃用窗口/兼容检查 | KB-VER-001 引擎版本链(fork-3.12+自由串)+RUST-055 SURFACE_PINS 递归指纹契约门 | 撤销 |
| RUST-210 | PLUG-009 | 配置隔离+密钥在 SecretStorage,禁写 metadata/trace | DB 密码 RSA 密文流转+引擎配置读取;kode 零明文密钥落 settings.json(SecretStorage 方向 BYOK 已定未实施) | 撤销 |
| RUST-211 | PLUG-010 | 诊断结果以 file version/generation 固定,废弃过期结果 | 诊断调度器 fileChanged 失效+versionKey LRU 协议(不透明键/无键回退/max 8)+索引 generation 面 | 撤销 |
| RUST-212 | PLUG-011 | generator dry-run/preview/权限列表/atomic write/冲突合并 | 自有 generator 面:confirmGenerationPlanItems 预览+快照写回+undoLastGeneration 账本回滚(RUST-179,builtin 生成器) | 撤销 |
| RUST-213 | PLUG-012 | 最小 sample 插件(类型/诊断/生成器/version profile) | 以宿主与扩展点(202/203)先行,无宿主无处加载=死样例 | 撤销 |
| RUST-214 | PLUG-013 | 独立插件测试工具+manifest validator+教程 | validator/测试工具/教程为插件生态配套,生态不存在=死工件 | 撤销 |
| RUST-215 | PLUG-014 | 插件市场属远期,第一版优先稳定 SDK+本地安装 | 市场保持远期不启动;现有分发面=VSIX 安装(VS Code 扩展市场/nightly 滚动),插件 SDK 无需求方 | 撤销 |
| RUST-216 | PLUG-015 | Python 插件用独立 worker RPC,不嵌 CPython 进 Core | pythonExecService 常驻解释器+帧协议(RUST-190 复用模式)=「独立 Python worker,不嵌入 Core」现成骨架 | 撤销 |
| RUST-217 | PLUG-016 | 0/5/20 插件尾延迟基准+死循环隔离测试 | 0 插件基准=现状本体(hover/definition 尾延迟由 LSP 面预算断言族看护);5/20 基准以宿主存在为前提 | 撤销 |

## 本批增量

- 零代码增量:仅主 todo.md 十六行勾选(2026-11-21 已代决注记)+本纪要;无 src 改动。

## 诚实条款

- 「插件」在 kode 语境指扩展 kode 语言服务/编辑器能力的第三方子系统;本纪要撤销的是该子系统,不代表撤销 VS Code 扩展自身承载的既有受控扩展面(`kbengine.*` 设置/`package.json` contributes/Rust `$/kode` RPC 注册表)——后者是现役形态,继续承载。
- 独立 `kode-plugin.json` schema 不落;若未来立真消费场景,按复启条件从 RUST-202 重新立项,届时 schema 依真实作者与真实需求裁剪,不为齐全而齐全。
- 侦察对账事实以 2026-11-17 todo.md 各行注记为准;本纪要未重新全仓扫描(2026-11-21 抽查确认 src/ 仅 `protocolTooling.ts` 含「plugin」字样,系 Wireshark tshark 插件探针,与 kode 插件子系统无关)。
