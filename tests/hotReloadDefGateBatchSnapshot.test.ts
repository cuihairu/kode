import { beforeEach, describe, expect, it } from 'vitest';

import { createDefStructuralGate } from '../src/hotReloadDefGate';

// F1 三轮(2026-11-06 复审):check 判定时留的内容快照必须按批次/代际隔离——
// 二轮实现把快照落进「文件 → 内容」的共享槽位,两批并发判定共享同一槽位,
// 后判定批覆写先判定批的快照,先批 commit 时会把「从未通过判定的后批内容」
// 滚进基册(时序绕过:被拦内容借并发批的 commit 入基线)。修后每批持有自己
// 的判定快照,commit 只认自己那批的,并发判定互不覆写。

const BASE_DEF = `<root>
  <Properties>
    <hp>
      <Type>INT32</Type>
      <Flags>CELL_PRIVATE</Flags>
    </hp>
  </Properties>
</root>
`;
// 只加注释:相对 BASE_DEF 非结构变化(判定放行)
const NONSTRUCTURAL_DEF = `<!-- 注释不进指纹 -->\n${BASE_DEF}`;
// 属性 Type INT32 → FLOAT:序列化面结构变化(判定拦下)
const STRUCTURAL_DEF = BASE_DEF.replace('<Type>INT32</Type>', '<Type>FLOAT</Type>');

const FILE = '/ws/scripts/Avatar.def';

describe('def 结构闸判定快照按批次隔离(F1 三轮回归)', () => {
  let baselines: Map<string, string>;
  let content: string;
  beforeEach(() => {
    baselines = new Map<string, string>([[FILE, BASE_DEF]]);
    content = NONSTRUCTURAL_DEF;
  });

  const makeGate = () =>
    createDefStructuralGate(async () => content, baselines);

  it('两批并发判定互不覆写:先批 commit 只滚自己批的快照,被拦批内容不入基册', async () => {
    const gate = makeGate();
    // 批 A 判定(读到非结构内容,放行;快照 A=非结构内容)
    const batchA = gate.check([FILE]);
    // 批 A 的 commit 之前,批 B 并发判定(读到结构变化内容,被拦;快照 B=结构性内容)
    content = STRUCTURAL_DEF;
    const batchB = gate.check([FILE]);
    expect(await batchA).toEqual([]);
    expect(await batchB).toHaveLength(1);

    // 批 A 放行即真实发送 → commit 前滚。共享槽位旧实现此处读到批 B 覆写后
    // 的快照,把「从未通过判定的结构性内容」滚进基册(时序绕过)。
    await gate.commit([FILE]);

    // 基册必须是批 A 自己判定的快照,绝不是批 B 的被拦内容
    expect(baselines.get(FILE)).toBe(NONSTRUCTURAL_DEF);
    // 行为后果:批 B 的结构性内容相对新基册仍被拦(基册未被污染放行)
    expect(await gate.check([FILE])).toHaveLength(1);
  });

  it('同文件先后两批都放行并先后 commit:各批快照按代际各归各(FIFO 消费)', async () => {
    const gate = makeGate();
    // 批 1 判定放行(快照=非结构内容)
    expect(await gate.check([FILE])).toEqual([]);
    // 批 2 判定放行(内容再变,仍非结构;快照=另一份非结构内容)
    const second = `<!-- 第二批注释 -->\n${NONSTRUCTURAL_DEF}`;
    content = second;
    expect(await gate.check([FILE])).toEqual([]);

    // 两次 commit 按代际消费:第一次滚批 1 快照,第二次滚批 2 快照
    await gate.commit([FILE]);
    expect(baselines.get(FILE)).toBe(NONSTRUCTURAL_DEF);
    await gate.commit([FILE]);
    expect(baselines.get(FILE)).toBe(second);
  });

  it('commit 的文件集与任何判定批都不匹配:不滚任何快照(只认自己那批)', async () => {
    const gate = makeGate();
    expect(await gate.check([FILE])).toEqual([]);
    // 未判定过的文件集:无本批快照,commit 不得借别批快照滚动
    await gate.commit(['/ws/scripts/Monster.def']);
    expect(baselines.get(FILE)).toBe(BASE_DEF);
  });
});
