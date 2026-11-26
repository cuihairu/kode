/**
 * Display entry for revision evidence (IDE-REV-027, formerly IDE-HOT-008):
 * starting from the real send results, renders three kinds of evidence per
 * (target, file), each naming its source -- fileHash (a local sha256
 * recomputation over the current file content) / semanticHash (the .def
 * structural semantic fingerprint; comments and whitespace do not affect it)
 * / engineDigest (the digest reported by the runtime receipt, attributed in
 * the session evidence register by the echo). Kinds are never compared
 * across categories: a local hash never masquerades as runtime evidence, and
 * a coincidental match of values is never judged "identical"; comparing
 * same-kind values is an in-protocol verification means and is not done on
 * this surface. Missing kinds are left empty rather than padded: if the
 * content cannot be read there is no fileHash/semanticHash, and if the
 * runtime never returned a receipt there is no engineDigest -- each is
 * honestly absent.
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

/** Local fileHash: UTF-8 sha256 of the current content (an off-the-shelf primitive, same origin as the applied verification) */
export const localFileHash = (content: string): string =>
  createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

/** semanticHash: only a .def with a structural semantic fingerprint becomes evidence; other files / unparseable content = null, honestly absent */
export const semanticHashOf = (file: string, content: string): string | null =>
  file.toLowerCase().endsWith('.def') ? structuralFingerprintHash(content) : null;

/** Per-file evidence assembly: only the kinds that actually exist are assembled (missing ones are not padded) */
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

/** Display-surface injection: log-block sink + open channel; tests use fakes of the same shape */
export interface HotReloadRevisionEvidenceView {
  logBlock(text: string): void;
  show(): void;
}

export interface HotReloadRevisionEvidenceCommandDeps {
  /** Read of the sent file's current content (the same channel as the fire-path digest baseline); unreadable = null */
  readFileContent(file: string): Promise<string | null>;
  /** Engine digest evidence register (the runtime receipt reporting surface) */
  readonly digests: HotReloadEngineDigestRegister;
}

/** Command body: renders the evidence report target by target and file by file from the ledger; an empty ledger honestly means no delivery records */
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
