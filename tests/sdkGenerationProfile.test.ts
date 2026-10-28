import { describe, expect, it, vi } from 'vitest';
import { bindSdkGenerationToProfile } from '../src/sdkGenerationProfile';

// IDE-SDK-003 把 SDK 生成绑定到目标 profile:实体注册顺序与类型数据都
// 来自所选 profile 根——注册序=该根 entities.xml 登记序(listRegistrations
// 注入,装配=getRegisteredEntities 文档序面),类型=该根 types.xml 原文;
// 其他根的同名实体绝不覆盖所选根(逐个点名拒收),其他根独有的实体也不
// 混入注册(注册只来自所选根);缺登记/缺 types.xml 如实(空注册/null),
// 不猜不回落别的根。

const REGISTRATIONS_A = [{ name: 'Avatar' }, { name: 'Monster' }, { name: 'Gate' }];
const TYPES_A = '<types><UINT32> ... </UINT32></types>';

const deps = (overrides: Record<string, unknown> = {}) => ({
  listRegistrations: vi.fn(() => REGISTRATIONS_A),
  readTypesXml: vi.fn(() => TYPES_A),
  listOtherRootEntityNames: vi.fn(() => [] as string[]),
  ...overrides
});

describe('bindSdkGenerationToProfile(SDK 生成绑定 profile 根)', () => {
  it('实体注册顺序=所选根 entities.xml 登记序', () => {
    const binding = bindSdkGenerationToProfile('/ws/rootA', deps());
    expect(binding.registrations.map(reg => reg.name)).toEqual(['Avatar', 'Monster', 'Gate']);
    expect(binding.registrations.map(reg => reg.order)).toEqual([0, 1, 2]);
  });

  it('类型数据=所选根 types.xml 原文', () => {
    expect(bindSdkGenerationToProfile('/ws/rootA', deps()).typesXml).toBe(TYPES_A);
  });

  it('跨根同名实体:不覆盖所选根,逐个点名拒收', () => {
    const d = deps({ listOtherRootEntityNames: vi.fn(() => ['Avatar', 'Monster', 'Space']) });
    const binding = bindSdkGenerationToProfile('/ws/rootA', d);

    expect(binding.registrations.map(reg => reg.name)).toEqual(['Avatar', 'Monster', 'Gate']);
    expect(binding.skippedSameNameFromOtherRoots).toEqual(['Avatar', 'Monster']);
  });

  it('其他根独有的实体不混入注册(注册只来自所选根)', () => {
    const d = deps({ listOtherRootEntityNames: vi.fn(() => ['Space']) });
    const binding = bindSdkGenerationToProfile('/ws/rootA', d);

    expect(binding.registrations.some(reg => reg.name === 'Space')).toBe(false);
    expect(binding.skippedSameNameFromOtherRoots).toEqual([]);
  });

  it('所选根 entities.xml 缺登记(空清单)→ 空注册如实(不回落别的根)', () => {
    const d = deps({ listRegistrations: vi.fn(() => []) });
    const binding = bindSdkGenerationToProfile('/ws/rootA', d);
    expect(binding.registrations).toEqual([]);
    expect(binding.typesXml).toBe(TYPES_A);
  });

  it('types.xml 缺失 → null 如实', () => {
    const d = deps({ readTypesXml: vi.fn(() => null) });
    expect(bindSdkGenerationToProfile('/ws/rootA', d).typesXml).toBeNull();
  });

  it('无跨根同名 → 拒收清单空', () => {
    expect(bindSdkGenerationToProfile('/ws/rootA', deps()).skippedSameNameFromOtherRoots).toEqual([]);
  });

  it('读取只打所选根(注册/类型/跨根清单都只问该根)', () => {
    const d = deps({ listOtherRootEntityNames: vi.fn(() => ['Avatar']) });
    bindSdkGenerationToProfile('/ws/rootA', d);
    expect(d.listRegistrations).toHaveBeenCalledWith('/ws/rootA');
    expect(d.readTypesXml).toHaveBeenCalledWith('/ws/rootA');
    expect(d.listOtherRootEntityNames).toHaveBeenCalledWith('/ws/rootA');
  });
});
