/**
 * Python 语言服务可用性三态(IDE-PRJ-005):未安装/未启用/已激活。
 * 判定只看扩展事实——注册(vscode.extensions.all)/激活(isActive)/安装
 * 目录(磁盘证据,被禁用的扩展不进 extensions.all,靠目录探测兜住);
 * extraPaths 是否写入永不参与可用判定,只在显示面附警示
 * (python.analysis.extraPaths 写了不等于 Pylance 在跑)。
 * 本模块是纯判定+渲染面;采集在 extension.ts 命令接线处。
 */

import * as fs from 'fs';

/** 语言服务扩展(Pylance):python.analysis.* 设置的属主 */
export const PYLANCE_EXTENSION_ID = 'ms-python.vscode-pylance';

export interface PythonServiceFacts {
  /** 出现在 vscode.extensions.all(被禁用的扩展不在其中) */
  registered: boolean;
  /** 当前扩展宿主中已激活 */
  isActive: boolean;
  /** 用户扩展目录里存在 <id>-<version> 安装目录(磁盘证据) */
  installDirExists: boolean;
  /** python.analysis.extraPaths 已有值(与可用无关,只触发警示) */
  extraPathsWritten: boolean;
}

export type PythonServiceState = 'active' | 'not-enabled' | 'not-installed';

export interface PythonServiceStatus {
  state: PythonServiceState;
  /** 显示标签:已激活/未启用/未安装 */
  label: string;
  /** 一行说明(判定依据) */
  detail: string;
}

/**
 * 三态判定:已激活 > 已安装未启用(注册或磁盘证据任一,但本窗口未激活,
 * 覆盖被禁用与按需未激活) > 未安装(既未注册也无磁盘证据)。
 * extraPathsWritten 不参与判定。
 */
export function classifyPythonService(facts: PythonServiceFacts): PythonServiceStatus {
  if (facts.isActive) {
    return {
      state: 'active',
      label: '已激活',
      detail: `${PYLANCE_EXTENSION_ID} 已在本窗口激活`
    };
  }
  if (facts.registered || facts.installDirExists) {
    return {
      state: 'not-enabled',
      label: '未启用',
      detail: `${PYLANCE_EXTENSION_ID} 已安装但当前窗口未激活(被禁用或未参与本窗口)`
    };
  }
  return {
    state: 'not-installed',
    label: '未安装',
    detail: `找不到 ${PYLANCE_EXTENSION_ID} 的注册或安装目录`
  };
}

/**
 * 显示面:状态一行 + 判定依据;extraPathsWritten 时附警示——写入
 * extraPaths 只是配置面,不等于语言服务可用(IDE-PRJ-005 验收口径)。
 */
export function renderPythonServiceMessage(status: PythonServiceStatus, facts: PythonServiceFacts): string {
  const caveat = facts.extraPathsWritten
    ? ';注意: extraPaths 已写入不等于语言服务可用'
    : '';
  return `Python 语言服务: ${status.label}(${status.detail})${caveat}`;
}

/**
 * 用户扩展目录探测:目录里存在 <id>-<version> 形态的安装目录即算已安装
 * (extensions.all 不含被禁用扩展,这是磁盘兜底证据)。目录不存在/不可读
 * 如实 false,不炸。
 */
export function pylanceInstallExists(extensionsDir: string): boolean {
  try {
    const entries = fs.readdirSync(extensionsDir);
    return entries.some(entry => entry.startsWith(`${PYLANCE_EXTENSION_ID}-`));
  } catch {
    return false;
  }
}
