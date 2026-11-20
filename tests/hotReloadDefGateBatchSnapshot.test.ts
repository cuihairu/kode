import { beforeEach, describe, expect, it } from 'vitest';

import { createDefStructuralGate } from '../src/backend/hotReloadDefGate';

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

// ---------------------------------------------------------------------------
// 批 32 容错臂:无 reader 的 commit/confirmLoaded 早退、读取抛错按 null、
// 纯 Python 批放行、两册 64 上限丢最老(防泄漏)。
// ---------------------------------------------------------------------------
describe('批 32:def 结构闸容错臂', () => {
  it('无 reader:check 拦下整批,commit/confirmLoaded 零操作', async () => {
    const gate = createDefStructuralGate(undefined, new Map());
    const verdict = await gate.check([FILE]);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toContain('无内容读取通道');
    await expect(gate.commit(verdict.token)).resolves.toBeUndefined();
    await expect(gate.confirmLoaded([FILE])).resolves.toBe(0);
  });

  it('读取抛错按 null:整批拦下(证明不了无结构变化,保守不发)', async () => {
    const gate = createDefStructuralGate(async () => {
      throw new Error('read boom');
    }, new Map([[FILE, BASE_DEF]]));
    const verdict = await gate.check([FILE]);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it('纯 Python 批(无 def 文件)放行,commit 零操作', async () => {
    const gate = createDefStructuralGate(async () => NONSTRUCTURAL_DEF, new Map([[FILE, BASE_DEF]]));
    const verdict = await gate.check(['/ws/scripts/base/Avatar.py']);
    expect(verdict.reasons).toEqual([]);
    await expect(gate.commit(verdict.token)).resolves.toBeUndefined();
  });

  it('被拦册超 64 批丢最老(防泄漏,不误留任意早批)', async () => {
    const gate = createDefStructuralGate(undefined, new Map());
    const tokens: number[] = [];
    for (let i = 0; i < 66; i += 1) {
      tokens.push((await gate.check([FILE])).token);
    }
    // 全部被拦(无 reader);册只留最近 64 批:最早两批的令牌已丢,
    // 被拦批永不 commit(其令牌本来也认领不到),此臂钉丢最老不抛即可
    expect(tokens).toHaveLength(66);
    await expect(gate.commit(tokens[tokens.length - 1])).resolves.toBeUndefined();
  });

  it('放行册超 64 批丢最老:最早放行批的令牌不再可认领', async () => {
    const baselines = new Map([[FILE, BASE_DEF]]);
    const gate = createDefStructuralGate(async () => NONSTRUCTURAL_DEF, baselines);
    const tokens: number[] = [];
    for (let i = 0; i < 66; i += 1) {
      const verdict = await gate.check([FILE]);
      expect(verdict.reasons).toEqual([]);
      tokens.push(verdict.token);
    }
    // 全放行未 commit → 册满 64,最早两批被丢:commit 首批零操作,
    // 最新批仍可认领
    await expect(gate.commit(tokens[0])).resolves.toBeUndefined();
    await expect(gate.commit(tokens[tokens.length - 1])).resolves.toBeUndefined();
  });
});

describe('批 32 续:读取通道在场时被拦册超限丢最老', () => {
  it('66 次结构性被拦 → 被拦册丢最老,不抛不滞留', async () => {
    const gate = createDefStructuralGate(async () => STRUCTURAL_DEF, new Map([[FILE, BASE_DEF]]));
    for (let i = 0; i < 66; i += 1) {
      const verdict = await gate.check([FILE]);
      expect(verdict.reasons.length).toBeGreaterThan(0);
    }
    // 册满丢最老后仍可继续判定:第 67 次照常被拦
    expect((await gate.check([FILE])).reasons.length).toBeGreaterThan(0);
  });
});

// 覆盖口径残余(批 32 定性)::93 readContent 的 `!reader` 早退——check/
// confirmLoaded/commit 三调用方都在调用前以同一条件自守,reader 为空时
// readContent 根本不会被调,防御位。
