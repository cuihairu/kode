// C-17:进程拓扑定义期错配预警的 Rust 权威实现接线面——`$/kode/processTopology/validate`。
//
// 边界(镜像 defMd5Rust/databaseSchemaRust「输入收集留 TS、校验归 Rust」):清单
// 原文 + entities.xml 原文 + def 原文集合经 RPC 直传,Rust 解析清单、推导实体
// 内容(闭包)、跑 M1-M6/D1-D3/O1-O2 规则并返回定位精确的 findings。Rust 不可
// 用(无门/未配 serverPath/调用失败/形状不合规)返回 null,调用方零发现静默
// (诊断功能不阻塞,错误不出现在诊断面)。无 TS 镜像——Rust 单一实现。

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

/** Rust `$/kode/processTopology/validate` 入参(镜像 BuildParams) */
export interface ProcessTopologyRustParams {
  /** `<root>/process_topology.xml` 原文 */
  manifestText: string;
  /** `scripts/entities.xml` 原文(可选) */
  entitiesXmlText?: string;
  /** 全部 def 原文集合(实体/接口/组件,闭包走查用) */
  defs: Array<{
    name: string;
    category: string;
    filePath: string;
    text: string;
  }>;
}

/** 关联信息(relatedInformation 数据) */
export interface ProcessTopologyRelated {
  filePath: string;
  line: number;
  message: string;
}

/** 单条发现(诊断项原始数据,TS 侧只做位置映射) */
export interface ProcessTopologyFinding {
  /** "manifest" | "def" */
  target: string;
  filePath: string;
  /** 1 基行号 */
  line: number;
  /** 诊断严重级别(2=Warning) */
  severity: number;
  message: string;
  code: string;
  related?: ProcessTopologyRelated[];
}

/** Rust 输出:findings 数组 */
export interface ProcessTopologyRustResult {
  findings: ProcessTopologyFinding[];
}

/**
 * 进程拓扑校验(经 Rust):收集完成调用,返回 findings;Rust 不可用/失败/形状
 * 不合规返回 null。诊断侧对 null 做零发现处理(功能静默,不误报)。
 */
export async function validateProcessTopologyInRust(
  params: ProcessTopologyRustParams
): Promise<ProcessTopologyRustResult | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  const response = await gate.runInRust<ProcessTopologyRustResult>(
    '$/kode/processTopology/validate',
    {
      manifestText: params.manifestText,
      entitiesXmlText: params.entitiesXmlText ?? '',
      defs: params.defs
    }
  );
  if (!response.ok) {
    return null;
  }
  if (!shapeCheckProcessTopologyResult(response.result)) {
    return null;
  }
  return response.result;
}

function shapeCheckProcessTopologyResult(value: unknown): value is ProcessTopologyRustResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.findings)) {
    return false;
  }
  return result.findings.every(finding => {
    if (typeof finding !== 'object' || finding === null) {
      return false;
    }
    const item = finding as Record<string, unknown>;
    return (
      typeof item.target === 'string' &&
      typeof item.filePath === 'string' &&
      typeof item.line === 'number' &&
      typeof item.severity === 'number' &&
      typeof item.message === 'string' &&
      typeof item.code === 'string'
    );
  });
}
