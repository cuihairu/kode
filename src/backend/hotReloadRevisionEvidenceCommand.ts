/**
 * revision 证据的展示入口(IDE-REV-027,原 IDE-HOT-008):从真实发送结果
 * 出发,逐 (目标,文件) 渲染三类证据、各自点名来源——fileHash(本地对
 * 当前文件内容 sha256 重算)/semanticHash(.def 结构语义指纹,注释空白
 * 不影响)/engineDigest(运行时回执报告的 digest,会话证据册按回显归
 * 属)。跨类不比较:本地哈希不冒充运行时证据,值巧合相同也不判「一致」;
 * 同类值比对是协议内验证手段,不在此面做。缺的种类不填空:内容读不到
 * 就没有 fileHash/semanticHash,运行时没回执过就没有 engineDigest,各
 * 自如实缺席。
 */

import { createHash } from 'crypto';

import { summarizeHotReloadBatch } from './hotReloadBatchSummary';
import {
  formatRevisionEvidenceReport,
  makeRevisionEvidence,
  type HotReloadEngineDigestRegister,
  type HotReloadRevisionEvidenceKind,
  type HotReloadRevisionEvidence
} from './hotReloadRevisionEvidence';
import { structuralFingerprintHash } from './hotReloadDefStructure';
import type { HotReloadTargetStateStore } from './hotReloadTargetState';

/** 本地 fileHash:当前内容 UTF-8 sha256(现成原语,与 applied 核验同源) */
export const localFileHash = (content: string): string =>
  createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

/** semanticHash:.def 有结构语义指纹才成证据;其他文件/解析不了=null 如实缺 */
export const semanticHashOf = (file: string, content: string): string | null =>
  file.toLowerCase().endsWith('.def') ? structuralFingerprintHash(content) : null;

/** 逐文件证据装配:只装实际有的种类(缺的不填空) */
export const collectRevisionEvidences = (
  file: string,
  content: string | null,
  engineDigest: string | null,
  engineDigestAt: number | null
): Partial<Record<HotReloadRevisionEvidenceKind, HotReloadRevisionEvidence>> => {
  const evidences: Partial<Record<HotReloadRevisionEvidenceKind, HotReloadRevisionEvidence>> = {};
  if (content !== null) {
    evidences.fileHash = makeRevisionEvidence(
      'fileHash',
      localFileHash(content),
      '本地 sha256 重算(当前文件内容)'
    );
    const semantic = semanticHashOf(file, content);
    if (semantic !== null) {
      evidences.semanticHash = makeRevisionEvidence(
        'semanticHash',
        semantic,
        'def 结构指纹(属性/方法签名面,注释/空白不影响)'
      );
    }
  }
  if (engineDigest !== null && engineDigestAt !== null) {
    evidences.engineDigest = makeRevisionEvidence(
      'engineDigest',
      engineDigest,
      `最近一次发送回执(${new Date(engineDigestAt).toISOString()})`
    );
  }
  return evidences;
};

/** 展示面注入:落日志块 + 打开通道;测试用假体同形 */
export interface HotReloadRevisionEvidenceView {
  logBlock(text: string): void;
  show(): void;
}

export interface HotReloadRevisionEvidenceCommandDeps {
  /** 所发文件现内容读取(与 fire 路径 digest 基准同一通道);读不到=null */
  readFileContent(file: string): Promise<string | null>;
  /** 引擎 digest 证据册(运行时回执报告面) */
  readonly digests: HotReloadEngineDigestRegister;
}

/** 命令体:台账逐目标逐文件渲染证据报告;空台账如实无投递记录 */
export async function runHotReloadRevisionEvidenceCommand(
  store: HotReloadTargetStateStore,
  deps: HotReloadRevisionEvidenceCommandDeps,
  view: HotReloadRevisionEvidenceView
): Promise<void> {
  const summary = summarizeHotReloadBatch(store);
  if (summary.status === 'no-targets') {
    view.logBlock('revision 证据:无投递记录,没有可查看的文件');
    view.show();
    return;
  }
  const blocks: string[] = ['revision 证据(来源逐条标注,跨类不比较、不互相冒充):'];
  for (const target of summary.targets) {
    for (const view0 of target.files) {
      const content = await Promise.resolve(deps.readFileContent(view0.file)).catch(() => null);
      const record = deps.digests.receipt(target.key, view0.file);
      const evidences = collectRevisionEvidences(
        view0.file,
        content,
        record ? record.digest : null,
        record ? record.at : null
      );
      blocks.push(`${target.keyId} ${view0.file} → ${view0.outcome}`);
      blocks.push(formatRevisionEvidenceReport(evidences));
    }
  }
  view.logBlock(blocks.join('\n'));
  view.show();
}
