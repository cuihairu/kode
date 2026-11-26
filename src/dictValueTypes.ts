// KODE-DICTTYPE-001: per-document ordinary-dict analysis cache (activation
// assembly). Same shape as the globalData dict index: sync-document on
// open/change (version-keyed), drop on close. Provider surfaces only read it
// — they never re-run a full-file analysis per hover keystroke.
import {
  analyzeDictValueTypeFile,
  queryDictValueTypeAtPosition,
  type DictValueTypeAnalysis,
  type DictValueTypeQuery,
  type DictValueKeyCompletionContext
} from './backend/dictValueTypeCore';

interface CacheEntry {
  version: number;
  analysis: DictValueTypeAnalysis;
}

/** Document-like shape accepted by the store (real TextDocument and fake stubs). */
export interface DictValueDocumentLike {
  uri: { fsPath: string };
  version: number;
  getText(): string;
}

/**
 * Ordinary-dict type index: one analysis per open document, refreshed when
 * the document version changes. No workspace-wide scan — a read is only
 * meaningful within its defining file, so cross-file lookup would be a
 * guess (documented boundary).
 */
export class DictValueTypeStore {
  private readonly entries = new Map<string, CacheEntry>();

  syncDocument(document: DictValueDocumentLike): DictValueTypeAnalysis {
    const key = document.uri.fsPath;
    const cached = this.entries.get(key);
    if (cached && cached.version === document.version) {
      return cached.analysis;
    }
    const analysis = analyzeDictValueTypeFile(document.getText(), key);
    this.entries.set(key, { version: document.version, analysis });
    return analysis;
  }

  get(document: DictValueDocumentLike): DictValueTypeAnalysis | null {
    const cached = this.entries.get(document.uri.fsPath);
    if (!cached || cached.version !== document.version) {
      return null;
    }
    return cached.analysis;
  }

  /** Position query (read key of an ordinary dict); null = not our face. */
  queryAt(
    document: DictValueDocumentLike,
    lineText: string,
    line: number,
    character: number
  ): DictValueTypeQuery | null {
    // Version-keyed sync first: a hover keystroke never re-parses an
    // unchanged document (cache hit), but a stale version can never answer.
    const analysis = this.syncDocument(document);
    return queryDictValueTypeAtPosition(analysis, lineText, line, character);
  }

  /** Resolve a completion context receiver against this document's analysis. */
  resolveReceiver(
    document: DictValueDocumentLike,
    ctx: DictValueKeyCompletionContext
  ): DictValueTypeQuery[] {
    const analysis = this.syncDocument(document);

    const container =
      ctx.receiver.startsWith('self.')
        ? (() => {
            const cls = analysis.classAtLine[ctx.line];
            return cls
              ? analysis.containers.get(`self:${cls}:${ctx.receiver}`) ?? null
              : null;
          })()
        : analysis.containers.get(`module::${ctx.receiver}`) ?? null;
    if (!container) {
      return [];
    }
    const results: DictValueTypeQuery[] = [];
    for (const entry of container.keys.values()) {
      if (!entry.key.startsWith(ctx.partial)) {
        continue;
      }
      results.push({
        container,
        entry,
        nestedKey: null,
        types: entry.types,
        frozen: container.frozen
      });
    }
    return results;
  }

  close(document: DictValueDocumentLike): void {
    this.entries.delete(document.uri.fsPath);
  }

  /** Test-only: drop all cached analyses. */
  reset(): void {
    this.entries.clear();
  }
}
