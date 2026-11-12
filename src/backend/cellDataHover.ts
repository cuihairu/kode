/**
 * cellData 生命周期 hover 注记(KSEM-CELL-14):hover `self.cellData` 时挂
 * 「Cell 字段来源 / 快照含义 / 当前可证明状态」双语段。
 *
 * 引擎依据(与 CELL-11/12/13 同一批源码事实,baseapp/entity.cpp @3082ab5):
 * - base 侧 cellData = 内部快照 dict `cellDataDict_`(entity.h:276):onGetCell
 *   先 destroyCellData() 删属性(:1024)再调脚本回调(:1030),dict 内部保留供
 *   备份/落库(:562-563 注释);onWriteToDB(cellData) 的参数即此快照(:1401-1403,
 *   无 cell 面脚本为 None)。
 * - cell 侧(cellapp)引擎**不安装** cellData 属性:createNamespace 宏对缺属性
 *   走组件路径(entity_macro.h:408-412),cell 属性是活实例属性。
 * - 可证明状态只覆盖 onGetCell 窗口(两态流,与 CELL-12 同一推进器);窗口外
 *   调用时机不可证,不做确定结论。
 *
 * 纯逻辑:无 vscode/无 RPC——键宇宙由装配面取好后传入(keys=null=不可用,
 * 降级只给生命周期语义,不造键)。渲染口径与 behaviorNoteMarkdown 同形
 * (双语,挂既有 hover 尾部,`---` 分隔)。
 */
import { AttrState } from './cellDataCallbackCheck';

/** hover 注记的键条目(与 Rust cellDataKeys 条目同形)。 */
export interface CellDataHoverKey {
  key: string;
  kind: 'defField' | 'builtin' | 'componentSlot';
  typeLabel?: string | null;
  sourceFile?: string | null;
  sourceLine?: number | null;
}

/** hover 注记输入(装配面收集;纯数据)。 */
export interface CellDataHoverInputs {
  role: 'base' | 'cell';
  entity: string;
  /** 键宇宙;null=Rust 不可用/实体缺(降级:不造键,不给来源段)。 */
  keys: CellDataHoverKey[] | null;
  /** 位置是否在 onGetCell 方法体内。 */
  inWindow: boolean;
  /** 窗口内该行首个访问将见到的属性态;窗口外 null。 */
  state: AttrState | null;
}

/** 来源段键展示上限(超出折叠为计数,防 hover 无界)。 */
const KEY_LIST_MAX = 12;

/** 知识页(发布站真实路径;.vitepress 导航已登记)。 */
const LINK_LIFECYCLE =
  'https://cuihairu.github.io/kode/zh/knowledge/entity-lifecycle-reference';
const LINK_LIFECYCLE_EN =
  'https://cuihairu.github.io/kode/knowledge/entity-lifecycle-reference';
const LINK_WRITETODB =
  'https://cuihairu.github.io/kode/zh/knowledge/api-baseapp-entity';
const LINK_WRITETODB_EN =
  'https://cuihairu.github.io/kode/knowledge/api-baseapp-entity';

function keyLine(key: CellDataHoverKey): string {
  const parts: string[] = [`\`${key.key}\``];
  if (key.typeLabel) {
    parts.push(key.typeLabel);
  }
  if (key.sourceFile) {
    // Rust sourceLine 已是 1 基人读行号(kode-parser LineMap::line_of `lo+1`),
    // 与补全 detail/CELL-08 定位串同口径,原样展示。
    const line = key.sourceLine != null ? `:${key.sourceLine}` : '';
    parts.push(`${key.sourceFile}${line}`);
  }
  return parts.join(' · ');
}

/** 来源段(zh+en;keys=null 时不产段,keys=[] 时如实说「声明集为空」)。 */
function sourceSection(keys: CellDataHoverKey[] | null): string {
  if (keys === null) {
    return '\n\n来源/Source: 键宇宙不可用(Rust 不可用或实体缺声明),不造键。'
      + '\n\nKey universe unavailable (Rust down or entity undeclared); no keys invented.';
  }
  if (keys.length === 0) {
    return '\n\n来源/Source: 该实体无 cell 属性声明(声明集为空)。'
      + '\n\nNo cell properties declared for this entity.';
  }
  const shown = keys.slice(0, KEY_LIST_MAX).map(keyLine);
  const overflow = keys.length > KEY_LIST_MAX
    ? `\n- …共 ${keys.length} 键(只列前 ${KEY_LIST_MAX})`
      + `\n- …${keys.length} keys total (first ${KEY_LIST_MAX} shown)`
    : '';
  return `\n\n来源/Source: ${keys.length} 键(实体 def 声明宇宙)`
    + `\n\n${keys.length} keys from the entity's def universe`
    + `\n${shown.map(line => `- ${line}`).join('\n')}${overflow}`;
}

/** 快照含义段(role 分支;引擎引文直接给行号)。 */
function snapshotSection(role: 'base' | 'cell'): string {
  if (role === 'base') {
    return '\n\n快照含义: base 侧 `self.cellData` 是引擎内部快照 dict'
      + '(`cellDataDict_`,entity.h:276)——cellapp 上的活值经备份回写落进来'
      + '(isDirty 才更新,entity.cpp:1108-1123),不是实时数据;引擎在 onGetCell'
      + ' 回调前删除该属性(:1024),内部 dict 保留供备份/落库(:562-563);'
      + '`onWriteToDB(cellData)` 的参数即此快照(脚本模块无 cell 面时为 None)。'
      + '\n\nSnapshot semantics: on the base side `self.cellData` is the engine\'s'
      + ' internal snapshot dict (`cellDataDict_`, entity.h:276) fed by backup'
      + ' writes (isDirty only, entity.cpp:1108-1123) — not live data; the engine'
      + ' deletes the attribute before the onGetCell callback (:1024) while the'
      + ' dict is kept internally (:562-563); `onWriteToDB(cellData)` receives'
      + ' exactly this snapshot (None when the script has no cell face).';
  }
  return '\n\n引擎安装面: cellapp **不安装** cellData 属性(createNamespace 宏'
    + '对缺属性走组件路径,entity_macro.h:408-412)——cell 属性是活实例属性'
    + '(`self.hp` 即属性本体)。在 cellapp 脚本里访问 `self.cellData` 运行时'
    + '为 AttributeError,除非实体类自定义;本仓库 CELL-04..10 诊断族按 def '
    + '声明键宇宙照常分析该写点,属静态面,与引擎安装面分层如实呈现。'
    + '\n\nEngine install face: cellapp never installs a cellData attribute'
    + ' (the createNamespace macro takes the component path when absent,'
    + ' entity_macro.h:408-412) — cell properties are live instance attributes.'
    + ' Reading `self.cellData` on a cellapp raises AttributeError at runtime'
    + ' unless the entity class defines it; the CELL-04..10 diagnostic family'
    + ' still analyzes such writes statically against the def key universe —'
    + ' presented as-is, static face and engine install face kept separate.';
}

/** 当前可证明状态段(onGetCell 两态流;窗口外不证)。 */
function provenSection(inWindow: boolean, state: AttrState | null, role: 'base' | 'cell'): string {
  if (role !== 'base') {
    return '\n\n当前可证明状态: cell 侧不适用(可证明窗口只建在 base 侧 '
      + 'onGetCell 上)。'
      + '\n\nProvable state: not applicable on the cell side (the provable'
      + ' window exists only on the base-side onGetCell).';
  }
  if (!inWindow) {
    return '\n\n当前可证明状态: 光标不在 onGetCell 方法体内——onGetCell 之外'
      + '的调用时机与属性在场性的关系不可证,不做确定结论。'
      + '\n\nProvable state: the cursor is outside onGetCell — callback timing'
      + ' elsewhere is not provable, no definite claim is made.';
  }
  if (state === 'absent') {
    return '\n\n当前可证明状态: ⚠ 引擎已删(onGetCell 触发时属性必已删,'
      + 'entity.cpp:1024 在回调 :1030 之前)——此刻读取必抛 AttributeError;'
      + '本方法体内普通赋值可重建(重建后可读)。'
      + '\n\nProvable state: ⚠ deleted (always gone when onGetCell fires,'
      + ' entity.cpp:1024 before the callback :1030) — reading here raises'
      + ' AttributeError; a plain in-method store rebuilds it.';
  }
  return '\n\n当前可证明状态: ✓ 已在本方法体内重建(其后的读取安全)。'
    + '\n\nProvable state: ✓ rebuilt earlier in this method (later reads are safe).';
}

/** 跳转段(发布站知识页,真实路径;zh 行挂 zh 页,en 行挂 en 页,双语同段)。 */
function linksSection(): string {
  return `\n\n跳转: [实体生命周期·Cell 状态表](${LINK_LIFECYCLE}) · [onWriteToDB 参数绑定](${LINK_WRITETODB})`
    + `\n\nLinks: [Entity lifecycle · Cell state table](${LINK_LIFECYCLE_EN}) · [onWriteToDB parameter binding](${LINK_WRITETODB_EN})`;
}

/**
 * hover 注记 markdown(双语,`---` 分隔,挂既有 hover 尾部或独立成 hover)。
 * 渲染口径与 behaviorNoteMarkdown 同形。
 */
export function cellDataHoverMarkdown(inputs: CellDataHoverInputs): string {
  const head = `\n\n---\n\n**\`self.cellData\`** — Cell 属性字典(Cell property dict)`
    + `\n\n实体/Entity: ${inputs.entity} · 角色/Role: ${inputs.role}`;
  return head
    + sourceSection(inputs.keys)
    + snapshotSection(inputs.role)
    + provenSection(inputs.inWindow, inputs.state, inputs.role)
    + linksSection();
}
