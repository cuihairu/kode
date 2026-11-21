// QA-001b(2026-11-22):Proxy 会话语义检查面(两个分歧臂,判例源
// docs/knowledge/proxy-session-semantics.md §4/§6,引擎头 55a66552):
//   - onLogOnAttempt 返回值矩阵:switch 仅 LOG_ON_ACCEPT 有独立分支(接管+
//     重建代理链);LOG_ON_WAIT_FOR_DESTROY 与 default 同支(baseapp.cpp:
//     4020-4021)→ loginBaseappFailed(SERVER_ERR_ACCOUNT_IS_ONLINE)=实际效果
//     同拒绝。脚本真正能稳定依赖的只有 accept/reject;返回 WAIT_FOR_DESTROY
//     是依赖未落地理想语义的分歧臂 → 报;
//   - giveClientTo 五前置校验边界:源已销毁/源无客户端/目标已销毁/目标是
//     自己/目标已有客户端,失败触发 onGiveClientToFailure(非迁移中途网络
//     失败)。可证形态=目标是自己(`giveClientTo(self)`)→ 前置校验必败 → 报;
//     其余四前置非静态可证 → 不猜。
//
// 只对 baseapp 实体脚本(Proxy 会话域)接管;面不明/非 baseapp 零产出(普通
// Python 类与 cellapp/client 不猜)。纯逻辑层,不 import vscode;Rust 面本族
// 未收编(收编归后续批)。

import { maskPythonNonCode } from './pythonLexicalMask';
import { l10nText } from '../nlsRuntime';
import type { EntityComponentFace } from './entityBuiltinProperties';

export const PROXY_SESSION_DIAGNOSTIC_CODE = 'kbengine.proxySessionSemantics';
export const PROXY_SESSION_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 一处 Proxy 会话语义发现(诊断面所需最小信息) */
export interface ProxySessionFinding {
  /** 行(0 起) */
  line: number;
  /** 起始列(0 起) */
  character: number;
  /** 高亮长度 */
  length: number;
  kind: 'logon-attempt-wait-for-destroy' | 'give-client-to-self';
  message: string;
}

/**
 * 臂 1 消息:WAIT_FOR_DESTROY 未落地为独立排队流程,实际同拒绝。
 */
export function renderLogOnAttemptWaitForDestroyMessage(): string {
  return l10nText(
    'onLogOnAttempt returns LOG_ON_WAIT_FOR_DESTROY: the current engine does not implement a queued-login flow for this value (baseapp.cpp:4020-4021 shares the default branch, effectively a rejection); only LOG_ON_ACCEPT / LOG_ON_REJECT are stable return values'
  );
}

/**
 * 臂 2 消息:目标是自己 = 前置校验必败。
 */
export function renderGiveClientToSelfMessage(): string {
  return l10nText(
    'giveClientTo(self): the caller itself is the target, a giveClientTo pre-check violation (the engine raises onGiveClientToFailure for this, not a mid-migration network failure)'
  );
}

/**
 * Proxy 会话语义判定(纯函数):两分歧臂可证形态。
 * faces 由调用方提供(getEntityComponentFacesForPythonFile);只含 baseapp
 * 才接管(Proxy 会话域),面不明(null/空)或非 baseapp → 零产出。
 */
export function findProxySessionFindings(
  text: string,
  faces: readonly EntityComponentFace[] | null
): ProxySessionFinding[] {
  if (!faces?.includes('baseapp')) {
    return [];
  }
  const masked = maskPythonNonCode(text);
  const lines = masked.split(/\r?\n/);
  const findings: ProxySessionFinding[] = [];

  // 臂 1:onLogOnAttempt 方法体内 return 引用 LOG_ON_WAIT_FOR_DESTROY。
  // 方法边界=缩进回落(逐方法定位,不跨方法误报)。
  for (let i = 0; i < lines.length; i += 1) {
    const defMatch = /^\s*def\s+onLogOnAttempt\s*\(/.exec(lines[i]);
    if (!defMatch) {
      continue;
    }
    const defIndent = (defMatch[0].match(/^\s*/) ?? [''])[0].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (/^\s*$/.test(line)) {
        continue;
      }
      const indent = (line.match(/^\s*/) ?? [''])[0].length;
      if (indent <= defIndent) {
        break;
      }
      if (/return\s+.*\bLOG_ON_WAIT_FOR_DESTROY\b/.test(line)) {
        const column = line.indexOf('LOG_ON_WAIT_FOR_DESTROY');
        findings.push({
          line: j,
          character: column,
          length: 'LOG_ON_WAIT_FOR_DESTROY'.length,
          kind: 'logon-attempt-wait-for-destroy',
          message: renderLogOnAttemptWaitForDestroyMessage()
        });
      }
    }
  }

  // 臂 2:giveClientTo(self)(目标是自己,任一接收者均前置校验必败)。
  const givePattern = /\bgiveClientTo\s*\(\s*self\s*\)/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = givePattern.exec(lines[i]);
    if (match) {
      findings.push({
        line: i,
        character: match.index,
        length: match[0].length,
        kind: 'give-client-to-self',
        message: renderGiveClientToSelfMessage()
      });
    }
  }
  return findings;
}

/** 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖) */
export interface ProxySessionDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/** findings → 诊断项(纯数据;test 免 vscode) */
export function proxySessionFindingsToItems(
  findings: readonly ProxySessionFinding[]
): ProxySessionDiagnosticItem[] {
  return findings.map(finding => ({
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning' as const,
    source: 'kbengine' as const,
    code: PROXY_SESSION_DIAGNOSTIC_CODE
  }));
}
