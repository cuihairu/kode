//! kode-root — KBE 根发现(PR-006,书 §5 VFS-009 完整版 + §17 PR-006, PH1-05)。
//!
//! 职责:识别工作区内的 KBEngine 资源根(实体定义目录 / entities.xml /
//! types.xml / 服务器资产根 / 引擎源码根 / 引擎消息表),识别优先级与策略
//! 全部可测;引擎配置规则从 TS discovery 移植并逐条证据化(见
//! [`conventions`] 模块内的 `src/workspaceDiscovery.ts:行号` 注记)。
//!
//! ROOT 条目 ledger(基础版;与 docs/kode2/pr-006.md 对应):
//!
//! | 条目 | 内容 | 落点 |
//! |---|---|---|
//! | ROOT-001 | 根识别优先级分层可测:显式配置 > 记忆选择 > 约定链 > 有界深扫描;多候选宁缺勿猜(歧义回诊断,不猜) | [`resolve`] |
//! | ROOT-002 | 平台路径规则:Windows 大小写折叠+盘符大写 / macOS 默认折叠(声明) / Linux 敏感 / WSL UNC 前缀语义 | [`platform`] |
//! | ROOT-003 | 逐平台典型树夹具:linux_assets / engine_repo / multi_ambiguous 等,夹具即验收 | `tests/fixtures/` |
//! | ROOT-004 | submodule / vendored 判定:.gitmodules 命名或 .git 标记 = 仓边界;vendored 组件名单 = 厂边界;边界内锚点降级不误导根 | [`scan`] |
//! | ROOT-005 | mount 循环判定:跟随模式下 canonical 身份 visited 集 + 深度封顶,绑定挂载环终止有保障 | [`scan`] |
//! | ROOT-006 | 别名路径判定:`//`、`./`、`..`、尾 `/`、symlink 别名 → 同一根身份只记一次 | [`platform`] + [`scan`] |
//! | ROOT-007 | 符号链接循环判定:默认不跟随目录 symlink(VFS-010 口径);显式跟随带环护栏,不挂死 | [`scan`] |
//! | ROOT-008 | 引擎配置规则移植并证据化:约定链/探针/锚点全部对齐 TS 实现,注释带 file:line | [`conventions`] |
//! | ROOT-009 | 敏感目录不动:.git/node_modules/.vscode/out/dist/点前缀目录剪枝,逐目录逐文件级可断言(visited 台账) | [`scan`] |
//! | ROOT-010 | 与 TS discovery 对拍:Rust dump-golden 生成 → TS vitest 用现有 scanWorkspaceAnchors 复算,双向门禁 | `tests/golden/` + `tests/kodeRootParity.test.ts` |
//! | ROOT-011 | UR+Path 双支持:输入可为 `file://` URI 或原始路径,统一走 kode-vfs CanonicalUri | [`platform`] |
//! | ROOT-012 | 诊断输出仅新启:发现报告/诊断只在冷跑产生,缓存命中不重复发(报告带 from_cache 旗标) | [`resolve`] |
//! | ROOT-013 | 有界深扫描:深度 7 / 条目 20000 上限与 TS 同源,触顶截断如实标注(零命中 ≠ 没有) | [`scan`] |
//! | ROOT-014 | 多根注册与归属:注册顺序=优先顺序、最长前缀归属、平台折叠感知、冲突出诊断 | [`resolve`] |
//! | ROOT-015 | 引擎侧定位家族:kbe 源码根锚点 + 消息表双名四级 + 资产根家族,全对齐 TS 口径 | [`resolve`] |
//!
//! 与 kode-vfs 的关系:VFS-009 的 RootRegistry 仍是文档归属的身份层;
//! 本 crate 是"哪些目录配得上当根"的发现层,发现结果交给 RootRegistry 注册。

pub mod conventions;
pub mod diag;
pub mod golden;
pub mod platform;
pub mod resolve;
pub mod scan;

pub use conventions::{
    conventional_config_roots, has_engine_config_probe, DiscoveryConventions, CONVENTIONS,
    DEFAULT_SCAN_DEPTH, DEFAULT_SCAN_MAX_VISITED, SKIP_DIRECTORY_NAMES,
};
pub use diag::{RootDiagnostic, RootDiagnosticCode};
pub use platform::{case_folds, PlatformTarget, RootPath, RootPathError};
pub use resolve::{
    resolve_engine_messages_xml, AnchorKey, DiscoveryEngine, DiscoveryReport, ExplicitConfig,
    FieldReport, FieldStatus, PlatformRootRegistry, ResolutionSource, ENGINE_MESSAGES_LABELS,
};
pub use scan::{
    scan_workspace_anchors, AnchorScanner, Boundary, BoundaryKind, ScanOptions, ScanResult,
    VENDORED_DIR_NAMES,
};
