// KODE-CFG-007:telnet 目标列表按配置启用(设计 §4 行 24 的拆两半)。
//
// Rust core 派生半(段开关 + 逐组件派生端口,`derive.telnet`)是单一真源;
// TS 留存 settings 半(host/密码/命令白名单覆盖)。旧路径
// readTelnetTargetsFromSettings 在派生不可用时兜底——两条路径读同一份
// 配置文件(buildConfigTreePair 同一装载口径),派生端口与旧路径一致。
//
// 独立模块而非并入 telnetService:serverConfigMerge(→ telnetService)与
// configDerive 已有依赖边,telnetService 再引 configDerive 即成环。
import * as vscode from 'vscode';

import { ensureConfigDerivedScanRoot, getConfigDerivedScanRootState } from './configDerive';
import {
  readTelnetSettings,
  readTelnetTargetsFromSettings,
  TelnetSettingsInput,
  TelnetTarget
} from './telnetService';

/** derive.telnet 端点(Rust 序列化镜像) */
export interface DerivedTelnetEndpoint {
  component: string;
  host: string;
  port: number;
  passwordSet: boolean;
}

export interface DerivedTelnetCapabilities {
  enabled: boolean;
  endpoints: DerivedTelnetEndpoint[];
}

/**
 * 派生半 + settings 半拼合:enabled=false(配置未开 telnet 段)→ 空目标
 * (批111「defaults 段不当开关」口径已由 Rust derive_telnet 原样迁);
 * 开启时组件名/端口来自派生端点(含派生端口),host/密码/命令白名单
 * 来自 settings 覆盖(design 行 24 的 settings 半)。
 */
export function buildDerivedTelnetTargets(
  derived: DerivedTelnetCapabilities,
  settings: TelnetSettingsInput
): TelnetTarget[] {
  if (!derived.enabled) {
    return [];
  }
  const enableCommands = [...settings.enableCommands];
  return derived.endpoints.map(endpoint => {
    const host = settings.host.trim() || endpoint.host || '127.0.0.1';
    return {
      key: `${host}:${endpoint.port}`,
      label: endpoint.component,
      component: endpoint.component,
      host,
      port: endpoint.port,
      password: settings.password,
      enableCommands
    };
  });
}

/**
 * telnet 目标读取(消费口,extension 接线处):派生可用走派生半;显式端口
 * 「自定义目标」是 settings 半(旧路径即其实现)、显式 telnet.configXmlPath
 * (旧路径优先读该文件,派生半不读此设置,见函数内审核注)与密码保护且
 * settings 未覆盖密码时回落旧路径——旧路径读同一份配置文件,端口与派生
 * 一致,仅密码来源不同(保留「settings || 元件 xml || defaults」链,telnet
 * 面板既有行为);派生不可用/失败亦回退旧路径,不假称派生、不静默空列。
 */
export function readDerivedTelnetTargets(): TelnetTarget[] {
  // 派生按代缓存;消费面只读缓存不阻塞宿主。首取未就绪(激活后、首次扫描
  // 前)顺手触发一次派生(幂等、共享单次在途),下一轮探测即用派生结果。
  void ensureConfigDerivedScanRoot().catch(() => {
    // 派生失败/门未接线:消费面已按状态回退旧路径,不因触发而崩。
  });
  const state = getConfigDerivedScanRootState();
  if (!state || !state.ok) {
    return readTelnetTargetsFromSettings();
  }
  const settings = readTelnetSettings();
  const derived = state.telnet;
  // 审核发现:显式 telnet.configXmlPath 时旧路径优先读**该文件**,派生半却
  // 走 assetsRoot/发现链不读此设置——两半端口/密码会分叉。配置了就回旧路径。
  const explicitConfigXml = vscode.workspace
    .getConfiguration('kbengine')
    .get<string>('telnet.configXmlPath', '')
    .trim();
  if (
    settings.port > 0 ||
    explicitConfigXml.length > 0 ||
    (settings.password === '' && derived.endpoints.some(ep => ep.passwordSet))
  ) {
    // 显式端口「自定义目标」(settings 半)+ 密码保护未覆盖:旧路径保留
    // xml/defaults 明文密码(派生端点只带 passwordSet 布尔,不回显明文)。
    return readTelnetTargetsFromSettings();
  }
  return buildDerivedTelnetTargets(derived, settings);
}
