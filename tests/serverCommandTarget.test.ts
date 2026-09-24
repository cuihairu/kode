import { describe, expect, it } from 'vitest';
import { resolveServerComponent } from '../src/serverCommandTarget';
import { SERVER_COMPONENTS } from '../src/serverManager';

// resolveServerComponent:从树节点等任意 target 里解析服务器组件,
// 纯查表逻辑,直接对常量表断言。

describe('resolveServerComponent', () => {
  it('resolves by direct name', () => {
    expect(resolveServerComponent({ name: 'baseapp' }))
      .toBe(SERVER_COMPONENTS.find(c => c.name === 'baseapp'));
    expect(resolveServerComponent({ name: 'machine' })?.order).toBe(1);
  });

  it('resolves through the nested component payload', () => {
    expect(resolveServerComponent({ component: { name: 'dbmgr' } }))
      .toBe(SERVER_COMPONENTS.find(c => c.name === 'dbmgr'));
  });

  it('returns undefined for unknown names and non-object targets', () => {
    expect(resolveServerComponent({ name: 'nope' })).toBeUndefined();
    expect(resolveServerComponent({ component: { name: 'nope' } })).toBeUndefined();
    expect(resolveServerComponent(null)).toBeUndefined();
    expect(resolveServerComponent(undefined)).toBeUndefined();
    expect(resolveServerComponent('baseapp')).toBeUndefined();
    expect(resolveServerComponent(42)).toBeUndefined();
  });

  it('ignores name fields that are not strings', () => {
    expect(resolveServerComponent({})).toBeUndefined();
    expect(resolveServerComponent({ name: 42 })).toBeUndefined();
  });
});
