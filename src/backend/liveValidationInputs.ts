/**
 * 登记真实引擎联验所需输入(IDE-LIV-001):目标版本(kbengine 仓 URL+
 * ref)、组件地址(名词与 COMPONENT_NAMES 对齐,不自造)、启动条件三
 * 段清单。默认登记=全未登记+缺实例,状态文案明确「未测」——缺实例
 * 时绝不写成已联验;登记/满足是纯函数更新(原登记不可变)。联验执行
 * 面(LIV-003/004 真实查询)与协议号核对(LIV-002)各自另行落地,本
 * 模块只管输入登记与状态如实呈现。
 */

import { MACHINE_BROADCAST_PORT } from './kbengineProtocol';

export interface LiveValidationEngineVersion {
  /** 引擎仓地址(如 https://github.com/kbengine/kbengine) */
  repoUrl?: string;
  /** tag/commit/branch */
  ref?: string;
  registered: boolean;
}

export interface LiveValidationComponentAddress {
  /** COMPONENT_NAMES 现成名词 */
  component: string;
  host?: string;
  port?: number;
  /** 未登记时点名期望(如 machine 的广播口),登记面照此补 */
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
  /** 真实引擎实例是否可用(缺实例=未测的事实来源) */
  instanceAvailable: boolean;
  /** 联验执行后回填(ISO 时刻);仅登记无联验不设 */
  lastVerifiedAt?: string;
}

/** 联验需要的组件地址清单(watcher 路径查询与空间列表查询的参与面) */
export const REQUIRED_LIVE_VALIDATION_COMPONENTS: Array<Pick<LiveValidationComponentAddress, 'component' | 'expected'>> = [
  { component: 'machine', expected: `广播口 ${MACHINE_BROADCAST_PORT}(组件发现入口)` },
  { component: 'cellappmgr', expected: '空间列表查询(Cellappmgr::querySpaces)的组件地址' },
  { component: 'cellapp', expected: 'watcher 路径查询的组件地址' },
  { component: 'baseapp', expected: 'watcher 路径查询的组件地址' }
];

/** 联验启动条件清单 */
export const REQUIRED_LIVE_VALIDATION_STARTUP_CONDITIONS: Array<Pick<LiveValidationStartupCondition, 'description'>> = [
  { description: 'demo 服务端启动并完成组件互相发现(machine/baseapp/cellapp 就绪)' },
  { description: '可登录的 demo 客户端账号(触发实体创建与空间负载)' }
];

/** 默认登记:所需输入全未登记、缺实例(如实起点,不冒充) */
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

/** 纯函数登记:按组件名/序合并更新,原登记对象不变 */
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

/** 状态文案:逐项已登记/未登记、满足/未满足;缺实例明确「未测」 */
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
