// IDX-REL-003 wiring: `kbengine.showFieldChannels` — serialization round-trip
// panel for one field or def property. Maps the target to the concrete
// encode/decode points of the three serialization channels (wire encode,
// wire decode, DB persistence); impl anchors come from the FD serializer
// shapes (getDictFromObj return keys / createObjFromDict input reads),
// engine cites where no user impl anchors the channel (SER-02 anchors:
// datatype.cpp:2592-2642 / :2673 / entity_table blob).
//
// Shape follows rwReferencesCommand / typeImpactCommand: pure deps-injected
// orchestration tested without vscode; the registration wrapper binds the
// real vscode face. Python impl files are derived from the (watcher
// maintained) declaration snapshot's implementedBy paths — no workspace
// scan is invented here.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10nText } from './nlsRuntime';
import { findFilesAcrossRoots } from './scanRoots';
import { getEntityCustomTypesSnapshot, type CustomTypeInfo } from './definitionWorkspace';
import {
  FieldChannelIndex,
  type FieldChannelAnchorList,
  type FieldChannelKind
} from './backend/fieldChannelIndex';

export const FIELD_CHANNELS_COMMAND = 'kbengine.showFieldChannels';

/** Toggle default (registered in package.json) */
export const FIELD_CHANNELS_ENABLED_DEFAULT = true;

export interface FieldChannelsQuickPickItem {
  label: string;
  kind?: number;
  description?: string;
  detail?: string;
  /** Navigation target; separators and engine cites have none. */
  target?: { file: string; line: number; character: number };
}

export interface FieldChannelsVscodeApi {
  window: {
    /** Editor face the command needs; the adapter precomputes the cursor word */
    activeTextEditor?: {
      fileName: string;
      /** Word under the cursor, or null (empty selection fallback done adapter-side) */
      wordAtCursor(): string | null;
    };
    showQuickPick(
      items: readonly FieldChannelsQuickPickItem[],
      options: { placeHolder: string; matchOnDetail?: boolean; ignoreFocusOut?: boolean }
    ): Thenable<FieldChannelsQuickPickItem | undefined>;
    showInformationMessage(message: string): Thenable<unknown>;
    showTextDocument(
      uri: unknown,
      options?: { preview?: boolean; selection?: unknown }
    ): Thenable<unknown>;
  };
  Uri: { file(filePath: string): unknown };
  QuickPickItemKind: { Separator: number };
}

export interface FieldChannelsCommandDeps {
  vscode: FieldChannelsVscodeApi;
  readFile(filePath: string): string | null;
  listDefFiles(): Promise<string[]>;
  getCustomTypes(): readonly CustomTypeInfo[];
  isEnabled(): boolean;
  /** Index seam (tests pass a fresh instance; production shares one per process) */
  index: FieldChannelIndex;
}

export interface FieldChannelsCommandResult {
  disabled?: boolean;
  /** Neither cursor nor picker produced a target. */
  noTarget?: boolean;
  heading?: string;
  picked?: FieldChannelsQuickPickItem;
  items?: FieldChannelsQuickPickItem[];
  /** impl anchors (navigable); engine cites are not counted */
  anchorCount?: number;
  staleCount?: number;
}

export function createFieldChannelIndex(): FieldChannelIndex {
  return new FieldChannelIndex();
}

/** Shared index across command runs: caches survive content identity */
const sharedIndex = createFieldChannelIndex();

/** Picker candidate: a declared FD field or a def property */
interface FieldChannelsTarget {
  heading: string;
  query: FieldChannelAnchorList | null;
}

export async function runFieldChannelsCommand(deps: FieldChannelsCommandDeps): Promise<FieldChannelsCommandResult> {
  if (!deps.isEnabled()) {
    await deps.vscode.window.showInformationMessage(l10nText('Field channel lookup is disabled (kbengine.fieldChannels.enabled).'));
    return { disabled: true };
  }

  const index = deps.index;
  const declarations = deps.getCustomTypes();
  index.setCustomTypes(declarations);

  // Def files: content-identity cache; deleted files must not leave phantom rows.
  const defFiles = await deps.listDefFiles();
  index.retainDefFiles(new Set(defFiles));
  for (const filePath of defFiles) {
    const text = deps.readFile(filePath);
    if (text === null) {
      continue;
    }
    const entity = path.basename(filePath).replace(/\.def$/i, '');
    index.setDefFile(filePath, entity, text);
  }

  // Python impl files: the snapshot's implementedBy paths (no invented scan).
  const pythonFiles = [...new Set(declarations.map(info => info.pythonFilePath).filter((filePath): filePath is string => Boolean(filePath)))];
  index.retainPythonFiles(new Set(pythonFiles));
  for (const filePath of pythonFiles) {
    const text = deps.readFile(filePath);
    if (text === null) {
      continue;
    }
    index.setPythonFile(filePath, text);
  }

  const target = await resolveTarget(deps, index, declarations, defFiles);
  if (!target) {
    return { noTarget: true };
  }
  if (!target.query) {
    await deps.vscode.window.showInformationMessage(l10nText('No field or property match "{target}".', { target: target.heading }));
    return { heading: target.heading, noTarget: true };
  }

  const items = buildPanelItems(deps, target.query);
  const heading = l10nText('Channels of {target}', { target: target.query.target });
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
    anchorCount: target.query.anchors.filter(anchor => anchor.origin === 'impl').length,
    staleCount: target.query.stale.length
  };
}

/** Cursor resolution (def property / declared FD field), else the picker. */
async function resolveTarget(
  deps: FieldChannelsCommandDeps,
  index: FieldChannelIndex,
  declarations: readonly CustomTypeInfo[],
  defFiles: readonly string[]
): Promise<FieldChannelsTarget | null> {
  const editor = deps.vscode.window.activeTextEditor;
  if (editor) {
    const word = editor.wordAtCursor();
    if (word) {
      const base = path.basename(editor.fileName).toLowerCase();
      if (base === 'types.xml' || base === 'alias.xml') {
        for (const info of declarations) {
          if (info.properties.some(candidate => candidate.name === word)) {
            return { heading: `${info.name}.${word}`, query: index.channelsForField(info.name, word) };
          }
        }
      } else {
        for (const filePath of defFiles) {
          const row = index.getDefFileRows(filePath).find(candidate => candidate.property === word);
          if (row) {
            return { heading: `${row.entity}.${word}`, query: index.channelsForProperty(filePath, word) };
          }
        }
      }
    }
  }

  // Fallback picker: declared FD fields first (the motivating surface), then
  // def properties whose type is a declared custom type (they carry the
  // impl conversion anchors; builtin-only properties stay cursor-reachable).
  const names: string[] = [];
  const declaredTypes = new Set(declarations.map(info => info.name));
  for (const info of declarations) {
    for (const property of info.properties) {
      names.push(`${info.name}.${property.name}`);
    }
  }
  for (const filePath of defFiles) {
    for (const row of index.getDefFileRows(filePath)) {
      const typeToken = row.ofRef && row.declaredType === 'ARRAY' ? row.ofRef : row.declaredType;
      if (typeToken && declaredTypes.has(typeToken)) {
        const heading = `${row.entity}.${row.property}`;
        if (!names.includes(heading)) {
          names.push(heading);
        }
      }
    }
  }
  if (names.length === 0) {
    await deps.vscode.window.showInformationMessage(l10nText('No custom type declarations found (types.xml / alias.xml).'));
    return null;
  }
  const picked = await deps.vscode.window.showQuickPick(
    names.map(name => ({ label: name })),
    { placeHolder: l10nText('Select the field or property to inspect'), matchOnDetail: false, ignoreFocusOut: true }
  );
  if (!picked) {
    return null;
  }
  const dot = picked.label.indexOf('.');
  const head = dot >= 0 ? picked.label.slice(0, dot) : picked.label;
  const tail = dot >= 0 ? picked.label.slice(dot + 1) : '';
  if (tail && declarations.some(info => info.name === head)) {
    return { heading: picked.label, query: index.channelsForField(head, tail) };
  }
  for (const filePath of defFiles) {
    const query = index.channelsForProperty(filePath, tail || head);
    if (query) {
      return { heading: picked.label, query };
    }
  }
  return { heading: picked.label, query: null };
}

const CHANNEL_SECTIONS: Record<FieldChannelKind, string> = {
  'wire-encode': 'Wire encode',
  'wire-decode': 'Wire decode (client)',
  db: 'Database'
};

function buildPanelItems(deps: FieldChannelsCommandDeps, query: FieldChannelAnchorList): FieldChannelsQuickPickItem[] {
  const items: FieldChannelsQuickPickItem[] = [];
  for (const channel of ['wire-encode', 'wire-decode', 'db'] as const) {
    items.push({ label: l10nText(CHANNEL_SECTIONS[channel]), kind: deps.vscode.QuickPickItemKind.Separator });
    for (const anchor of query.anchors) {
      if (anchor.channel !== channel) {
        continue;
      }
      if (anchor.origin === 'impl' && anchor.file && anchor.line !== undefined) {
        items.push({
          label: anchor.origin,
          description: `${anchor.file}:${anchor.line}`,
          target: { file: anchor.file, line: anchor.line - 1, character: anchor.character ?? 0 }
        });
      } else if (anchor.origin === 'none') {
        items.push({ label: l10nText('Not persisted'), description: anchor.cite });
      } else {
        items.push({ label: anchor.origin, description: anchor.cite });
      }
    }
  }
  if (query.stale.length > 0) {
    items.push({ label: l10nText('Stale impl anchors ({count})', { count: query.stale.length }), kind: deps.vscode.QuickPickItemKind.Separator });
    for (const stale of query.stale) {
      items.push({
        label: stale.key,
        description: `${stale.file}:${stale.line}`,
        detail: l10nText('No longer a declared field of {type}', { type: query.target.split('.')[0] })
      });
    }
  }
  return items;
}

export function registerFieldChannelsCommand(context: vscode.ExtensionContext): vscode.Disposable {
  const deps: FieldChannelsCommandDeps = {
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
    isEnabled: () =>
      vscode.workspace.getConfiguration('kbengine').get<boolean>('fieldChannels.enabled', FIELD_CHANNELS_ENABLED_DEFAULT),
    index: sharedIndex
  };
  void context;
  return vscode.commands.registerCommand(FIELD_CHANNELS_COMMAND, () => runFieldChannelsCommand(deps));
}
