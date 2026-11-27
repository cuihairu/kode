// IDX-REL-001 wiring: `kbengine.showTypeImpact` — reverse impact panel for
// custom types. Given a types.xml/alias.xml type entry (a FIXED_DICT field
// change being the motivating case), lists every .def property whose type
// chain reaches it and the .py access points of those properties.
//
// Shape follows rwReferencesCommand: pure deps-injected orchestration tested
// without vscode; the registration wrapper binds the real vscode surface.
//
// Data sources (all existing faces, no new scans invented here):
// - declarations: getEntityCustomTypesSnapshot (watcher-maintained);
// - def edges: findFilesAcrossRoots('**/*.def') + file reads, parsed once per
//   content identity by TypeImpactIndex (editing one types.xml never reparses
//   def files — the index content-dedupes);
// - .py access points: EntityMappingManager.getIncomingPythonPropertyAccesses
//   (the cached runtime face; RUST-138 leaves this half to the TS side).

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10nText } from './nlsRuntime';
import { findFilesAcrossRoots } from './scanRoots';
import { getEntityCustomTypesSnapshot, type CustomTypeInfo } from './definitionWorkspace';
import { TypeImpactIndex, type TypeImpactEntry } from './backend/typeImpactIndex';

export const TYPE_IMPACT_COMMAND = 'kbengine.showTypeImpact';

/** Toggle default (registered in package.json) */
export const TYPE_IMPACT_ENABLED_DEFAULT = true;

/** .py access points are queried for at most this many def properties */
export const TYPE_IMPACT_PY_ACCESS_LIMIT = 32;

export interface TypeImpactQuickPickItem {
  label: string;
  kind?: number;
  description?: string;
  detail?: string;
  /** Navigation target; separators have none. */
  target?: { file: string; line: number; character: number };
}

export interface TypeImpactVscodeApi {
  window: {
    /** Editor face the command needs; the adapter precomputes the cursor word */
    activeTextEditor?: {
      fileName: string;
      /** Word under the cursor, or null (empty selection fallback done adapter-side) */
      wordAtCursor(): string | null;
    };
    showQuickPick(
      items: readonly TypeImpactQuickPickItem[],
      options: { placeHolder: string; matchOnDetail?: boolean; ignoreFocusOut?: boolean }
    ): Thenable<TypeImpactQuickPickItem | undefined>;
    showInformationMessage(message: string): Thenable<unknown>;
    showTextDocument(
      uri: unknown,
      options?: { preview?: boolean; selection?: unknown }
    ): Thenable<unknown>;
  };
  Uri: { file(filePath: string): unknown };
  QuickPickItemKind: { Separator: number };
}

export interface TypeImpactCommandDeps {
  vscode: TypeImpactVscodeApi;
  readFile(filePath: string): string | null;
  listDefFiles(): Promise<string[]>;
  getCustomTypes(): readonly CustomTypeInfo[];
  getPythonAccesses(defFile: string, propertyName: string): Promise<Array<{ filePath: string; line: number; character: number }>>;
  isEnabled(): boolean;
  /** Index seam (tests pass a fresh instance; production shares one per process) */
  index?: TypeImpactIndex;
}

export interface TypeImpactCommandResult {
  disabled?: boolean;
  /** Neither cursor nor picker produced a declared type name. */
  noTarget?: boolean;
  /** Type resolved but no def property references it (closure included). */
  noImpact?: boolean;
  heading?: string;
  picked?: TypeImpactQuickPickItem;
  items?: TypeImpactQuickPickItem[];
  defPropertyCount?: number;
  pyAccessCount?: number;
  /** True when def properties beyond TYPE_IMPACT_PY_ACCESS_LIMIT were skipped for access queries. */
  accessQueriesTruncated?: boolean;
}

export function createTypeImpactIndex(): TypeImpactIndex {
  return new TypeImpactIndex();
}

/** Shared index across command runs: def edges persist with content identity */
const sharedIndex = createTypeImpactIndex();

export async function runTypeImpactCommand(deps: TypeImpactCommandDeps): Promise<TypeImpactCommandResult> {
  if (!deps.isEnabled()) {
    await deps.vscode.window.showInformationMessage(l10nText('Type impact preview is disabled (kbengine.typeImpact.enabled).'));
    return { disabled: true };
  }

  const index = deps.index ?? sharedIndex;
  const declarations = deps.getCustomTypes();
  index.setCustomTypes(declarations);
  const declaredNames = new Set(declarations.map(info => info.name));

  const defFiles = await deps.listDefFiles();
  // Deleted def files must not leave phantom impact rows behind.
  index.retainDefFiles(new Set(defFiles));
  for (const filePath of defFiles) {
    const text = deps.readFile(filePath);
    if (text === null) {
      continue;
    }
    const entity = path.basename(filePath).replace(/\.def$/i, '');
    index.setDefFile(filePath, entity, text);
  }

  // Target resolution: cursor word on types.xml/alias.xml when it names a
  // declared custom type, else a picker over the declared names.
  let target: string | null = null;
  const editor = deps.vscode.window.activeTextEditor;
  if (editor) {
    const base = path.basename(editor.fileName).toLowerCase();
    if ((base === 'types.xml' || base === 'alias.xml') && editor.wordAtCursor()) {
      const word = editor.wordAtCursor() as string;
      if (declaredNames.has(word)) {
        target = word;
      }
    }
  }
  if (!target) {
    const names = [...declaredNames].sort((left, right) => left.localeCompare(right));
    if (names.length === 0) {
      await deps.vscode.window.showInformationMessage(l10nText('No custom type declarations found (types.xml / alias.xml).'));
      return { noTarget: true };
    }
    const picked = await deps.vscode.window.showQuickPick(
      names.map(name => ({ label: name })),
      { placeHolder: l10nText('Select the custom type to inspect'), matchOnDetail: false, ignoreFocusOut: true }
    );
    if (!picked) {
      return { noTarget: true };
    }
    target = picked.label;
  }

  const heading = l10nText('Impact of {type}', { type: target });
  const entries = index.impactOf(target);
  if (entries.length === 0) {
    await deps.vscode.window.showInformationMessage(l10nText('No .def property references {type}.', { type: target }));
    return { heading, noImpact: true };
  }

  // .py access points per affected property (cached runtime face), capped.
  const accessEntries: TypeImpactEntry[] = entries.slice(0, TYPE_IMPACT_PY_ACCESS_LIMIT);
  const accessLists = await Promise.all(
    accessEntries.map(entry => deps.getPythonAccesses(entry.filePath, entry.property))
  );
  const pyAccesses: Array<{ filePath: string; line: number; character: number; property: string }> = [];
  accessLists.forEach((list, position) => {
    for (const access of list) {
      pyAccesses.push({ ...access, property: accessEntries[position].property });
    }
  });

  const items: TypeImpactQuickPickItem[] = [];
  items.push({ label: l10nText('Def properties ({count})', { count: entries.length }), kind: deps.vscode.QuickPickItemKind.Separator });
  for (const entry of entries) {
    items.push({
      label: `${entry.entity}.${entry.property}`,
      description: `${entry.filePath}:${entry.line}`,
      detail: entry.via.length > 0 ? l10nText('via {chain}', { chain: entry.via.join(' -> ') }) : undefined,
      target: { file: entry.filePath, line: entry.line - 1, character: 0 }
    });
  }
  items.push({ label: l10nText('.py access points ({count})', { count: pyAccesses.length }), kind: deps.vscode.QuickPickItemKind.Separator });
  for (const access of pyAccesses) {
    items.push({
      label: access.property,
      description: `${access.filePath}:${access.line}`,
      target: { file: access.filePath, line: access.line - 1, character: access.character }
    });
  }

  const picked = await deps.vscode.window.showQuickPick(items, {
    placeHolder: heading,
    matchOnDetail: true,
    ignoreFocusOut: true
  });
  if (picked?.target) {
    const uri = deps.vscode.Uri.file(picked.target.file);
    const start = { line: picked.target.line, character: picked.target.character };
    const end = { line: picked.target.line, character: picked.target.character + 200 };
    await deps.vscode.window.showTextDocument(uri, { preview: false, selection: { start, end } });
  }

  return {
    heading,
    picked,
    items,
    defPropertyCount: entries.length,
    pyAccessCount: pyAccesses.length,
    accessQueriesTruncated: entries.length > TYPE_IMPACT_PY_ACCESS_LIMIT
  };
}

export function registerTypeImpactCommand(
  context: vscode.ExtensionContext,
  entityMappingManager: {
    getIncomingPythonPropertyAccesses(
      defFile: string,
      propertyName: string
    ): Promise<Array<{ filePath: string; line: number; character: number }>>;
  }
): vscode.Disposable {
  const deps: TypeImpactCommandDeps = {
    vscode: {
      window: {
        get activeTextEditor() {
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            return undefined;
          }
          return {
            fileName: editor.document.fileName,
            wordAtCursor: () => {
              const range = editor.document.getWordRangeAtPosition(editor.selection.active);
              return range ? editor.document.getText(range) : null;
            }
          };
        },
        showQuickPick: (items, options) =>
          vscode.window.showQuickPick(items as never, options as never) as never,
        showInformationMessage: message => vscode.window.showInformationMessage(message),
        showTextDocument: (uri, options) =>
          vscode.window.showTextDocument(uri as never, options as never) as never
      },
      Uri: { file: filePath => vscode.Uri.file(filePath) },
      QuickPickItemKind: vscode.QuickPickItemKind
    },
    readFile: filePath => {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch {
        return null;
      }
    },
    listDefFiles: async () => (await findFilesAcrossRoots('**/*.def', null)).map(uri => uri.fsPath),
    getCustomTypes: () => {
      const roots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
      const entries: CustomTypeInfo[] = [];
      for (const root of roots) {
        entries.push(...getEntityCustomTypesSnapshot(root));
      }
      return entries;
    },
    getPythonAccesses: (defFile, propertyName) =>
      entityMappingManager.getIncomingPythonPropertyAccesses(defFile, propertyName),
    isEnabled: () =>
      vscode.workspace.getConfiguration('kbengine').get<boolean>('typeImpact.enabled', TYPE_IMPACT_ENABLED_DEFAULT)
  };
  return vscode.commands.registerCommand(TYPE_IMPACT_COMMAND, () => runTypeImpactCommand(deps));
}
