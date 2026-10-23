import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineDefinitionProvider, PythonDefinitionProvider } from '../src/languageProviders';
import { PythonClassIndex } from '../src/pythonClassIndex';
import { Position, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';

const DEMO = path.join(__dirname, 'fixtures', 'kbengine-demo-assets');
const manifest = JSON.parse(fs.readFileSync(path.join(DEMO, 'navigation-cases.json'), 'utf8')) as {
  cases: Array<{
    id: string;
    source: { file: string; needle: string; symbol: string };
    targets: Array<{ file: string; needle: string }>;
  }>;
};
const originalFindFiles = workspace.findFiles;
const originalFolders = workspace.workspaceFolders;

function walkFiles(): Uri[] {
  const files: Uri[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); }
      else { files.push(Uri.file(full)); }
    }
  };
  walk(DEMO);
  return files;
}

const sourcePosition = (content: string, marker: string, symbol: string) => {
  const line = content.split(/\r?\n/).findIndex(row => row.includes(marker));
  expect(line, `Missing source marker ${marker}`).toBeGreaterThanOrEqual(0);
  const row = content.split(/\r?\n/)[line];
  const character = row.indexOf(symbol);
  expect(character, `Missing symbol ${symbol} beside ${marker}`).toBeGreaterThanOrEqual(0);
  return new Position(line, character + Math.floor(symbol.length / 2));
};

const expectedTargets = (targets: Array<{ file: string; needle: string }>) => targets.map(target => {
  const content = fs.readFileSync(path.join(DEMO, target.file), 'utf8');
  const line = content.split(/\r?\n/).findIndex(row => row.includes(target.needle));
  expect(line, `Missing target ${target.file}: ${target.needle}`).toBeGreaterThanOrEqual(0);
  return `${path.resolve(DEMO, target.file)}:${line}`;
}).sort();

describe('KBEngine demo navigation acceptance manifest', () => {
  let pythonProvider: PythonDefinitionProvider;
  let defProvider: KBEngineDefinitionProvider;

  beforeAll(async () => {
    workspace.workspaceFolders = [{ uri: Uri.file(DEMO), name: 'kbengine-demo-assets', index: 0 }];
    workspace.findFiles = async (glob: string) => walkFiles().filter(uri => {
      const name = path.basename(uri.fsPath);
      return glob.includes('entities.xml') ? name === 'entities.xml'
        : glob.includes('*.def') ? name.endsWith('.def')
          : glob.includes('types.xml') ? name === 'types.xml'
            : name.endsWith('.py');
    });
    const manager = new EntityMappingManager({ subscriptions: [] });
    // PR5:验收清单要求全量候选集(多 mixin 命中),先等全量扫描就绪再跑用例;
    // 生产 Definition 首查不等全量(冷启动首查耗时见 docs/perf/2026-pr5 报告)。
    const pythonClassIndex = new PythonClassIndex();
    pythonProvider = new PythonDefinitionProvider(manager, pythonClassIndex);
    defProvider = new KBEngineDefinitionProvider(manager);
    await pythonClassIndex.waitForInitialScan();
  });

  afterAll(() => {
    workspace.findFiles = originalFindFiles;
    workspace.workspaceFolders = originalFolders;
  });

  it.each(manifest.cases)('$id resolves exactly the declared targets', async testCase => {
    const filePath = path.join(DEMO, testCase.source.file);
    const content = fs.readFileSync(filePath, 'utf8');
    const document = makeTextDocument(content, {
      fileName: filePath,
      languageId: filePath.endsWith('.def') ? 'kbengine-def' : 'python'
    });
    const position = sourcePosition(content, testCase.source.needle, testCase.source.symbol);
    const provider = filePath.endsWith('.def') ? defProvider : pythonProvider;
    const result = await provider.provideDefinition(document, position) as
      | { uri: { fsPath: string }; range: { start: { line: number } } }
      | Array<{ uri: { fsPath: string }; range: { start: { line: number } } }>
      | null;
    const actual = (Array.isArray(result) ? result : result ? [result] : [])
      .map(location => `${location.uri.fsPath}:${location.range.start.line}`).sort();
    expect(actual, testCase.id).toEqual(expectedTargets(testCase.targets));
  });
});
