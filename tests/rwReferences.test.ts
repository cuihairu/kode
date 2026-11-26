// RW-REFS-001: grouped READ/WRITE/DELETE references acceptance tests.
// The command body is called directly with a fake vscode API object, so the
// QuickPick rows, jump target, cancellation and info path are observable
// without an Electron host.
//
// prove-red perturbations (restore after each run):
//   R1: remove kind-based grouping in groupRwSites → cases 1/2 fail.
//   R2: remove dual assignment classification in detectRwAssignmentShape →
//       case 2 (augmented assignment ⇄) fails.
//   R3: remove range/symbol alignment in alignRwReferences → case 3 fails.
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RW_HIGHLIGHT_READ,
  RW_HIGHLIGHT_WRITE,
  type RwQuickPickItem,
  type RwVscodeApi,
  runFindReferencesRW
} from '../src/rwReferencesCommand';
import {
  alignRwReferences,
  classifyRwKeySite,
  detectRwAssignmentShape,
  groupRwSites,
  shouldYieldBetweenFiles,
  type RwHighlightLike,
  type RwReferenceLike,
  type RwSourceSite
} from '../src/backend/rwReferencesCore';
import { scanCellDataKeyAccesses } from '../src/backend/cellDataKeyAccess';
import { setL10nBundle } from './fake-vscode/l10n';
import { resolveDataDictSitesAtPosition } from '../src/languageProviders/pythonDefinition';

vi.mock('../src/languageProviders/pythonDefinition', { spy: true });

interface FakeTextDoc {
  uri: { fsPath: string; toString(): string };
  fileName: string;
  languageId: string;
  version: number;
  getText(): string;
  lineAt(line: number): { text: string };
}

function makeDocument(lines: string[], fileName = '/workspace/hero.py'): FakeTextDoc {
  const text = lines.join('\n');
  return {
    uri: {
      fsPath: fileName,
      toString(): string { return `file://${fileName}`; }
    },
    fileName,
    languageId: 'python',
    version: 1,
    getText(): string { return text; },
    lineAt(line: number): { text: string } { return { text: lines[line] ?? '' }; }
  };
}

interface FakeApiState {
  api: RwVscodeApi;
  picks: RwQuickPickItem[][];
  capturedOptions: Array<{ placeHolder: string }>;
  opened: unknown[];
  shown: unknown[];
  executed: Array<{ command: string; args: unknown[] }>;
  info: string[];
  executeImpl: (command: string, args: unknown[]) => Promise<unknown>;
}

function makeApi(lines: string[], options: { fileName?: string; word?: string } = {}): FakeApiState {
  const fileName = options.fileName ?? '/workspace/hero.py';
  const doc = makeDocument(lines, fileName);
  const picks: RwQuickPickItem[][] = [];
  const capturedOptions: Array<{ placeHolder: string }> = [];
  const opened: unknown[] = [];
  const shown: unknown[] = [];
  const executed: Array<{ command: string; args: unknown[] }> = [];
  const info: string[] = [];
  const executeImpl = vi.fn(async (command: string, ...args: unknown[]): Promise<unknown> => {
    executed.push({ command, args });
    return undefined;
  });
  const files = new Map<string, string>([[fileName, lines.join('\n')]]);
  const state: FakeApiState = {
    picks,
    capturedOptions,
    opened,
    shown,
    executed,
    info,
    executeImpl,
    api: {
      window: {
        activeTextEditor: {
          document: doc as never,
          selection: { active: { line: 0, character: 0 } }
        } as never,
        showQuickPick: async (items, pickOptions) => {
          picks.push([...items]);
          capturedOptions.push({ placeHolder: pickOptions.placeHolder });
          return items.find(item => item.target !== undefined);
        },
        showInformationMessage: async message => {
          info.push(message);
          return undefined;
        },
        showTextDocument: async (uri, showOptions) => {
          opened.push({ uri, options: showOptions });
          return undefined;
        }
      },
      commands: {
        executeCommand: (command, ...args) => executeImpl(command, args) as never
      },
      workspace: {
        openTextDocument: async uri => {
          const filePath = (uri as { fsPath: string }).fsPath;
          opened.push(uri);
          return {
            getText: () => files.get(filePath) ?? '',
            lineAt: (line: number) => {
              const text = (files.get(filePath) ?? '').split('\n')[line] ?? '';
              return { text };
            }
          };
        }
      },
      Uri: {
        file: (filePath: string) => ({ fsPath: filePath, toString: () => `file://${filePath}` })
      },
      QuickPickItemKind: { Separator: -1 }
    }
  };
  return state;
}

function labelsOf(items: RwQuickPickItem[]): string[] {
  return items.map(item => item.label);
}

beforeEach(() => {
  setL10nBundle(null);
});

afterEach(() => {
  setL10nBundle(null);
  vi.mocked(resolveDataDictSitesAtPosition).mockReset();
  vi.restoreAllMocks();
});

describe('RW-REFS-001 pure core', () => {
  it('1. key-family sites group by write/read/delete with file:line sorting', () => {
    const sites: RwSourceSite[] = [
      { file: '/b.py', line: 3, character: 0, kind: 'read' },
      { file: '/a.py', line: 9, character: 0, kind: 'write' },
      { file: '/a.py', line: 2, character: 0, kind: 'delete' }
    ];
    const classified = sites.map(site => classifyRwKeySite(site, 'x = 1'));
    const groups = groupRwSites(classified);
    expect(groups.write.map(site => site.file)).toEqual(['/a.py']);
    expect(groups.read.map(site => site.file)).toEqual(['/b.py']);
    expect(groups.delete.map(site => site.file)).toEqual(['/a.py']);
    expect(groups.write[0].line).toBe(9);
  });

  it('2. augmented and subscript assignments classify as read + write (⇄)', () => {
    expect(detectRwAssignmentShape('s.hp += 1', 0)).toMatchObject({ write: true, dual: true });
    expect(detectRwAssignmentShape('D["hp"] = 3', 0)).toMatchObject({ write: true, dual: true });
    const plain = detectRwAssignmentShape('hp = 3', 0);
    expect(plain.write).toBe(true);
    expect(plain.dual).toBe(false);
    const site = classifyRwKeySite({ file: '/b.py', line: 0, character: 0, kind: 'write' }, 's.hp += 1');
    expect(site.kinds).toEqual(['write', 'read']);
    expect(site.dual).toBe(true);
    const groups = groupRwSites([site]);
    expect(groups.write).toHaveLength(1);
    expect(groups.read).toHaveLength(1);
    // Real scanner output: cellData keyStart points INSIDE the string literal
    // (first key character, after the opening quote). The shape scan must
    // still see the assignment — prove-red: drop the quote step-back in
    // detectRwAssignmentShape and this case reports read-only, no ⇄.
    for (const line of [
      '        self.cellData["hp"] = 3',
      '        self.cellData["hp"] += 3'
    ]) {
      const scanned = scanCellDataKeyAccesses(`class X:\n${line}\n`);
      expect(scanned).toHaveLength(1);
      const keyStart = scanned[0].keyStart; // column of h, inside the quotes
      expect(line[keyStart]).toBe('h');
      expect(line[keyStart - 1]).toBe('"');
      const cellSite = classifyRwKeySite(
        { file: '/c.py', line: 1, character: keyStart },
        line
      );
      expect(cellSite.kinds).toEqual(['read', 'write']);
      expect(cellSite.dual).toBe(true);
    }
  });

  it('3. general-symbol alignment by range and exact symbol spelling', () => {
    const references: RwReferenceLike[] = [
      {
        file: '/a.py',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 }
        }
      },
      {
        file: '/b.py',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 }
        }
      }
    ];
    const highlights: RwHighlightLike[] = [
      {
        file: '/a.py',
        range: references[0].range,
        kind: RW_HIGHLIGHT_WRITE
      },
      {
        file: '/b.py',
        range: references[1].range,
        kind: RW_HIGHLIGHT_READ
      }
    ];
    const texts = new Map([
      ['/a.py', 'Hero = 1'],
      ['/b.py', 'Hero.read()']
    ]);
    const sites = alignRwReferences(references, highlights, texts, 'Hero');
    expect(sites.map(site => site.kinds)).toEqual([['write'], ['read']]);
    // Case-sensitive: lowercase hero references never join the Hero family.
    expect(alignRwReferences(references, highlights, texts, 'hero')).toEqual([]);
  });

  it('4. >50 files yields every 10 files', () => {
    expect(shouldYieldBetweenFiles(10, 51)).toBe(true);
    expect(shouldYieldBetweenFiles(1, 51)).toBe(false);
    expect(shouldYieldBetweenFiles(10, 50)).toBe(false);
  });

  it('5. case-fold source pin', () => {
    const core = fs.readFileSync(path.join(__dirname, '..', 'src', 'backend', 'rwReferencesCore.ts'), 'utf8');
    const command = fs.readFileSync(path.join(__dirname, '..', 'src', 'rwReferencesCommand.ts'), 'utf8');
    expect(core).not.toMatch(/to(?:Lower|Upper)Case\s*\(/);
    expect(core).not.toMatch(/localeCompare\s*\(/);
    expect(command).not.toMatch(/to(?:Lower|Upper)Case\s*\(/);
    expect(command).not.toMatch(/localeCompare\s*\(/);
  });
});

describe('RW-REFS-001 command face', () => {
  it('6. key-family face groups real resolver sites into WRITE/READ/DELETE with ⇄', async () => {
    const state = makeApi(['KBEngine.globalData["hp"] = 1']);
    const resolver = vi.mocked(resolveDataDictSitesAtPosition).mockResolvedValue({
      access: {
        dict: 'globalData',
        keySignature: 'hp',
        line: 0,
        keyStart: 20,
        keyEnd: 23,
        kind: 'write',
        valueText: '1',
        exprEnd: 25
      },
      ready: true,
      sites: [
        {
          dict: 'globalData', keySignature: 'hp', line: 0, keyStart: 20, keyEnd: 23,
          kind: 'write', valueText: '1', exprEnd: 25, file: '/workspace/hero.py'
        },
        {
          dict: 'globalData', keySignature: 'hp', line: 1, keyStart: 8, keyEnd: 11,
          kind: 'read', valueText: null, exprEnd: 12, file: '/workspace/other.py'
        },
        {
          dict: 'globalData', keySignature: 'hp', line: 2, keyStart: 8, keyEnd: 11,
          kind: 'delete', valueText: null, exprEnd: 12, file: '/workspace/other.py'
        }
      ]
    });
    void resolver;
    const result = await runFindReferencesRW({ vscode: state.api });
    expect(resolveDataDictSitesAtPosition).toHaveBeenCalled();
    expect(result.noFace).toBe(false);
    // Subscript assignment (D["k"] = v) is a ⇄ site: listed in WRITE and READ.
    expect(result.counts).toMatchObject({ write: 1, read: 2, delete: 1, total: 4 });
    expect(labelsOf(state.picks[0])).toEqual([
      'WRITE (1)', '⇄ /workspace/hero.py:1',
      'READ (2)', '⇄ /workspace/hero.py:1', '/workspace/other.py:2',
      'DELETE (1)', '/workspace/other.py:3'
    ]);
    const writeRow = state.picks[0][1];
    expect(writeRow.detail).toBe('KBEngine.globalData["hp"] = 1');
  });

  it('7. no-face path shows the info message', async () => {
    const state = makeApi(['not a symbol']);
    const result = await runFindReferencesRW({ vscode: state.api });
    expect(result.noFace).toBe(true);
    expect(state.info).toContain('No readable reference face at the cursor');
    expect(state.picks).toEqual([]);
  });

  it('8. general-symbol face aligns providers and renders grouped QuickPick rows', async () => {
    const state = makeApi(['Hero.loadSkills()']);
    state.executeImpl.mockImplementation(async (command: string, ...args: unknown[]) => {
      state.executed.push({ command, args });
      if (command === 'vscode.executeReferenceProvider') {
        return [{
          uri: state.api.Uri.file('/workspace/hero.py'),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }
        }];
      }
      if (command === 'vscode.executeDocumentHighlightProvider') {
        return [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
          kind: RW_HIGHLIGHT_WRITE
        }];
      }
      return undefined;
    });
    const result = await runFindReferencesRW({ vscode: state.api });
    expect(result.noFace).toBe(false);
    expect(state.executed.map(entry => entry.command)).toEqual([
      'vscode.executeReferenceProvider',
      'vscode.executeDocumentHighlightProvider'
    ]);
    expect(result.counts.write).toBe(1);
    expect(result.heading).toContain('Hero');
    expect(labelsOf(state.picks[0])).toContain('WRITE (1)');
    const showCall = state.opened.at(-1) as {
      options?: { preview?: boolean; selection?: { start: { line: number; character: number } } };
    };
    expect(showCall.options?.preview).toBe(false);
    expect(showCall.options?.selection?.start).toEqual({ line: 0, character: 0 });
  });

  // Prove-red: symbol extraction used to slice the line at the cursor, so a
  // mid-word cursor turned Hero into ro and dropped every real reference.
  it('8b. cursor mid-word still resolves the whole symbol', async () => {
    const state = makeApi(['Hero.loadSkills()']);
    (state.api.window.activeTextEditor as { selection: unknown }).selection = {
      active: { line: 0, character: 2 }
    };
    state.executeImpl.mockImplementation(async (command: string) => {
      if (command === 'vscode.executeReferenceProvider') {
        return [{
          uri: state.api.Uri.file('/workspace/hero.py'),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }
        }];
      }
      if (command === 'vscode.executeDocumentHighlightProvider') {
        return [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
          kind: RW_HIGHLIGHT_READ
        }];
      }
      return undefined;
    });
    const result = await runFindReferencesRW({ vscode: state.api });
    expect(result.noFace).toBe(false);
    expect(result.heading).toContain('Hero');
    expect(result.counts.read).toBe(1);
  });

  it('9. cancellation stops provider queries', async () => {
    const state = makeApi(['Hero.loadSkills()']);
    const token = { isCancellationRequested: true };
    const result = await runFindReferencesRW({ vscode: state.api, token });
    expect(result.noFace).toBe(true);
    expect(state.executed).toEqual([]);
  });

  it('10. info message is localized through l10nText', async () => {
    const bundlePath = path.join(__dirname, '..', 'l10n', 'bundle.l10n.zh-cn.json');
    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as Record<string, string>;
    setL10nBundle(bundle);
    const state = makeApi(['nothing']);
    await runFindReferencesRW({ vscode: state.api });
    expect(state.info).toEqual(['当前符号无读写引用面']);
  });
});
