import { describe, expect, it } from 'vitest';
import {
  createUnregisteredLiveValidationRegister,
  describeLiveValidationStatus,
  registerLiveValidationInputs,
  REQUIRED_LIVE_VALIDATION_COMPONENTS,
  REQUIRED_LIVE_VALIDATION_STARTUP_CONDITIONS
} from '../src/liveValidationInputs';
import { COMPONENT_NAMES, MACHINE_BROADCAST_PORT } from '../src/kbengineProtocol';

// IDE-LIV-001 登记真实引擎联验所需输入:目标版本(kbengine 仓 URL+ref)、
// 组件地址(用 COMPONENT_NAMES 现成名词,不另造组件名)、启动条件三段
// 清单;默认登记=全未登记+缺实例,状态文案明确「未测」——缺实例时绝
// 不写成已联验;登记/满足是纯函数更新,原登记不可变。

describe('createUnregisteredLiveValidationRegister(默认登记)', () => {
  it('三段齐:引擎版本未登记、组件地址清单、启动条件清单', () => {
    const register = createUnregisteredLiveValidationRegister();
    expect(register.engineVersion.registered).toBe(false);
    expect(REQUIRED_LIVE_VALIDATION_COMPONENTS.length).toBeGreaterThanOrEqual(3);
    expect(REQUIRED_LIVE_VALIDATION_STARTUP_CONDITIONS.length).toBeGreaterThanOrEqual(2);
    expect(register.componentAddresses).toHaveLength(REQUIRED_LIVE_VALIDATION_COMPONENTS.length);
    expect(register.startupConditions).toHaveLength(REQUIRED_LIVE_VALIDATION_STARTUP_CONDITIONS.length);
    expect(register.componentAddresses.every(address => !address.registered)).toBe(true);
    expect(register.startupConditions.every(condition => !condition.met)).toBe(true);
  });

  it('缺实例:instanceAvailable=false 是默认事实', () => {
    expect(createUnregisteredLiveValidationRegister().instanceAvailable).toBe(false);
  });

  it('组件名词全部来自 COMPONENT_NAMES,不自造', () => {
    for (const address of createUnregisteredLiveValidationRegister().componentAddresses) {
      expect(COMPONENT_NAMES).toContain(address.component);
    }
  });

  it('machine 项提示广播口 20086(现成常量,联验入口)', () => {
    const machine = createUnregisteredLiveValidationRegister().componentAddresses.find(
      address => address.component === 'machine'
    );
    expect(machine?.expected).toContain(String(MACHINE_BROADCAST_PORT));
  });
});

describe('registerLiveValidationInputs(纯函数登记)', () => {
  it('登记引擎版本:目标项变已登记,原登记对象不变', () => {
    const before = createUnregisteredLiveValidationRegister();
    const after = registerLiveValidationInputs(before, {
      engineVersion: { repoUrl: 'https://github.com/kbengine/kbengine', ref: 'v2.5.10', registered: true }
    });
    expect(after.engineVersion).toEqual({
      repoUrl: 'https://github.com/kbengine/kbengine',
      ref: 'v2.5.10',
      registered: true
    });
    expect(before.engineVersion.registered).toBe(false);
    expect(after.instanceAvailable).toBe(false);
  });

  it('登记组件地址按组件名合并,未点名项不动', () => {
    const before = createUnregisteredLiveValidationRegister();
    const after = registerLiveValidationInputs(before, {
      componentAddresses: [{ component: 'machine', host: '127.0.0.1', port: 20086, registered: true }]
    });
    const machine = after.componentAddresses.find(address => address.component === 'machine');
    expect(machine).toMatchObject({ host: '127.0.0.1', port: 20086, registered: true });
    const cellapp = after.componentAddresses.find(address => address.component === 'cellapp');
    expect(cellapp?.registered).toBe(false);
  });
});

describe('describeLiveValidationStatus(缺实例明确未测)', () => {
  it('默认登记 → 文案含「缺实例」与「未测」,不冒充已联验', () => {
    const status = describeLiveValidationStatus(createUnregisteredLiveValidationRegister());
    expect(status).toContain('缺实例');
    expect(status).toContain('未测');
    expect(status).not.toContain('可联验');
  });

  it('部分登记 → 逐项区分已登记/未登记', () => {
    const register = registerLiveValidationInputs(createUnregisteredLiveValidationRegister(), {
      engineVersion: { repoUrl: 'https://github.com/kbengine/kbengine', ref: 'v2.5.10', registered: true }
    });
    const status = describeLiveValidationStatus(register);
    expect(status).toContain('v2.5.10');
    expect(status).toContain('未登记');
    expect(status).toContain('缺实例');
  });

  it('输入全登记但缺实例 → 仍明确未测', () => {
    const base = createUnregisteredLiveValidationRegister();
    const register = registerLiveValidationInputs(base, {
      engineVersion: { repoUrl: 'https://github.com/kbengine/kbengine', ref: 'v2.5.10', registered: true },
      componentAddresses: base.componentAddresses.map(address => ({ ...address, host: '127.0.0.1', registered: true })),
      startupConditions: base.startupConditions.map(condition => ({ ...condition, met: true }))
    });
    const status = describeLiveValidationStatus(register);
    expect(status).toContain('缺实例');
    expect(status).toContain('未测');
  });

  it('全登记+实例可用 → 可联验文案,不再说未测', () => {
    const base = createUnregisteredLiveValidationRegister();
    const register = {
      ...registerLiveValidationInputs(base, {
        engineVersion: { repoUrl: 'https://github.com/kbengine/kbengine', ref: 'v2.5.10', registered: true },
        componentAddresses: base.componentAddresses.map(address => ({ ...address, host: '127.0.0.1', registered: true })),
        startupConditions: base.startupConditions.map(condition => ({ ...condition, met: true }))
      }),
      instanceAvailable: true
    };
    const status = describeLiveValidationStatus(register);
    expect(status).toContain('可联验');
    expect(status).not.toContain('未测');
  });

  it('lastVerifiedAt 回填 → 展示联验时刻(联验后回写面)', () => {
    const base = createUnregisteredLiveValidationRegister();
    const register = {
      ...registerLiveValidationInputs(base, {
        engineVersion: { repoUrl: 'u', ref: 'r', registered: true },
        componentAddresses: base.componentAddresses.map(address => ({ ...address, registered: true })),
        startupConditions: base.startupConditions.map(condition => ({ ...condition, met: true }))
      }),
      instanceAvailable: true,
      lastVerifiedAt: '2026-10-29T00:00:00Z'
    };
    const status = describeLiveValidationStatus(register);
    expect(status).toContain('可联验');
    expect(status).toContain('2026-10-29T00:00:00Z');
  });
});
