// C-23 交付②第二条规则(KBE-PY-016):已销毁实体引用滞留 lint。
// 数据源 = KB-001 生命周期/内存专题(docs/knowledge/traps-index.md
// §Memory & references;src/knowledge/trapsKnowledge.ts
// detection='destroyed-entity-container-capture')。KB-001 事实:真正的
// 引用隐患不是定时器(destroy 即 cancelAll、handler 不持 Python 强引用),
// 而是脚本把实体引用(self)存进生命周期长于实体的**模块级容器**——
// destroy 后引用滞留,引擎 3600 s 后打 garbages 泄漏告警;正确姿势是
// onDestroy 里解除引用,排查滞留者用 `KBEngine.entities.garbages.items()`。
//
// 纯逻辑层,不 import vscode。判定(保守面,误报=0 优先):
//   - 模块级容器:顶格(indent 0)`NAME = []` / `NAME = {}` / `NAME = set()`
//     声明的 list/dict/set(标量/lambda 等非容器全局不参与);
//   - 类体内语句(缩进 > 0)把 `self` 存入容器:append/add/extend/update
//     调用(实参含独立 self 词元)与 `NAME[...] = …self…` 下标赋值;
//   - 局部容器、非 self 实参、读操作(`in` 判断)、注释同形不报;
//   - 闭包逃逸(`lambda: self`)与函数属性等面不分析,如实边界不冒充。

import { l10nText } from '../nlsRuntime';

export const DESTROYED_ENTITY_REFERENCE_DIAGNOSTIC_CODE = 'kbengine.destroyedEntityReference';

/** 一处实体引用滞留 */
export interface DestroyedEntityCaptureFinding {
  line: number;
  /** `self` 词元起点(0 起列) */
  character: number;
  length: number;
  container: string;
  /** 容器操作(append/add/extend/update/subscript) */
  method: string;
  message: string;
}

const CONTAINER_INIT = /^([A-Za-z_]\w*)\s*=\s*(\[\]|\{\}|set\(\))\s*$/;
const CALL_CAPTURE = /\b([A-Za-z_]\w*)\.(append|add|extend|update)\((.+)\)/;
const SUBSCRIPT_CAPTURE = /\b([A-Za-z_]\w*)\[[^\]]+\]\s*=\s*(.+)/;

/** 诊断文案(l10n 模板单一来源;Rust 结构面经 wiring 层用本函数渲染) */
export function renderDestroyedEntityReferenceMessage(container: string): string {
  return l10nText(
    'Storing self in a module-level container keeps the entity alive after destroy (garbages leak); drop the reference in onDestroy',
    { container }
  );
}

export function analyzeDestroyedEntityCaptures(text: string): DestroyedEntityCaptureFinding[] {
  const findings: DestroyedEntityCaptureFinding[] = [];
  const lines = text.split(/\r?\n/);
  const containers = new Set<string>();
  for (const raw of lines) {
    const init = CONTAINER_INIT.exec(raw);
    if (init) {
      containers.add(init[1]);
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || !raw.startsWith(' ')) {
      continue;
    }
    const call = CALL_CAPTURE.exec(trimmed);
    if (call && containers.has(call[1])) {
      const argOffset = trimmed.indexOf(call[3]);
      const selfOffset = standaloneSelfOffset(call[3]);
      if (selfOffset >= 0) {
        const lineIndent = raw.length - raw.trimStart().length;
        findings.push({
          line: index,
          character: lineIndent + argOffset + selfOffset,
          length: 'self'.length,
          container: call[1],
          method: call[2],
          message: renderDestroyedEntityReferenceMessage(call[1])
        });
      }
      continue;
    }
    const subscript = SUBSCRIPT_CAPTURE.exec(trimmed);
    if (subscript && containers.has(subscript[1]) && standaloneSelfOffset(subscript[2]) >= 0) {
      const targetLength = subscript[0].length - subscript[2].length;
      const lineIndent = raw.length - raw.trimStart().length;
      findings.push({
        line: index,
        character: lineIndent + targetLength + standaloneSelfOffset(subscript[2]),
        length: 'self'.length,
        container: subscript[1],
        method: 'subscript',
        message: renderDestroyedEntityReferenceMessage(subscript[1])
      });
    }
  }
  return findings;
}

/** 实参/右值文本里独立 `self` 词元的 0 起列;无则 -1(self.id 等成员读不算) */
function standaloneSelfOffset(text: string): number {
  const match = /(?<![\w.])self(?![\w.])/.exec(text);
  return match ? match.index : -1;
}
