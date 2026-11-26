// RW-REFS-001: `kbengine.findReferencesRW` — read/write/delete grouped
// references for Python. Two faces share the pure classifier in
// rwReferencesCore:
//   ① key families (dataDict / spaceData / cellData) reuse the existing
//      resolvers and their site kinds — no second resolver chain;
//   ② ordinary symbols align the public `executeReferenceProvider` locations
//      with per-file `executeDocumentHighlightProvider` ranges.
//
// Nothing here changes the built-in Shift+F12 provider, forks Pyright, or
// depends on Pylance private APIs. All symbol/key comparisons are exact
// (case-sensitive); the module contains no case folding.

import * as vscode from 'vscode';
import {
  RW_HIGHLIGHT_READ,
  RW_HIGHLIGHT_WRITE,
  alignRwReferences,
  boundRwCode,
  classifyRwKeySite,
  countRwGroups,
  groupRwSites,
  isCancelled,
  rwSymbolAt,
  shouldYieldBetweenFiles,
  type RwCancellationTokenLike,
  type RwGroupCounts,
  type RwGroups,
  type RwHighlightLike,
  type RwRangeLike,
  type RwReferenceLike,
  type RwSite,
  type RwSourceSite
} from './backend/rwReferencesCore';
import { l10nText } from './nlsRuntime';
import { isKeyInsideLineComment } from './globalDataIndex';
import { resolveDataDictSitesAtPosition, resolveSpaceDataSitesAtPosition } from './languageProviders/pythonDefinition';
import { isSpaceDataIndexEnabled } from './spaceDataIndex';
import {
  cellDataKeyAccessAtPosition,
  isCellDataKeyInsideLineComment,
  scanCellDataKeyAccesses
} from './backend/cellDataKeyAccess';
import {
  cellScriptRoleAndEntity,
  collectCellDataDefUniverseWithCategory,
  fetchCellDataKeys
} from './backend/cellDataCompletion';
import { findDefinitionFileByCategory, findEntityScriptFile } from './definitionWorkspace';
import { readFileSyncUtf8Recorded } from './backend/fileReadMetrics';
import * as path from 'path';

export const RW_REFERENCES_COMMAND = 'kbengine.findReferencesRW';

/** Minimal vscode surface used by the command, injected for tests. */
export interface RwVscodeApi {
  window: {
    activeTextEditor?: { document: RwDocumentLike } | undefined;
    showQuickPick(
      items: readonly RwQuickPickItem[],
      options: { placeHolder: string; matchOnDetail?: boolean; ignoreFocusOut?: boolean }
    ): Thenable<RwQuickPickItem | undefined>;
    showInformationMessage(message: string): Thenable<unknown>;
    showTextDocument(
      uri: unknown,
      options?: {
        preview?: boolean;
        /** vscode TextDocumentShowOptions.selection (Range-shaped object). */
        selection?: unknown;
      }
    ): Thenable<unknown>;
  };
  commands: {
    executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  };
  workspace: {
    openTextDocument(uri: unknown): Thenable<{ getText(): string; lineAt(line: number): { text: string } }>;
  };
  Uri: { file(filePath: string): unknown };
  QuickPickItemKind: { Separator: number };
  languages?: unknown;
}

export interface RwDocumentLike {
  uri: unknown;
  fileName: string;
  languageId: string;
  version: number;
  isClosed?: boolean;
  getText(): string;
  lineAt(line: number): { text: string };
}

export interface RwQuickPickItem {
  label: string;
  kind?: number;
  description?: string;
  detail?: string;
  /** Navigation target; separators have none. */
  target?: { file: string; line: number; character: number };
}

export interface RwCommandDeps {
  vscode: RwVscodeApi;
  /** Shared GlobalDataDictIndex from core services (key-family face). */
  dataDictIndex?: unknown;
  token?: RwCancellationTokenLike;
  /** Test seam for the main-thread yield (>50 files, every 10). */
  yieldToHost?: () => Promise<void>;
}

export interface RwCommandResult {
  picked?: RwQuickPickItem;
  groups: RwGroups;
  counts: RwGroupCounts;
  /** Symbol/title shown in the QuickPick placeholder. */
  heading: string;
  /** True when neither face resolved and the info message was shown. */
  noFace: boolean;
}

type SiteResolver = {
  key: string;
  sites: RwSourceSite[];
  /** General-symbol face already aligned/classified; key face is classified here. */
  classified?: RwSite[];
};

function lineOf(document: RwDocumentLike, line: number): string {
  try {
    return document.lineAt(line).text;
  } catch {
    return (document.getText().split(/\r?\n/)[line] ?? '');
  }
}

/** Resolve the dataDict / spaceData / cellData key family at the cursor. */
async function resolveKeyFamilySites(
  deps: RwCommandDeps,
  document: RwDocumentLike,
  position: { line: number; character: number }
): Promise<SiteResolver | null> {
  const api = deps.vscode;
  const token = deps.token;

  try {
    const hit = await resolveDataDictSitesAtPosition(
      deps.dataDictIndex as never,
      document as never,
      position as never,
      token as never
    );
    if (hit && !isKeyInsideLineComment(document.lineAt(position.line).text, hit.access.keyStart)) {
      const sites: RwSourceSite[] = [];
      for (const site of hit.sites) {
        if (isCancelled(token)) { break; }
        sites.push({
          file: site.file,
          line: site.line,
          character: site.keyStart,
          kind: site.kind
        });
      }
      return { key: hit.access.keySignature ?? '', sites };
    }
  } catch {
    // Resolver unavailable: continue to the next family.
  }
  if (isCancelled(token)) { return null; }

  try {
    if (isSpaceDataIndexEnabled()) {
      const spaceHit = await resolveSpaceDataSitesAtPosition(document as never, position as never, token as never);
      if (spaceHit) {
        const sites: RwSourceSite[] = spaceHit.sites.map(site => ({
          file: site.file,
          line: site.line,
          character: site.keyStart,
          kind: site.fn === 'setSpaceData' ? 'write' : site.fn === 'delSpaceData' ? 'delete' : 'read'
        }));
        return { key: spaceHit.call.keySignature ?? '', sites };
      }
    }
  } catch {
    // Resolver unavailable: continue to the next family.
  }
  if (isCancelled(token)) { return null; }

  try {
    const cellLine = document.lineAt(position.line).text;
    const cellHit = cellDataKeyAccessAtPosition(cellLine, position.character);
    if (cellHit && !isCellDataKeyInsideLineComment(cellLine, cellHit.keyStart)) {
      const role = cellScriptRoleAndEntity(document.fileName);
      if (role) {
        const defs = collectCellDataDefUniverseWithCategory(role.entity, (name, category) => {
          const filePath = findDefinitionFileByCategory(name, category, document as never);
          if (!filePath) { return null; }
          try {
            return readFileSyncUtf8Recorded(filePath);
          } catch {
            return null;
          }
        });
        const keys = await fetchCellDataKeys(role.entity, defs);
        if (!isCancelled(token) && keys && keys.some(entry => entry.key === cellHit.key)) {
          const scriptPath = findEntityScriptFile(role.entity, role.role, document as never);
          if (scriptPath) {
            const sameFile = path.resolve(scriptPath) === path.resolve(document.fileName);
            const scriptText = sameFile ? document.getText() : readFileSyncUtf8Recorded(scriptPath);
            return {
              key: cellHit.key,
              sites: scanCellDataKeyAccesses(scriptText)
                .filter(site => site.key === cellHit.key)
                .map(site => ({ file: scriptPath, line: site.line, character: site.keyStart }))
            };
          }
        }
      }
    }
  } catch {
    // No cellData universe: not a cellData key.
  }
  // `api` stays referenced here so mock-based callers can assert no extra
  // provider calls happen for the key-family face.
  void api;
  return null;
}

function toRwRange(value: unknown): RwRangeLike | null {
  const range = value as { start?: { line: number; character: number }; end?: { line: number; character: number } } | undefined;
  if (!range?.start || !range.end) { return null; }
  return { start: range.start, end: range.end };
}

function fileOfUri(uri: unknown): string {
  const candidate = uri as { fsPath?: string; path?: string } | undefined;
  return candidate?.fsPath ?? candidate?.path ?? '';
}

/**
 * General symbol face: public reference provider for locations plus per-file
 * document highlights for Read/Write/Text. Highlight alignment is by exact
 * line/character ranges and exact symbol spelling.
 */
async function resolveGeneralSymbolSites(
  deps: RwCommandDeps,
  document: RwDocumentLike,
  position: { line: number; character: number }
): Promise<SiteResolver | null> {
  const api = deps.vscode;
  const token = deps.token;
  // Cursor may sit mid-word; use the word containing the cursor, not the
  // remainder of the line (slicing at the cursor would turn Hero into ro).
  const symbol = rwSymbolAt(lineOf(document, position.line), position.character);
  if (!symbol) { return null; }

  let referenceValue: unknown;
  try {
    referenceValue = await api.commands.executeCommand(
      'vscode.executeReferenceProvider',
      document.uri,
      position as never,
      { includeDeclaration: true }
    );
  } catch {
    return null;
  }
  if (isCancelled(token)) { return null; }
  if (!Array.isArray(referenceValue) || referenceValue.length === 0) { return null; }

  const references: RwReferenceLike[] = [];
  for (const raw of referenceValue) {
    const loc = raw as { uri?: unknown; range?: unknown; targetUri?: unknown; targetRange?: unknown };
    const uri = loc?.uri ?? loc?.targetUri;
    const range = toRwRange(loc?.range ?? loc?.targetRange);
    if (!uri || !range) { continue; }
    references.push({ file: fileOfUri(uri), range, });
  }
  if (references.length === 0) { return null; }

  const byFile = new Map<string, RwReferenceLike[]>();
  for (const reference of references) {
    const bucket = byFile.get(reference.file) ?? [];
    bucket.push(reference);
    byFile.set(reference.file, bucket);
  }
  const highlightSources: RwHighlightLike[] = [];
  const fileNames = [...byFile.keys()];
  const yieldNow = deps.yieldToHost ?? (() => new Promise<void>(resolve => setImmediate(resolve)));
  for (let index = 0; index < fileNames.length; index += 1) {
    if (isCancelled(token)) { return null; }
    if (shouldYieldBetweenFiles(index, fileNames.length)) { await yieldNow(); }
    const file = fileNames[index];
    let highlights: unknown;
    try {
      highlights = await api.commands.executeCommand(
        'vscode.executeDocumentHighlightProvider',
        api.Uri.file(file),
        byFile.get(file)![0].range.start as never
      );
    } catch {
      highlights = undefined;
    }
    if (isCancelled(token)) { return null; }
    if (!Array.isArray(highlights)) { continue; }
    for (const raw of highlights) {
      const item = raw as { range?: unknown; kind?: number };
      const range = toRwRange(item?.range);
      if (!range) { continue; }
      highlightSources.push({
        file,
        range,
        kind: typeof item.kind === 'number' ? item.kind : 0
      });
    }
  }

  const texts = new Map<string, string>();
  for (let index = 0; index < fileNames.length; index += 1) {
    if (isCancelled(token)) { return null; }
    if (shouldYieldBetweenFiles(index, fileNames.length)) { await yieldNow(); }
    const file = fileNames[index];
    texts.set(file, await readWholeFile(api, file));
  }
  const sites = alignRwReferences(references, highlightSources, texts, symbol);
  return sites.length > 0
    ? {
      key: symbol,
      sites: sites.map(site => ({
        file: site.file,
        line: site.line,
        character: site.character,
        code: site.code,
        symbol
      })),
      classified: sites
    }
    : null;
}

async function readWholeFile(api: RwVscodeApi, file: string): Promise<string> {
  try {
    const opened = await api.workspace.openTextDocument(api.Uri.file(file));
    return opened.getText();
  } catch {
    try {
      return readFileSyncUtf8Recorded(file);
    } catch {
      return '';
    }
  }
}

function buildQuickPickItems(
  groups: RwGroups,
  counts: RwGroupCounts
): RwQuickPickItem[] {
  const items: RwQuickPickItem[] = [];
  const groupDefs: Array<{ name: keyof RwGroups; label: string; marker: string }> = [
    { name: 'write', label: l10nText('WRITE'), marker: '' },
    { name: 'read', label: l10nText('READ'), marker: '' },
    { name: 'delete', label: l10nText('DELETE'), marker: '' }
  ];
  for (const def of groupDefs) {
    const sites = groups[def.name];
    if (sites.length === 0) { continue; }
    items.push({
      label: `${def.label} (${sites.length})`,
      kind: depsQuickPickSeparator()
    });
    for (const site of sites) {
      items.push({
        // Ticket §3: label carries file:line (plus the ⇄ dual marker),
        // detail carries the bounded code excerpt.
        label: `${site.dual ? '⇄ ' : ''}${site.file}:${site.line + 1}`,
        detail: site.code,
        target: { file: site.file, line: site.line, character: site.character }
      });
    }
  }
  void counts;
  return items;
}

let quickPickSeparatorOverride: (() => number) | undefined;
function depsQuickPickSeparator(): number {
  return quickPickSeparatorOverride?.() ?? -1;
}

/** Testable command body. Pass the vscode API object explicitly. */
export async function runFindReferencesRW(deps: RwCommandDeps): Promise<RwCommandResult> {
  const api = deps.vscode;
  const document = api.window.activeTextEditor?.document;
  if (!document || isCancelled(deps.token)) {
    const heading = l10nText('No active Python editor');
    api.window.showInformationMessage(l10nText('No readable reference face at the cursor'));
    return emptyResult(heading);
  }
  const position = { line: 0, character: 0 };
  const editorPosition = api.window.activeTextEditor as { selection?: { active?: { line: number; character: number } } } | undefined;
  if (editorPosition?.selection?.active) {
    position.line = editorPosition.selection.active.line;
    position.character = editorPosition.selection.active.character;
  }

  const keyHit = await resolveKeyFamilySites(deps, document, position);
  const generalHit = keyHit ? null : await resolveGeneralSymbolSites(deps, document, position);
  const hit = keyHit ?? generalHit;
  if (!hit) {
    const heading = l10nText('No readable reference face at the cursor');
    api.window.showInformationMessage(heading);
    return emptyResult(heading);
  }

  const classified: RwSite[] = hit.classified !== undefined ? hit.classified.map(site => ({ ...site })) : [];
  if (keyHit) {
    for (const raw of hit.sites) {
      if (isCancelled(deps.token)) { break; }
      const allTexts = await readWholeFile(api, raw.file);
      const lineText = (allTexts.split(/\r?\n/)[raw.line] ?? '');
      classified.push(classifyRwKeySite({ ...raw, code: boundRwCode(lineText) }, lineText));
    }
  }
  const groups = groupRwSites(classified);
  const counts = countRwGroups(groups);
  const heading = l10nText('{symbol} — {total} references (write {write} / read {read} / delete {delete})', {
    symbol: hit.key,
    total: counts.total,
    write: counts.write,
    read: counts.read,
    delete: counts.delete
  });
  const items = buildQuickPickItems(groups, counts);
  const picked = items.length > 0
    ? await api.window.showQuickPick(items, {
      placeHolder: heading,
      matchOnDetail: true,
      ignoreFocusOut: true
    })
    : undefined;
  if (picked?.target) {
    // Jump to the referenced line, not just the file head.
    await api.window.showTextDocument(api.Uri.file(picked.target.file), {
      preview: false,
      selection: {
        start: { line: picked.target.line, character: picked.target.character },
        end: { line: picked.target.line, character: picked.target.character }
      }
    });
  }
  return { picked, groups, counts, heading, noFace: false };
}

function emptyResult(heading: string): RwCommandResult {
  return {
    groups: { write: [], read: [], delete: [] },
    counts: { write: 0, read: 0, delete: 0, total: 0 },
    heading,
    noFace: true
  };
}

/** Register the command on the real vscode API (composition root only). */
export function registerRwReferencesCommand(
  context: vscode.ExtensionContext,
  dataDictIndex?: unknown
): vscode.Disposable {
  quickPickSeparatorOverride = () => vscode.QuickPickItemKind.Separator;
  const disposable = vscode.commands.registerCommand(RW_REFERENCES_COMMAND, async (token?: RwCancellationTokenLike) => {
    const api: RwVscodeApi = {
      window: {
        get activeTextEditor() { return vscode.window.activeTextEditor as never; },
        showQuickPick: (items, options) => vscode.window.showQuickPick(items as never, options as never) as never,
        showInformationMessage: message => vscode.window.showInformationMessage(message) as never,
        showTextDocument: (uri, options) => vscode.window.showTextDocument(uri as never, options as never) as never
      },
      commands: {
        executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args) as never
      },
      workspace: {
        openTextDocument: uri => vscode.workspace.openTextDocument(uri as never) as never
      },
      Uri: vscode.Uri,
      QuickPickItemKind: vscode.QuickPickItemKind
    };
    return runFindReferencesRW({ vscode: api, dataDictIndex, token });
  });
  context.subscriptions.push(disposable);
  return disposable;
}

// Re-export highlight constants so tests can build aligned fake highlights.
export { RW_HIGHLIGHT_READ, RW_HIGHLIGHT_WRITE };
