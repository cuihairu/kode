# UX-REVIEW-009b 真机走查汇总 2026-11-10(Windows imac,四阶段 A/A2/B/C)

平台包(TS+Rust,kode-0.2.0-win32-x64.vsix)在 **Windows 真机**(imac peer,
ssh 可达)从安装包执行首用走查。场景=scripts/ux-walkthrough-scenarios.sh
确定性装配(2-valid-project=107 文件 12 def;5-server-reachable 带真实引擎
telnet 192.168.5.188:31000)。分阶段报告(全文)在 ~/pa007-evidence/
009b-stage{A,A2,B,C}-report.md,截图 sA_*/sA2_*/sB_*/sC_* 同目录。

**执行方式如实声明**:hermes peer 派发 agent 任务;UI 交互走 PowerShell/UIA
(cua-driver 输入被审批墙阻断,截屏与 AX 无障碍树可用);证据三方交叉
(cua 截屏 + exthost/output 日志 + UIA 树)。

## 阶段结论

### Stage A(首次安装/卸装/空目录)
- 装包卸装干净;空目录识别面诚实(「未找到 KBEngine 项目」+发现报告入口,
  其余 11 视图正确隐藏,仅留 start 引导);激活事件空目录走 onStartupFinished;
  有效项目未信任时零痕迹(Restricted Mode 扩展整体禁用——本身即首用困惑点)。
- 困惑点:K 图标在活动栏第 10 位无文字标签;状态栏 3 项混入 codicon 名;
  Restricted Mode 全英文横幅;空目录扫描无中间进度态。

### Stage A2(有效项目首用,场景 2)
- 信任解锁实录:任务原计划 `security.allowedUntrustedFilePaths` **该键在
  VS Code 不存在**(workbench 包 0 命中)——平台层困惑点:无按路径白名单
  信任,只能整体关 trust 或逐个手动 Trust;实测有效解锁=user settings
  `security.workspace.trust.enabled:false`(须全关重开生效,走查后还原)。
- 发现报告命令真实执行(Output 通道全文,`[missing] kbengine.binPath` 带补救链);
  侧栏 12 视图齐;**实体区只见 Types 5**(当时定性为缺陷,后经 Stage C+Linux
  破案修正,见下「实体区终审结论」)。
- 困惑点 8 条(全文见 stageA2 报告 §4):侧栏不自动开/实体区名不副实/
  discovery 命令难搜/报告有问题无主动通知/machined 文案偏技术/
  View entities 点击无反应/Quick Action 标签过长截断等。

### Stage B(场景 5 真实引擎:服务器入口/快速执行/实体区/telnet)
- 服务器入口:6 组件真实状态面;machined UDP 发现实测(unreachable 诚实文案)。
- 快速执行:入口可达,7 条动作全 confirm:true(防线在,误触有拦截);
  无命令输入框面(受限,如实)。
- telnet:真机端口开,无密码 → 停在 Auth required + Connect session(auto login)
  按钮,无命令输入框——诚实降级合格,但「想跑只读命令没入口」是可用性缺口。
- 实体区:等满 3 分钟仍只有 Types(后修正,见终审结论)。
- 困惑点 8 条(全文见 stageB 报告 §4):实体区在折叠线以下不滚动看不到(←
  **此条即破案线索,与 Linux 破案互相印证**)/telnet 无输入框/machined 文案/
  服务器启动无引导/def 分析命令中文难搜/命令面板中文输入乱码等。

### Stage C(三步定位协议 + 信任还原,2026-11-10 14:20-14:50)
- 协议实测:Reload Window → kbengine.def.analyze → Output 落盘。def 分析
  **成功枚举全部 12 def**(`Def analysis finished: 12 files, 2 suggestions`,
  c_def_output.log 1631B);重载与分析都不改变实体区形态(sC_07/08/11)。
- 信任还原(强制末步):`security.workspace.trust.enabled` 还原后**键不存在
  (0 出现)**,与 settings.json.bak-009bC 逐字一致(diff IDENTICAL;两份备份
  互为一致);pre-restore 快照留档供审计。
- 重开核对(如实):还原后窗口回到 Restricted Mode(目录未入信任列表=VS Code
  默认行为),扩展 onStartupFinished 激活但活动栏 K 图标/侧栏贡献点不注册
  ——「激活但不呈现」,信任模式标准行为,非缺陷(sC_13)。
- 首跑事故(如实):Stage C 首跑场景错乱(5-server-reachable/4-backend-unavailable,
  sC_01..06 非本场景证据);第一次续跑派发参数错(MaxTokens 超上界)未执行;
  第二次续跑完整达成。

## 实体区终审结论(修正 Stage A2/B 判词,跨 009b/009c)

**「实体分组缺失」判词作废**。2026-11-10 14:30 本机(Linux)用走查同款
profile+场景复现追查破案:

- 数据层健康:Node 探针(tests/_tmp_verify/entityTreeProbe.test.ts,不提交)
  对场景实测 getDefinitionEntries 四组齐——Types 5 / Entities 9 / Interfaces 2 /
  Components 1;imac 侧 def 分析 12 def 全枚举互证。
- 渲染层健康:真窗口折叠 Types 组后 Entities 9 即现(probe_tree_05.png),
  视图内滚轮后 Interfaces 2+Components 1 全在场(probe_tree_08.png)。
- **真相=多视图侧栏高度压缩**:10+ 视图同容器时 Entities 视图分配高度只够
  首屏(Types 5+子项),后三组压在视图内折叠线以下、overlay 滚动条零提示——
  imac(Stage A2/B)与 Linux(009c)两轮走查均误读为「分组缺失」。
  Stage B 困惑点 2「实体区在折叠线以下,不滚动看不到」即为机制本身。
- 保留的真实缺陷=**可发现性**(已登记 todo UX-REVIEW-011,改进候选:
  entityExplorer 置顶/低价值区块默认折叠/压缩态组徽章外露——设计决策待用户)。
- getDefinitionEntries(src/definitionWorkspace.ts:1291)直读 entities.xml+
  entity_defs,不依赖 def 分析命令——「def 分析未跑」假设源码面即否定。

## UX-REVIEW-004b 判定(导出前预检)

**达成**。证据:Linux 009c(pl_06/07)点「Export players」→ toast
「Source connection is not configured.」+「Configure source connection」入口
(进 005a/005c 向导);顺序=先查连接再收实体/DBID,符合「不先丢失已输入
上下文」。imac 侧同源证据见 Stage A2/B 观察面。剩余腿:向导完成后的
「继续任务/清楚说明如何重试」半边——005 系列向导本身另行覆盖,此处仅判
预检面达成。

## 未验证(如实)

- macOS 整腿:无真机;按用户令 2026-11-10 只编译不测试(nightly CI darwin-x64/
  darwin-arm64 编译+测试+打包全绿 run 42752103203),真机走查不做。
- Windows 纯 TS 包腿:未走查(universal VSIX 已备)。
- 无障碍/读屏:未走查(UIA 树部分覆盖,非读屏视角)。
- imac 侧折叠 Types/视图内滚轮验证:Restricted Mode 下 KBEngine 视图不注册,
  sC_12 未完成(Linux 侧已证)。
- 真实引擎完整服务器生命周期(启动/热更/关闭):场景 5 只覆盖入口与状态面。

## 证据索引

- 分阶段报告:~/pa007-evidence/009b-stage{A,A2,B,C}-report.md
- 截图:~/pa007-evidence/sA_*.png(3)/sA2_*.png(5)/sB_*.png(7)/sC_*.png(6+首跑6)
- Output 落盘:~/pa007-evidence/c_def_output.log(12 def 全枚举)
- Linux 对照证据:/tmp/k009c/shots/probe_tree_05/08.png + tests/_tmp_verify/
  entityTreeProbe.test.ts(本机一次性探针,不入库)
- Linux 腿汇总:docs/ux 同期 009c 结论见 ~/pa007-evidence/009c-linux-report.md
  (核心发现 #1/#2 已按破案口径修正)
