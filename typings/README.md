# kode KBEngine stub typings

KBEngine Python 桩包静态模板(批 ③,2026-11-11)/ static template for the
`KBEngine` Python stub package.

- 源 / source: `cuihairu/kbengine` fork `typings/`,钉点 commit / pinned commit **28d2117**。
- 派生 / derived by `scripts/derive-kbengine-stub-typings.mjs` —— 改内容重跑,勿手工合并 /
  regenerate, do not hand-merge:
  `node scripts/derive-kbengine-stub-typings.mjs --typings <fork>/typings --out typings --pin 28d2117`
- 运行期 / runtime:激活时复制到 `<managedDir>/stubs/`,**copy-if-absent** ——
  kode 永不覆盖项目副本,项目内的修改/魔改永久保留 / kode never overwrites
  project copies; edits in the project survive.
- `KBEngine/` 是桩包:`__init__.pyi` 的 re-export 顺序裁决同名遮蔽(文件内有
  说明),类一类一文件,项目内修改局部可审 / `__init__.pyi` re-export order
  decides same-name shadowing (documented in the file); one class per file.
- kode 独有内容 / kode-only content:`KBEngine/_vectors.pyi`(运行时向量类)、
  `Entity.pyi` 的 `cellData` overlay(baseapp/entity.cpp:238)、`Proxy.pyi`
  的内部属性标注(entitydef/common.h:142-143 + baseapp.cpp:4241-4246)。
- `_KBEngine_*.pyi` 命名勿改:与 fork 布局 1:1(仅 `_KBEngine_hooks` 折入
  `KBEngine/hooks.pyi`,按引擎 sdk_templates 形态)/ names mirror the fork
  layout 1:1 (only `_KBEngine_hooks` folded into `KBEngine/hooks.pyi`).
- 边界 / boundaries:per-script 旁路 .pyi(kbemain.pyi/Account.pyi 同目录影子)
  是引擎仓 pyrightconfig 机制,kode 不往用户 scripts/ 写文件,回调签名已由
  `KBEngine/hooks.pyi` 承载;实体 def 驱动的逐实体桩走 kode 既有
  kbe_types/entity_types 导出面,不在本模板 / per-script shadow .pyi files are
  an engine-repo pyrightconfig mechanism (kode writes nothing into user
  scripts/); entity-def-driven per-entity stubs ride kode's existing
  kbe_types/entity_types exporters.
