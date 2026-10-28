# 扩展迁移（旧 Kode ID）

本页记录扩展 ID 的历史与从旧 Kode ID 迁到当前 ID 的确切步骤（保留用户设置），避免改名后残留旧副本共存。

## 登记在案的 ID

| 角色 | 扩展 ID | 依据 |
| --- | --- | --- |
| 旧 ID | `cuihairu.kode` | 初始提交 `dc75f33`（`"name": "kode"`，publisher `cuihairu`） |
| 当前 ID | `cuihairu.kode-kbengine` | 改名提交 `5421b4c`（"rename extension id to kode-kbengine"） |

仓库历史中还有一段 publisher 为 `hairucui`、name 为 `kode-kbengine` 的时段（ID `hairucui.kode-kbengine`），从未发布，仅在此记录以便追溯。自动共激活检测（见下）只盯 `cuihairu.*` 名下含 `kode` 的 ID，`cuihairu.kode` 在检测范围内；`hairucui.kode-kbengine` 不在自动检测网内，若真装了需要手动清理。

## 迁移后自动保留的部分

- `settings.json` 里全部 `kbengine.*` 配置键——配置键来自扩展贡献的配置段（`kbengine.*`），与扩展 ID 无关，新 ID 装好后原样生效。
- 工作区里落盘的东西（`.kbengine/debug.json`、`tasks.json` 条目、生成的 SDK 产物）——文件不绑定扩展 ID。

## 不随 ID 迁移的部分（与补做动作）

扩展私存（`workspaceState` memento）绑定扩展实例，ID 变更后旧 memento 不迁移。kode 目前用到这些键：

| 存储键 | 内容 | 补做动作 |
| --- | --- | --- |
| `kbengine.projectProfiles.v1` | profile 清单（资产/引擎根组合） | 重建 profiles（Profiles 视图或导入命令） |
| `kbengine.activeProfileId.v1` | 活动 profile 选择 | 重新选择活动 profile |
| `kbengine.testTaskContext` | 上次捕获的测试任务上下文 | 下次测试发现时自动重捕 |
| `kbengine.defCallChain.activeTab` | 调用链面板页签 | 重新选页签 |
| `kbengine.discovery.<root>` | 按根的 discovery 选择 | 需要时重跑 discovery |

补做动作都是一次性选择；扩展之外的任何数据都不受影响。

## 迁移步骤

1. 安装当前 ID `cuihairu.kode-kbengine`。
2. 在扩展视图禁用（或卸载）旧 ID `cuihairu.kode`。若两者实际同时激活，kode 会在窗口激活时警告一次「检测到两个 Kode 扩展同时激活…」；只安装未激活或已被禁用的同族不会触发警告。
3. 重载窗口。
4. 用 **Extension Identity** 命令（`kbengine.extension.identity`）核验——报告逐条列出匹配安装的 `installed=`/`active=` 两个正交事实；迁移后应只有 `cuihairu.kode-kbengine` 为 `active=yes`。
5. 重建 profiles 并重选活动 profile（见上表）；`kbengine.*` 设置此时已自然生效。
