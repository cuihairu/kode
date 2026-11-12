# kode KBEngine process typings

源 / source: `cuihairu/kbengine` fork, pinned commit **28d2117**.

Regenerate / 再生成（需要 Node.js、Python 3.9+；运行扩展不需要生成工具）:

`node scripts/derive-kbengine-stub-typings.mjs --typings ../kbengine/typings --out typings --pin 28d2117`

`scripts/lib/process-stubs.py` applies source-grounded corrections after the
pinned declarations are split. Commit both .pyi files and `process-api.json`;
TS and Rust embed that same process catalog. 不手工修改生成文件。

| 脚本目录 / script directory | 桩根 / stub root | 引擎组件 / component |
| --- | --- | --- |
| scripts/base | base | baseapp |
| scripts/cell | cell | cellapp |
| scripts/bots | bots | bots |
| scripts/client | client | client |
| scripts/dbmgr | dbmgr | dbmgr |
| scripts/interfaces | interfaces | interfaces |
| scripts/logger | logger | logger |
| scripts/loginapp | loginapp | loginapp |

Each process contains `KBEngine/__init__.pyi`, one class per file, and its own
module functions, constants, and hooks. baseapp/cellapp script-directory aliases
map explicitly to base/cell. 公共类型集中在 `shared/_kbengine_shared/`，
各进程直接引用同一份向量、容器、MemoryStream 和远程句柄声明；
`shared/KBEngine/__init__.pyi` 为公共脚本只导出向量与 FixedArray。

Activation copies templates into `<managedDir>/stubs/` with **copy-if-absent**:
existing project edits are preserved. New process directories work alongside old
copies. `pyrightconfig.json` executionEnvironments select the process path for
each scripts directory; the global stubPath is `stubs/_shared` so an old mixed
KBEngine package cannot override process selection. Do not place a mixed
KBEngine package in `_shared` or a custom global stubPath.

Per-process .def-derived `entity_types.pyi` lives beside the selected process
package, never beside or over a user's Avatar.py. User-owned JSONC entries and
stub files are preserved; explicit reset remains the route to replacing edited
templates. 现有 TOML/extends/冲突执行环境无法安全自动合并时，会保留配置并明确提示。
