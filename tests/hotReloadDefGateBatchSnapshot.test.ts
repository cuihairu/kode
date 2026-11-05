import { beforeEach, describe, expect, it } from 'vitest';

import { createDefStructuralGate } from '../src/hotReloadDefGate';

// F1 四轮(2026-11-06 复审):三轮的「按文件集匹配最早未消费批」仍是错拿通路
// ——被拦批次也进快照队列,批 A 被拦、同文件集批 B 放行时,B 的 commit 会按
// 文件集匹配到**最早**的 A 批,把从未通过判定的被拦内容滚进基册(指纹相同
// 即放行,绕过需重启)。修后:①被拦批次不入快照认领队列(只入被拦记录册);
// ②check 返回批次令牌,commit(令牌) 只认领令牌对应的那一批——同文件集的
// 并发/先后批次各归各,被拦批的快照没有任何通路借别批 commit 入册。

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

describe('def 结构闸批次令牌(F1 四轮回归)', () => {
  let baselines: Map<string, string>;
  let content: string;
  beforeEach(() => {
    baselines = new Map<string, string>([[FILE, BASE_DEF]]);
    content = NONSTRUCTURAL_DEF;
  });

  const makeGate = () =>
    createDefStructuralGate(async () => content, baselines);

  it('A 被拦+B 放行(同文件集):B commit 只滚 B 快照,基线不含 A 被拦内容且后续同结构变更仍被拦', async () => {
    const gate = makeGate();
    // 批 A 判定:读到结构性内容 → 被拦(旧实现:A 的快照也进认领队列)
    content = STRUCTURAL_DEF;
    const verdictA = await gate.check([FILE]);
    expect(verdictA.reasons).toHaveLength(1);
    // 批 B 判定:文件回到非结构内容 → 放行(与 A 同文件集)
    content = NONSTRUCTURAL_DEF;
    const verdictB = await gate.check([FILE]);
    expect(verdictB.reasons).toEqual([]);

    // B 放行即真实发送 → commit。旧实现按文件集匹配最早批 = A,
    // 把 A 的被拦内容滚进基册(时序绕过);修后 commit(B.token) 只认 B 批。
    await gate.commit(verdictB.token);

    // 基线=B 自己判定的快照,绝不是 A 的被拦内容
    expect(baselines.get(FILE)).toBe(NONSTRUCTURAL_DEF);
    // 行为后果:A 的被拦内容(结构性)相对新基册仍被拦——基册未被污染放行
    content = STRUCTURAL_DEF;
    const after = await gate.check([FILE]);
    expect(after.reasons).toHaveLength(1);
    expect(after.reasons[0]).toContain('属性结构变化');
  });

  it('被拦批的令牌 commit 不滚任何快照(被拦批不入认领队列)', async () => {
    const gate = makeGate();
    content = STRUCTURAL_DEF;
    const verdictA = await gate.check([FILE]);
    expect(verdictA.reasons).toHaveLength(1);
    // 被拦批绝不会被真实发送,其令牌不认领任何快照
    await gate.commit(verdictA.token);
    expect(baselines.get(FILE)).toBe(BASE_DEF);
  });

  it('未知/过期令牌 commit 不滚(只认自己那批的令牌)', async () => {
    const gate = makeGate();
    expect((await gate.check([FILE])).reasons).toEqual([]);
    // 从未判定过的令牌:不借任何在册快照滚动
    await gate.commit(999_999);
    expect(baselines.get(FILE)).toBe(BASE_DEF);
  });

  it('同文件先后两批都放行,各令牌各归各:令牌乱序消费也各滚各的快照', async () => {
    const gate = makeGate();
    // 批 1 判定放行(快照=非结构内容)
    const first = await gate.check([FILE]);
    expect(first.reasons).toEqual([]);
    // 批 2 判定放行(内容再变,仍非结构;快照=另一份非结构内容)
    const second = `<!-- 第二批注释 -->\n${NONSTRUCTURAL_DEF}`;
    content = second;
    const secondVerdict = await gate.check([FILE]);
    expect(secondVerdict.reasons).toEqual([]);

    // 乱序消费:先 commit 批 2 再 commit 批 1,各令牌只滚自己批的快照
    await gate.commit(secondVerdict.token);
    expect(baselines.get(FILE)).toBe(second);
    await gate.commit(first.token);
    expect(baselines.get(FILE)).toBe(NONSTRUCTURAL_DEF);
  });
});
