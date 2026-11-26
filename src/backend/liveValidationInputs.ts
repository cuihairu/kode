/**
 * Registers the inputs a real-engine live validation needs (IDE-LIV-001): the target version
 * (the kbengine repo URL + ref), component addresses (names aligned with COMPONENT_NAMES,
 * never invented), and the three-part startup-condition list. The default register = nothing
 * registered + no instance, and the status wording says "untested" explicitly -- when an
 * instance is missing it is never written up as live-validated; registering/satisfying is a
 * pure-function update (the original register is immutable). The live-validation execution face
 * (LIV-003/004 real queries) and the protocol-number check (LIV-002) land separately; this
 * module only handles input registration and presenting status honestly.
 */

import { MACHINE_BROADCAST_PORT } from './kbengineProtocol';

export interface LiveValidationEngineVersion {
  /** The engine repo address (e.g. https://github.com/kbengine/kbengine) */
  repoUrl?: string;
  /** tag/commit/branch */
  ref?: string;
  registered: boolean;
}

export interface LiveValidationComponentAddress {
  /** An existing COMPONENT_NAMES name */
  component: string;
  host?: string;
  port?: number;
  /** Names the expectation when unregistered (e.g. machine's broadcast port); the registration face fills it in accordingly */
  expected?: string;
  registered: boolean;
}

export interface LiveValidationStartupCondition {
  description: string;
  met: boolean;
}

export interface LiveValidationRegister {
  engineVersion: LiveValidationEngineVersion;
  componentAddresses: LiveValidationComponentAddress[];
  startupConditions: LiveValidationStartupCondition[];
  /** Whether a real engine instance is available (a missing instance = the source of truth for "untested") */
  instanceAvailable: boolean;
  /** Backfilled after live validation runs (an ISO moment); not set for registration without a validation run */
  lastVerifiedAt?: string;
}

/** The component-address list live validation needs (the participants of the watcher path query and the spaces list query) */
export const REQUIRED_LIVE_VALIDATION_COMPONENTS: Array<Pick<LiveValidationComponentAddress, 'component' | 'expected'>> = [
  { component: 'machine', expected: `广播口 ${MACHINE_BROADCAST_PORT}(组件发现入口)` },
  { component: 'cellappmgr', expected: '空间列表查询(Cellappmgr::querySpaces)的组件地址' },
  { component: 'cellapp', expected: 'watcher 路径查询的组件地址' },
  { component: 'baseapp', expected: 'watcher 路径查询的组件地址' }
];

/** The live-validation startup-condition list */
export const REQUIRED_LIVE_VALIDATION_STARTUP_CONDITIONS: Array<Pick<LiveValidationStartupCondition, 'description'>> = [
  { description: 'demo 服务端启动并完成组件互相发现(machine/baseapp/cellapp 就绪)' },
  { description: '可登录的 demo 客户端账号(触发实体创建与空间负载)' }
];

/** The default register: none of the required inputs registered, no instance (an honest starting point, no passing off) */
export function createUnregisteredLiveValidationRegister(): LiveValidationRegister {
  return {
    engineVersion: { registered: false },
    componentAddresses: REQUIRED_LIVE_VALIDATION_COMPONENTS.map(component => ({
      component: component.component,
      expected: component.expected,
      registered: false
    })),
    startupConditions: REQUIRED_LIVE_VALIDATION_STARTUP_CONDITIONS.map(condition => ({
      description: condition.description,
      met: false
    })),
    instanceAvailable: false
  };
}

export interface LiveValidationRegisterUpdate {
  engineVersion?: LiveValidationEngineVersion;
  componentAddresses?: LiveValidationComponentAddress[];
  startupConditions?: LiveValidationStartupCondition[];
}

/** Pure-function registration: merges the update by component name/order, the original register object unchanged */
export function registerLiveValidationInputs(
  register: LiveValidationRegister,
  update: LiveValidationRegisterUpdate
): LiveValidationRegister {
  const componentAddresses = update.componentAddresses
    ? register.componentAddresses.map(
        existing =>
          update.componentAddresses?.find(patch => patch.component === existing.component) ?? existing
      )
    : register.componentAddresses;
  return {
    engineVersion: update.engineVersion ?? register.engineVersion,
    componentAddresses,
    startupConditions: update.startupConditions ?? register.startupConditions,
    instanceAvailable: register.instanceAvailable
  };
}

/** Status wording: registered/unregistered and met/unmet item by item; a missing instance is explicitly "untested" */
export function describeLiveValidationStatus(register: LiveValidationRegister): string {
  const lines: string[] = [];
  const version = register.engineVersion;
  lines.push(
    version.registered
      ? `引擎版本:已登记 ${version.ref ?? '?'} @ ${version.repoUrl ?? '?'}`
      : '引擎版本:未登记(需 kbengine 仓地址与 tag/commit)'
  );
  for (const address of register.componentAddresses) {
    lines.push(
      address.registered
        ? `组件地址 ${address.component}:已登记 ${address.host ?? '?'}:${address.port ?? '?'}`
        : `组件地址 ${address.component}:未登记(期望:${address.expected ?? '见联验清单'})`
    );
  }
  for (const condition of register.startupConditions) {
    lines.push(`启动条件:${condition.description} → ${condition.met ? '满足' : '未满足'}`);
  }
  const inputsReady =
    register.engineVersion.registered &&
    register.componentAddresses.every(address => address.registered) &&
    register.startupConditions.every(condition => condition.met);
  if (!register.instanceAvailable) {
    lines.push('缺实例:未测(真实引擎联验未执行,不冒充已联验)');
    return lines.join('\n');
  }
  if (!inputsReady) {
    lines.push('实例可用但输入未齐:未测(登记补齐后联验)');
    return lines.join('\n');
  }
  const verified = register.lastVerifiedAt ? `,联验时刻 ${register.lastVerifiedAt}` : '';
  return `${lines.join('\n')}\n输入齐+实例可用:可联验${verified}`;
}
