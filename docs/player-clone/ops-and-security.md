# Player Data Clone — 运维说明、敏感数据处理、归档留存/销毁与已知限制（PDC-0607）

> 本文档面向操作者/维护者，如实描述**当前交付面**已实现的行为与边界。凡设计
> 中有而生产路径未接线的能力，一律如实记为「已实现能力/未接线」，不写成已生效。
> 代码依据见 `crates/kode-db-clone/src/` 与 `src/playerDataClone*.ts`、
> `crates/kode-server/src/db_clone.rs`；设计口径见 `docs/design/v0.2.1-player-data-clone-plan.md`。

---

## 1. 运维说明（命令面与数据落地）

### 1.1 命令流（命令面板入口 + 资源管理器上下文菜单）

| 命令 | 作用 | 落地面 |
|---|---|---|
| `kbengine.clone.configureSource` | 配置源库连接 profile（账号入 workspaceState，**密码只入 SecretStorage**） | profile store |
| `kbengine.clone.configureTarget` | 配置目标库连接 profile（同源库口径） | profile store |
| `kbengine.clone.testSource` | 只读探测源连接（information_schema 校验标识符，会话开 READ ONLY） | 无持久化 |
| `kbengine.clone.testTarget` | 探测目标连接（环境只认 local/test，prod/staging 在配置闸即拒） | 无持久化 |
| `kbengine.clone.export` | 选实体 + 根 DBID → 只读计划预览 → 只读会话执行 → 写归档 | `.kdpclone` 文件（默认 `{entity}-{dbid}.kdpclone`） |
| `kbengine.clone.inspectArchive` | 只读清单（entity/format/rows/encryption/checksum + 脱敏报告存在性，**不显示行值**） | 无 |
| `kbengine.clone.import` | 两遍规划（列序 → WHERE-IN 唯一值探测 → 冲突预演）→ 预演 → 两次显式确认 → 单事务写入 | `.kode/clone-runs/` 审计 JSON |
| `kbengine.clone.showAudit` | 查看审计记录 | 读 `.kode/clone-runs/` |

- 上下文菜单：`.kdpclone` 文件右键提供 `inspectArchive` / `import`（见
  `package.json#contributes.menus`）。
- 数据落地：归档默认经保存对话框写 `.kdpclone`；审计写工作区首根
  `.kode/clone-runs/`（`src/extension.ts` clone 装配，`runShowCloneAuditCommand`）。
- 桥接面：Rust RPC `$/kode/dbClone/*` 共 5 个 handler——
  `inspectArchive` / `planExport` / `export` / `planImport` / `readArchiveRows`
  （`crates/kode-server/src/db_clone.rs`）。**无 TS 兜底**：归档/规划操作无 Rust
  后端即如实报错，不假装成功。

### 1.2 导入安全流程（运维须知）

1. 目标环境只认 `local`/`test`；`prod`/`staging`（含大小写变体）在 `TargetEnvironment::from_str`
   即 `ImportRejected`，`prod→prod` 克隆无法成形（`src/target.rs`）。
2. 源会话只读：`validate_readonly` 拒写语句（INSERT/UPDATE/DELETE/DROP/ALTER/REPLACE/
   CREATE/TRUNCATE/GRANT/SET autocommit），放行 SELECT/SHOW/DESCRIBE/EXPLAIN/
   SET SESSION READ ONLY 等（`src/reader.rs`）。
3. 导入需**两次显式确认**（预演 → 二次确认），失败/取消即整事务回滚，绝不留下半个角色
   （`crates/kode-db-clone/src/apply.rs` + `golden_apply.rs` 4 例）。
4. 导入后逐表 COUNT 复核 + 生成**永不执行**的逆拓扑清理计划 + 审计落盘。
5. 每屏重复提示：这是**持久化数据库拷贝**，非运行内存状态（`Persisted Clone`）。

---

## 2. 敏感数据处理

### 2.1 列脱敏（已接线，默认开）

- `SensitivityPolicy::classify(column)` 按关键词分两类（`crates/kode-db-clone/src/redact.rs`）：
  - `credential`：密码/密钥类列（如 `sm_password`、含 `password`/`secret`/`credential` 等）。
  - `personal`：个人敏感列（含 `email`/`phone`/`mobile`/`idcard`/`realname` 等）。
- 导出经 `RedactingSink` 掩码敏感列（`redactSensitive: true` 默认，`writeCloneArchive`
  恒传该旗标）；掩码后行写入归档，报告记录逐列掩码计数。
- 审计/日志经 `redact_log` 掩码，不落敏感原文。
- **密码不入配置文件**：clone profile 账号存 workspaceState，密码只入
  `SecretStorage`（键含角色），UI 明示「只存 SecretStorage，不进配置文件」。

### 2.2 归档加密（**已接线，导出默认加密**）

- **加密机制**：`ArchiveWriter`/`Archive::open` 走 chacha20poly1305 AEAD——
  `FLAG_ENCRYPTED` 位 + 帧头记明文字节长 + 16 字节认证标签 + 头部整体作 AEAD 关联数据。
  **帧名（如 `tables/tbl_Avatar.json`）在帧头明文是格式设计**——头部作 AEAD 关联数据
  （认证不加密），解密前须先按名定位帧；帧名属元数据（类似加密 zip 的文件名），
  **行值/清单内容才是加密载荷**（Rust 测试断言归档字节无明文行值）。
- **接线（导出）**：extension 传 `keyRoot`（`context.globalStorageUri/clone-keys`，
  机器域目录，不落工作区/VCS）→ server 侧 `ensure_key_outside_archive`（结构性拒绝
  密钥目录在归档路径内）+ 密钥 id = 归档绝对路径 SHA-256
  （`keystore::key_id_for_archive`）+ `FileKeyStore::get_or_create`（不存在则生成，
  Unix 强制 0600 落盘）→ `ArchiveWriter` 携钥写档，`encrypted: true`。
  **密钥材料全程留 Rust——TS 只传目录路径，永不接触密钥字节**。
- **加密可关（PDC-0609）**：默认值经设置 `kbengine.clone.archiveEncryption`
  （`encrypted` 默认 / `plain`），导出确认页每次可切换（确认项文案携带当前态，
  完成消息如实标注「已加密/明文」）；`plain` 写**脱敏但未加密**归档——服务跨机
  转移场景（密钥是机器域的，加密归档移机即缺钥）。读面不受设置影响：加密位
  探测定，明文/加密归档都能读。
- **接线（读取）**：`inspectArchive`/`readArchiveRows`/`planImport` 同传 `keyRoot`；
  server 侧先探头部加密位（`archive::is_encrypted`）——未加密档不取钥，加密档按
  同 id 取钥；**钥匙缺失如实报错**（话术点名密钥根与 id），**绝不静默生成新钥**
  （那只会造出永远解不开档的错误钥匙）。
- **边界（如实）**：
  - 密钥 id 绑定归档绝对路径——归档移动/改名后 id 变化，读侧按「密钥缺失」如实
    报错（话术指路：从建档机器拷钥或在该机重导出）。
  - 归档移到另一台机器：钥匙不跟走（在原机 globalStorage）→ 同上如实报错。
  - 旧明文归档（接线前导出）仍可开（头部加密位 false，无需钥），向后兼容。
  - 显式 `keyHex` 参数仍优先于 `keyRoot`（测试/工具面直传钥的旧路径保留）。

---

## 3. 归档留存/销毁策略

- **当前无自动留存策略、无归档删除命令、无密钥销毁 API**：
  - `crates/kode-db-clone/src/archive.rs` 公开面为 `write_archive` / `ArchiveWriter` /
    `Archive::open` / `Archive::inspect` / `relations_from_plan`，**无 delete/destroy/purge**。
  - `crates/kode-db-clone/src/keystore.rs` 公开面为 `FileKeyStore::new` +
    `ensure_key_outside_archive`，**无删除密钥接口**。
  - 命令面无 `deleteArchive`/`purge`（`package.json#contributes.commands` 仅有
    configureSource/configureTarget/testSource/testTarget/inspectArchive/export/import/showAudit）。
- **实际行为**：归档 `.kdpclone` 与密钥文件持久于磁盘，直至操作者/OS 手动清理；
  无自动过期、无容量上限回收、无销毁确认。唯一自动清理是写档失败路径删临时文件
  （`ArchiveWriter::finalize` 出错 `fs::remove_file(&self.tmp)`），即**原子写**：先写临时
  文件成功后再落目标名，失败不留半成品。
- **建议运维口径（非代码强制）**：归档已默认加密（§2.2），但帧名等头部元数据
  明文可见（格式设计，见 §2.2）；操作者仍应将归档视为敏感文件妥善保管，需要时
  手动删除归档文件与密钥目录（globalStorage `clone-keys/`）下对应 `.key` 文件。
  自动化留存/销毁策略（过期回收、密钥托管轮换、销毁确认）**未实现**，列为已知限制。

---

## 4. 已知限制（如实清单）

1. **CLI 二进制未实现**：计划书 §8 的 CLI 契约是「示例，不等于现在存在的命令」；
   当前交付面 = 命令面板入口 + Rust RPC，无独立 CLI 可执行文件。
2. **引擎原生加载验证未接线**：`load_verification.attempted = false`（PDC-0003），
   已接线面是计数复核与审计，非 KBEngine 原生 `load` 验证。
3. **仅持久化拷贝**：克隆的是数据库持久化状态，非运行内存状态；UI 恒标
   `Persisted Clone`，无受控服务器导出最新内存状态的能力。
4. **V1 仅结构精确兼容**：目标引擎版本差异需 Schema migration，属独立能力，V1 不支持。
5. **业务引用需显式声明**：自动处理仅限引擎可确定的父子关系（parentID 树）；业务
   引用（非 parentID 的跨表引用）须显式声明规则，未声明列恒为字面值直通 + 告警。
6. **prod/staging 不可为导入目标**：只认 local/test；线上库克隆需另行受控方案。
7. **目标本地服务应停止**：导入写本地库，要求本地服务停止，拒绝在线热注入。
8. **长事务受控**：行预算、分批读取、短超时；优先只读副本，防压垮生产。
9. **账号/角色身份绑定非全自动**：多数所有权规则为项目自定义，`.def` 不能自动
   了解全部，需显式声明。
10. **Redis ZSET 排行榜不支持**：排行榜是游戏缓存数据（非实体持久化），不属于
    本 MySQL 实体克隆域；支持另立项（独立数据域）。
11. **归档上限 4 GiB**：`MAX_ARCHIVE_SIZE`（`src/archive.rs`），开档/写档均拒超限。
12. **大规模导出耗时**：30 万子行实测约 8.7s（宽松上界断言，防挂死/平方级退化）；
    单行大 blob 支持但受归档上限约束。
13. **扩展宿主门禁当前红于 main**：`pnpm test` 全链的 fake-vscode mocha 套件
    （activationSmoke/manifest/providerSmoke）有 2 例红——`manifest.test` 断言每 command
    必有 `onCommand` 激活事件，`kbengine.python.selectInterpreter` 自 `1a95f5e` 加入即无
    激活事件（venv 域，pre-existing）+ `activationSmoke` 状态栏 3→5（interpreter 栏
    `1a95f5e` + 通道灯 `5347782` hotreload，均非 CLONE-P6 域）。**未**将其加入 per-push
    ci.yml（红则 break 全员推）；per-push 门禁 = ci.yml 的 vitest + cargo test + clippy
    （clippy 自 PDC-0606 `87418f3` 入门禁）。真 `@vscode/test-electron` 宿主
    （需 VS Code 下载 + 显示）为本地 xvfb 门禁，不入 CI。
14. **密钥生命周期无管理面**（见 §2.2/§3）：加密已接线，但密钥 id 绑定归档绝对
    路径——归档移动/改名/换机即「密钥缺失」如实报错（无导钥/导入钥/轮换命令，
    需手动拷 `.key` 文件）；无销毁 API，删除即手动清 `clone-keys/`。

---

## 5. 对账说明

- 本文档为 PDC-0607 交付面；`docs/player-clone/source-evidence.md`（Phase 0 取证）与
  `docs/design/v0.2.1-player-data-clone-plan.md`（设计口径）为并列文档，本文只补
  运维/安全/留存/限制的**现状**，不重复推导细节。
- 未实现能力（CLI、引擎加载验证、自动留存/销毁、密钥轮换）均如实标注「未实现/未接线」，
  不写成已生效；归档加密自 PDC-0608 起已接线（§2.2）。
