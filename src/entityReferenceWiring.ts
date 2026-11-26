// KODE-IDXREL-001 (KBE-PY-031) wiring layer: publishes cached-entity-reference
// findings to a self-held diagnostic collection. The analysis itself is a
// pure, single-file function in src/backend/entityReferenceTracking.ts.
//
// This intentionally does NOT join buildTrapDiagnosticItems: the Rust trap
// response surface only recognizes three codes and would discard KBE-PY-031
// findings whenever the shadow gate is active. Same bypass pattern as the
// per-rule collections in trapDiagnosticsWiring.ts, but a dedicated collection
// so the exact extension.test.ts registration list stays explicit.
//
// Toggle: kbengine.entityReferenceCacheDiagnostics (read on each document
// event; next-event applies, no configuration subscription — same as the
// trap rules). A disabled toggle clears the collection first.
// Document events: open => immediate, change => queued with macro-task flush,
// close => release + delete. Python language only.

import * as vscode from 'vscode';
import { DiagnosticScheduler } from './backend/diagnosticScheduler';
import { resolveEntityComponentFaceFromPath } from './backend/entityBuiltinProperties';
import {
  analyzeEntityReferenceHolders,
  buildEntityReferenceCacheFix,
  ENTITY_REFERENCE_CACHE_CODE,
  ENTITY_REFERENCE_CACHE_DIAGNOSTICS_ENABLED_DEFAULT
} from './backend/entityReferenceTracking';
import type { EntityMappingManager } from './entityMapping';

/** Self-held collection name (extension.test.ts exact-order registration list) */
export const ENTITY_REFERENCE_CACHE_DIAGNOSTIC_COLLECTION = 'kbengine-entity-reference-cache';

const QUICK_FIX_TITLE = 'Store the entity id (update downstream reads too)';

/** Pure item shape for tests (no vscode required) */
export interface EntityReferenceCacheDiagnosticItem {
  line: number;
  character: number;
  length: number;
  message: string;
}

/** Pure compute surface: text -> diagnostic items (toggle consumed by the caller) */
export function buildEntityReferenceCacheItems(text: string): EntityReferenceCacheDiagnosticItem[] {
  return analyzeEntityReferenceHolders(text).map(finding => ({
    line: finding.line,
    character: finding.character,
    length: finding.length,
    message: finding.message
  }));
}

async function resolveEntityScriptFace(
  manager: EntityMappingManager,
  fileName: string
): Promise<boolean> {
  if (resolveEntityComponentFaceFromPath(fileName)) {
    return true;
  }
  try {
    const faces = await manager.getEntityComponentFacesForPythonFile(fileName);
    return Array.isArray(faces) && faces.length > 0;
  } catch {
    return false;
  }
}

export function wireEntityReferenceCacheDiagnostics(
  context: vscode.ExtensionContext,
  entityMappingManager: EntityMappingManager
): void {
  const collection = vscode.languages.createDiagnosticCollection(ENTITY_REFERENCE_CACHE_DIAGNOSTIC_COLLECTION);
  context.subscriptions.push(collection);
  const scheduler = new DiagnosticScheduler();

  const schedule = async (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): Promise<void> => {
    if (document.languageId !== 'python') {
      collection.delete(document.uri);
      return;
    }
    const enabled = vscode.workspace.getConfiguration('kbengine')
      .get<boolean>('entityReferenceCacheDiagnostics', ENTITY_REFERENCE_CACHE_DIAGNOSTICS_ENABLED_DEFAULT);
    if (!enabled || !(await resolveEntityScriptFace(entityMappingManager, document.fileName))) {
      collection.delete(document.uri);
      return;
    }
    const items = buildEntityReferenceCacheItems(document.getText());
    const options = {
      layer: 'local' as const,
      compute: () => items,
      publish: (published: readonly EntityReferenceCacheDiagnosticItem[]): void => {
        collection.set(document.uri, published.map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(item.line, item.character, item.line, item.character + item.length),
            item.message,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = 'kbengine';
          diagnostic.code = ENTITY_REFERENCE_CACHE_CODE;
          return diagnostic;
        }));
      }
    };
    if (channel === 'queued') {
      scheduler.requestQueued(document, options);
    } else {
      scheduler.request(document, options);
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => { void schedule(document, 'immediate'); }),
    vscode.workspace.onDidChangeTextDocument(event => { void schedule(event.document, 'queued'); }),
    vscode.workspace.onDidCloseTextDocument(document => {
      collection.delete(document.uri);
      scheduler.releaseDocument(document);
    })
  );
  // Same macro-task flush cadence as the main diagnostics chain; this wiring
  // owns its own timer so it does not require changes in extension.ts.
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(() => {
    if (flushTimer !== undefined) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void scheduler.flushQueued();
    }, 0);
  }));

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: 'python', scheme: 'file' },
      new EntityReferenceCacheCodeActionProvider()
    )
  );
}

/** Quick fix provider: direct assignment -> store entity.id, leaving downstream reads alone */
export class EntityReferenceCacheCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code !== ENTITY_REFERENCE_CACHE_CODE) {
        continue;
      }
      const line = diagnostic.range.start.line;
      const lineText = document.lineAt(line).text;
      const match = /^\s*self\.([A-Za-z_]\w*)\s*=/.exec(lineText);
      const replacement = buildEntityReferenceCacheFix(lineText, match?.[1]);
      if (!replacement) {
        continue;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.set(document.uri, [
        new vscode.TextEdit(
          new vscode.Range(line, 0, line, lineText.length),
          replacement
        )
      ]);
      const action = new vscode.CodeAction(QUICK_FIX_TITLE, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.edit = edit;
      actions.push(action);
    }
    return actions;
  }
}
