// KBEngine stub typings derivation (批 ③,用户令 2026-11-11):
// cuihairu/kbengine typings(钉点 commit)-> kode 顶层 typings/ 模板。
// Static template derivation: fork typings -> kode top-level typings/.
//
// Shape (user ratified / 形态,用户已定):
//   typings/KBEngine/__init__.pyi   显式 re-export 顺序(类文件最后,服务端
//                                   Entity/Proxy 压同名 bots 层模型)
//   typings/KBEngine/<Class>.pyi    一类一文件(用户提案;真正的编辑面——
//                                   项目副本可改,kode 永不覆盖)
//   typings/KBEngine/hooks.pyi      回调协议(fork _KBEngine_hooks 折入)
//   typings/KBEngine/_vectors.pyi   kode 独有运行时 Vector2/3/4
//   typings/KBEngine/_KBEngine_*.pyi 进程层函数/常量,import 改写为包内相对
//
// Run: node scripts/derive-kbengine-stub-typings.mjs --typings ../kbengine/typings --out typings [--pin 28d2117]
// 产物入库;fork typings 演进后重跑 / emitted files are committed; rerun after
// the fork typings evolve.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

// ---- CLI -----------------------------------------------------------------

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const typingsDir = resolve(argValue('typings') ?? join('..', 'kbengine', 'typings'));
const outDir = resolve(argValue('out') ?? 'typings');
const pin = argValue('pin');
const packageDir = join(outDir, 'KBEngine');

if (!existsSync(join(typingsDir, '_KBEngine_common.pyi'))) {
  console.error(`[derive] no _KBEngine_common.pyi under ${typingsDir}`);
  process.exit(1);
}
// 钉点=最后一笔动过 typings/ 的提交(不是仓库 HEAD;仓库 HEAD 会随无关提交漂移)
// pin = last commit touching typings/, not the repo HEAD.
const typingsHead = (dir) =>
  execSync('git log -1 --format=%h -- .', { cwd: dir, encoding: 'utf8' }).trim();

if (pin) {
  const head = typingsHead(typingsDir);
  if (head !== pin) {
    console.error(`[derive] typings HEAD ${head} != pinned ${pin}; pass the current pin explicitly to override`);
    process.exit(1);
  }
}

const readTypings = (name) =>
  readFileSync(join(typingsDir, name), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');

// ---- class inventory (asserted: unknown structure must fail loudly) -------

const COMMON_CLASS_NAMES = [
  'EntityCall',
  'EntityComponentCall',
  'MemoryStream',
  'GlobalDataClient',
  'Entity',
  'Proxy',
  'Space',
  'EntityComponent',
  'Entities'
];

// ---- split _KBEngine_common.pyi -------------------------------------------
// Indentation scan: a class block starts at `class X...` with indent 0 and
// runs until the next indent-0 non-blank line (comments attached to a class —
// contiguous `#` lines directly above it — travel with the class).

const splitClassesFromModule = (content, expectedClassNames) => {
  const lines = content.split('\n');
  const classes = new Map();
  const remainder = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const match = /^class ([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (!match) {
      remainder.push(line);
      index += 1;
      continue;
    }
    // Pull in the contiguous comment block directly above (already pushed to
    // remainder): trailing `#` lines with no blank line between them and the
    // class header belong to the class.
    const attached = [];
    while (
      remainder.length > 0 &&
      /^(\s*#)/.test(remainder[remainder.length - 1])
    ) {
      attached.unshift(remainder.pop());
    }
    const body = [line];
    index += 1;
    while (index < lines.length) {
      const inner = lines[index];
      if (inner.trim() !== '' && /^(\S)/.test(inner)) {
        break;
      }
      body.push(inner);
      index += 1;
    }
    classes.set(match[1], { attached, body });
  }
  const found = [...classes.keys()];
  const missing = expectedClassNames.filter(name => !found.includes(name));
  const extra = found.filter(name => !expectedClassNames.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    console.error(`[derive] class inventory drift: missing=${missing} extra=${extra}`);
    process.exit(1);
  }
  // Trim trailing blank lines from each body (emitter adds its own spacing).
  for (const entry of classes.values()) {
    while (entry.body.length > 0 && entry.body[entry.body.length - 1].trim() === '') {
      entry.body.pop();
    }
  }
  return { classes, remainderLines: remainder };
};

const commonContent = readTypings('_KBEngine_common.pyi');
const { classes, remainderLines } = splitClassesFromModule(commonContent, COMMON_CLASS_NAMES);

// ---- import rewriting ------------------------------------------------------
// `from _KBEngine_X import ...` -> package-relative. Class names moved into
// per-class files must come from `.X import X`; the rest stays on
// `._KBEngine_common`.

const rewriteCommonImports = (content) => content.replace(
  /^from _KBEngine_common import ((?:\([^)]*\))|(?:[A-Za-z_][A-Za-z0-9_,\s]*))$/gm,
  (whole, payload) => {
    const names = payload
      .replace(/[()]/g, '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean);
    const classHits = names.filter(name => COMMON_CLASS_NAMES.includes(name));
    const aliasHits = names.filter(name => !COMMON_CLASS_NAMES.includes(name));
    const out = [];
    if (aliasHits.length > 0) {
      out.push(`from ._KBEngine_common import ${aliasHits.join(', ')}`);
    }
    for (const name of classHits) {
      out.push(`from .${name} import ${name}`);
    }
    return out.join('\n');
  }
).replace(/^from _KBEngine_([_A-Za-z]+) import \*$/gm, 'from ._KBEngine_$1 import *');

// ---- per-class files --------------------------------------------------------

const classFileHeader = (className) => [
  `# ${className} — one class per file (用户令 2026-11-11 / user directive: static`,
  `# template, one class per file, project copies are user-editable).`,
  `# 拆分自 _KBEngine_common.pyi(cuihairu/kbengine typings,钉点 commit 见`,
  `# typings/README.md),由 scripts/derive-kbengine-stub-typings.mjs 生成;`,
  `# 改内容请重跑派生脚本,勿手工合并 / split by the derive script — regenerate`,
  `# there, do not hand-merge.`,
  `# 共享头部是有意的:逐类裁剪易漂移,桩内多余 import 无副作用(注解经`,
  `# __future__ 惰性求值)/ generous shared header on purpose: per-class pruning`,
  `# invites drift, unused stub imports are inert.`,
  'from __future__ import annotations',
  '',
  'from typing import (',
  '    Any,',
  '    BinaryIO,',
  '    Callable,',
  '    Dict,',
  '    IO,',
  '    List,',
  '    Literal,',
  '    Sequence,',
  '    TextIO,',
  '    Tuple,',
  '    Union,',
  '    overload,',
  ')',
  '',
  'from ._KBEngine_common import Address, Callback, Vector3Like, WatcherValue',
  ...COMMON_CLASS_NAMES
    .filter(name => name !== className)
    .map(name => `from .${name} import ${name}`)
];

const emitClassFile = (className) => {
  const entry = classes.get(className);
  const body = [...entry.attached, ...entry.body];
  // kode overlays (source-evidenced, script-injected so reruns keep them):
  // cellData — baseapp runtime attr (baseapp/entity.cpp:238), only on entities
  // whose def has a cell part; typing face for `self.cellData["x"]`.
  if (className === 'Entity') {
    const head = body.findIndex(line => /^class Entity:/.test(line));
    if (head >= 0) {
      body.splice(head + 1, 0,
        '    # kode overlay: baseapp 运行时属性(baseapp/entity.cpp:238);仅在 def 带',
        '    # cell 部分的 baseapp 实体上安装,cellapp/client 实体不携带(cell 侧属性',
        '    # 就是普通属性)/ baseapp-side runtime attribute, installed only on',
        '    # baseapp entities whose def has a cell part.',
        '    cellData: Dict[str, Any]'
      );
    }
  }
  // 内部属性 markers (user directive 2026-11-11): Proxy injected account attrs.
  if (className === 'Proxy') {
    const head = body.findIndex(line => /^class Proxy\(/.test(line));
    if (head >= 0) {
      body.splice(head + 1, 0,
        '    # 内部属性:baseapp 登录成功后注入,脚本只读,勿赋值 / internal attributes',
        '    # injected by baseapp on login; read-only from scripts, do not assign.',
        '    # (名字表 name list: entitydef/common.h:142-143;注入点 injection:',
        '    # server/baseapp/baseapp.cpp:4241-4246)'
      );
    }
  }
  return [...classFileHeader(className), '', ...body, ''].join('\n');
};

// ---- package remainder (_KBEngine_common.pyi without classes) ---------------

const emitCommonRemainder = () => [
  '# KBEngine 公共层 — 函数/常量/类型别名 / common layer: functions, constants,',
  '# type aliases. 类已拆到 KBEngine/ 逐类文件 / classes moved to per-class files',
  '# under KBEngine/。',
  '# 由 scripts/derive-kbengine-stub-typings.mjs 生成,改内容请重跑,勿手工合并 /',
  '# derived by scripts/derive-kbengine-stub-typings.mjs; regenerate there, do not',
  '# hand-merge. Source: cuihairu/kbengine typings (pinned commit in README.md).',
  '',
  rewriteCommonImports(remainderLines.join('\n')).replace(/\n{3,}/g, '\n\n\n')
];

// ---- process-layer files ----------------------------------------------------

const LAYER_FILES = [
  '_KBEngine_baseapp.pyi',
  '_KBEngine_cellapp.pyi',
  '_KBEngine_bots.pyi',
  '_KBEngine_dbmgr.pyi',
  '_KBEngine_interfaces.pyi',
  '_KBEngine_logger.pyi',
  '_KBEngine_loginapp.pyi',
  '_KBEngine_pythonapp.pyi',
  '_KBEngine_server_errors.pyi'
];

const emitLayerFile = (name) => [
  `# ${name} — 进程层函数/常量面 / process-layer functions and constants.`,
  `# 源:cuihairu/kbengine typings(钉点 commit 见 typings/README.md),经`,
  `# scripts/derive-kbengine-stub-typings.mjs 生成;改内容请重跑,勿手工合并 /`,
  `# derived via the derive script; regenerate there, do not hand-merge.`,
  '',
  rewriteCommonImports(readTypings(name))
];

// ---- hooks (fork _KBEngine_hooks.pyi -> KBEngine/hooks.pyi) -----------------

const emitHooks = () => [
  '# KBEngine/hooks.pyi — 引擎回调协议 / engine callback Protocols.',
  '# 形态取自引擎 sdk_templates 的 KBEngine/hooks.pyi 壳;内容来自 fork 的',
  '# _KBEngine_hooks.pyi(钉点 commit 见 typings/README.md),经派生脚本生成,',
  '# 改内容请重跑 / sdk_templates KBEngine/hooks.pyi shape, content from the',
  '# fork _KBEngine_hooks.pyi via the derive script; regenerate, do not hand-merge.',
  '',
  rewriteCommonImports(readTypings('_KBEngine_hooks.pyi'))
];

// ---- vectors (kode-only; source of truth src/kbeModuleIndex.ts) --------------

// Kept as a literal here because the TS emitter lives in compiled src/; the
// signature set must stay aligned with emitKbeVectorStubClasses (kbeModuleIndex).
const VECTOR_CLASSES = `# kode 独有:运行时向量类型(pyscript/vector2.h、vector3.h、vector4.h)。
# kode-only runtime vector types — 引擎 typings 未覆盖的运行时类,缺了会让
# 项目脚本里的 Vector2(...)/Vector3(...) 被 Pylance 判未定义。
# 真源 source of truth: src/kbeModuleIndex.ts emitKbeVectorStubClasses — keep in step.
class Vector2:
    x: float
    y: float
    length: float
    lengthSquared: float
    def __init__(self, x: float, y: float) -> None: ...
    def distTo(self, other: Vector2) -> float: ...
    def distSqrTo(self, other: Vector2) -> float: ...
    def cross2D(self, other: Vector2) -> float: ...
    def scale(self, factor: float) -> Vector2: ...
    def dot(self, other: Vector2) -> float: ...
    def normalise(self) -> None: ...
    def tuple(self) -> Tuple[float, float]: ...
    def list(self) -> List[float]: ...
    def set(self, *args: float) -> None: ...
    def __len__(self) -> int: ...
    def __getitem__(self, index: int) -> float: ...
    def __setitem__(self, index: int, value: float) -> None: ...
    def __add__(self, other: Vector2) -> Vector2: ...
    def __sub__(self, other: Vector2) -> Vector2: ...
    def __mul__(self, factor: float) -> Vector2: ...
    def __rmul__(self, factor: float) -> Vector2: ...
    def __truediv__(self, factor: float) -> Vector2: ...
    def __neg__(self) -> Vector2: ...
    def __pos__(self) -> Vector2: ...
    def __bool__(self) -> bool: ...
    def __iadd__(self, other: Vector2) -> Vector2: ...
    def __isub__(self, other: Vector2) -> Vector2: ...
    def __imul__(self, other: Vector2) -> Vector2: ...
    def __itruediv__(self, factor: float) -> Vector2: ...

class Vector3:
    x: float
    y: float
    z: float
    length: float
    lengthSquared: float
    def __init__(self, x: float, y: float, z: float) -> None: ...
    def flatDistTo(self, other: Vector3) -> float: ...
    def flatDistSqrTo(self, other: Vector3) -> float: ...
    def distTo(self, other: Vector3) -> float: ...
    def distSqrTo(self, other: Vector3) -> float: ...
    def cross2D(self, other: Vector3) -> float: ...
    def scale(self, factor: float) -> Vector3: ...
    def dot(self, other: Vector3) -> float: ...
    def normalise(self) -> None: ...
    def tuple(self) -> Tuple[float, float, float]: ...
    def list(self) -> List[float]: ...
    def set(self, *args: float) -> None: ...
    def __len__(self) -> int: ...
    def __getitem__(self, index: int) -> float: ...
    def __setitem__(self, index: int, value: float) -> None: ...
    def __add__(self, other: Vector3) -> Vector3: ...
    def __sub__(self, other: Vector3) -> Vector3: ...
    def __mul__(self, factor: float) -> Vector3: ...
    def __rmul__(self, factor: float) -> Vector3: ...
    def __truediv__(self, factor: float) -> Vector3: ...
    def __neg__(self) -> Vector3: ...
    def __pos__(self) -> Vector3: ...
    def __bool__(self) -> bool: ...
    def __iadd__(self, other: Vector3) -> Vector3: ...
    def __isub__(self, other: Vector3) -> Vector3: ...
    def __imul__(self, other: Vector3) -> Vector3: ...
    def __itruediv__(self, factor: float) -> Vector3: ...

class Vector4:
    x: float
    y: float
    z: float
    w: float
    length: float
    lengthSquared: float
    def __init__(self, x: float, y: float, z: float, w: float) -> None: ...
    def distTo(self, other: Vector4) -> float: ...
    def distSqrTo(self, other: Vector4) -> float: ...
    def scale(self, factor: float) -> Vector4: ...
    def dot(self, other: Vector4) -> float: ...
    def normalise(self) -> None: ...
    def tuple(self) -> Tuple[float, float, float, float]: ...
    def list(self) -> List[float]: ...
    def set(self, *args: float) -> None: ...
    def __len__(self) -> int: ...
    def __getitem__(self, index: int) -> float: ...
    def __setitem__(self, index: int, value: float) -> None: ...
    def __add__(self, other: Vector4) -> Vector4: ...
    def __sub__(self, other: Vector4) -> Vector4: ...
    def __mul__(self, factor: float) -> Vector4: ...
    def __rmul__(self, factor: float) -> Vector4: ...
    def __truediv__(self, factor: float) -> Vector4: ...
    def __neg__(self) -> Vector4: ...
    def __pos__(self) -> Vector4: ...
    def __bool__(self) -> bool: ...
    def __iadd__(self, other: Vector4) -> Vector4: ...
    def __isub__(self, other: Vector4) -> Vector4: ...
    def __imul__(self, other: Vector4) -> Vector4: ...
    def __itruediv__(self, factor: float) -> Vector4: ...
`;

// ---- __init__.pyi -------------------------------------------------------------

// Re-export order is the shadowing contract (classes last -> server Entity/Proxy
// win over bots-layer same-name models). Module-level __getattr__ is declared
// here because star-import never re-exports underscore names — without it the
// engine's dynamic-attr fallback (`KBEngine.<anything>`) would go unresolved.
const emitInit = () => [
  '# kode KBEngine 桩包(用户令 2026-11-11:静态模板、一类一文件、copy-if-absent)',
  '# kode KBEngine stub package (static template, one class per file,',
  '# copy-if-absent — project copies are user-editable).',
  '# 派生自 cuihairu/kbengine typings(钉点 commit 见 typings/README.md),由',
  '# scripts/derive-kbengine-stub-typings.mjs 生成;改内容请重跑,勿手工合并 /',
  '# derived by the derive script; regenerate there, do not hand-merge.',
  '#',
  '# 下面 re-export 顺序是有意设计,可改 / re-export order is intentional and editable:',
  '#   1. 进程层:server_errors -> pythonapp -> baseapp/cellapp/dbmgr/',
  '#      interfaces/logger/loginapp -> bots(后层压前层同名),',
  '#   2. 公共超集随后 / the common superset after them,',
  '#   3. 类文件最后 re-export:服务端 Entity/Proxy 模型压过 bots 层同名客户端',
  '#      模型(bots 的 Entity 仍在 _KBEngine_bots 上,此处有意遮蔽)/ per-class',
  '#      files LAST so the server Entity/Proxy models win over the bots-layer',
  '#      client models of the same names.',
  '# 项目需要另一套模型时,改下面顺序即可翻转遮蔽 / edit the order to flip shadowing.',
  'from ._KBEngine_server_errors import *',
  'from ._KBEngine_pythonapp import *',
  'from ._KBEngine_baseapp import *',
  'from ._KBEngine_cellapp import *',
  'from ._KBEngine_dbmgr import *',
  'from ._KBEngine_interfaces import *',
  'from ._KBEngine_logger import *',
  'from ._KBEngine_loginapp import *',
  'from ._KBEngine_bots import *',
  'from ._KBEngine_common import *',
  'from ._vectors import Vector2, Vector3, Vector4',
  'from .Entity import Entity',
  'from .Proxy import Proxy',
  'from .Space import Space',
  'from .EntityCall import EntityCall',
  'from .EntityComponentCall import EntityComponentCall',
  'from .EntityComponent import EntityComponent',
  'from .MemoryStream import MemoryStream',
  'from .GlobalDataClient import GlobalDataClient',
  'from .Entities import Entities',
  '',
  'from typing import Any',
  '',
  '',
  'def __getattr__(name: str) -> Any:',
  '    ...'
];

// ---- README (kode-authored provenance) -----------------------------------------

const emitReadme = (head) => `# kode KBEngine stub typings

KBEngine Python 桩包静态模板(批 ③,2026-11-11)/ static template for the
\`KBEngine\` Python stub package.

- 源 / source: \`cuihairu/kbengine\` fork \`typings/\`,钉点 commit / pinned commit **${head}**。
- 派生 / derived by \`scripts/derive-kbengine-stub-typings.mjs\` —— 改内容重跑,勿手工合并 /
  regenerate, do not hand-merge:
  \`node scripts/derive-kbengine-stub-typings.mjs --typings <fork>/typings --out typings --pin ${head}\`
- 运行期 / runtime:激活时复制到 \`<managedDir>/stubs/\`,**copy-if-absent** ——
  kode 永不覆盖项目副本,项目内的修改/魔改永久保留 / kode never overwrites
  project copies; edits in the project survive.
- \`KBEngine/\` 是桩包:\`__init__.pyi\` 的 re-export 顺序裁决同名遮蔽(文件内有
  说明),类一类一文件,项目内修改局部可审 / \`__init__.pyi\` re-export order
  decides same-name shadowing (documented in the file); one class per file.
- kode 独有内容 / kode-only content:\`KBEngine/_vectors.pyi\`(运行时向量类)、
  \`Entity.pyi\` 的 \`cellData\` overlay(baseapp/entity.cpp:238)、\`Proxy.pyi\`
  的内部属性标注(entitydef/common.h:142-143 + baseapp.cpp:4241-4246)。
- \`_KBEngine_*.pyi\` 命名勿改:与 fork 布局 1:1(仅 \`_KBEngine_hooks\` 折入
  \`KBEngine/hooks.pyi\`,按引擎 sdk_templates 形态)/ names mirror the fork
  layout 1:1 (only \`_KBEngine_hooks\` folded into \`KBEngine/hooks.pyi\`).
- 边界 / boundaries:per-script 旁路 .pyi(kbemain.pyi/Account.pyi 同目录影子)
  是引擎仓 pyrightconfig 机制,kode 不往用户 scripts/ 写文件,回调签名已由
  \`KBEngine/hooks.pyi\` 承载;实体 def 驱动的逐实体桩走 kode 既有
  kbe_types/entity_types 导出面,不在本模板 / per-script shadow .pyi files are
  an engine-repo pyrightconfig mechanism (kode writes nothing into user
  scripts/); entity-def-driven per-entity stubs ride kode's existing
  kbe_types/entity_types exporters.
`;

// ---- write ---------------------------------------------------------------------

const head = typingsHead(typingsDir);

mkdirSync(packageDir, { recursive: true });
const outputs = new Map();
outputs.set(join(packageDir, '__init__.pyi'), emitInit().join('\n') + '\n');
outputs.set(join(packageDir, 'hooks.pyi'), emitHooks().join('\n') + '\n');
for (const className of COMMON_CLASS_NAMES) {
  outputs.set(join(packageDir, `${className}.pyi`), emitClassFile(className));
}
outputs.set(join(packageDir, '_vectors.pyi'), VECTOR_CLASSES);
outputs.set(join(packageDir, '_KBEngine_common.pyi'), emitCommonRemainder().join('\n') + '\n');
for (const name of LAYER_FILES) {
  outputs.set(join(packageDir, name), emitLayerFile(name).join('\n') + '\n');
}
outputs.set(join(outDir, 'README.md'), emitReadme(head));

for (const [filePath, content] of outputs) {
  writeFileSync(filePath, content, 'utf8');
}
console.log(`[derive] wrote ${outputs.size} files -> ${outDir} (fork HEAD ${head})`);
