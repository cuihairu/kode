import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PythonClassIndex, parsePythonFile } from '../src/pythonClassIndex';
import { PythonDefinitionProvider, setPythonMroJumpEnabled } from '../src/languageProviders';
import { Position, Uri } from './fake-vscode/core';
import { workspace } from './fake-vscode/workspaceState';
import { makeTextDocument } from './helpers/vscodeStub';

const originalFind = workspace.findFiles;
const temporaryDirectories: string[] = [];
afterEach(() => {
  workspace.findFiles = originalFind;
  workspace.textDocuments = [];
  setPythonMroJumpEnabled(true);
  vi.restoreAllMocks();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fixture(sources: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mixin-navigation-'));
  temporaryDirectories.push(root);
  const files: Record<string, string> = {};
  for (const [name, source] of Object.entries(sources)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    files[name] = file;
  }
  workspace.findFiles = (async (glob: string) => Object.values(files)
    .filter(file => glob === '**/*.py' ? file.endsWith('.py') : glob === '**/*.def' ? file.endsWith('.def') : file.endsWith(glob.slice(3)))
    .map(file => Uri.file(file))) as typeof workspace.findFiles;
  return { files, index: new PythonClassIndex() };
}

const tick = 'class RunMixin:\n    def tick(self): pass\n';

describe('Python mixin navigation regressions', () => {
  it('multiline inheritance, comments and aliased parenthesized imports', async () => {
    const source = 'from mix import (\n    RunMixin as RM,\n)\nclass Avatar(\n    RM, # parent\n):\n    def run(self):\n        self.tick()\n';
    const { files, index } = fixture({ 'mix.py': tick, 'avatar.py': source });
    expect(await index.resolveSelfMethod(files['avatar.py'], 7, 'tick')).toMatchObject({ filePath: files['mix.py'], line: 1 });
  });

  it.each([
    ['from pkg.mix import RunMixin as RM', 'RM'],
    ['import pkg.mix as m', 'm.RunMixin'],
    ['import pkg.mix', 'pkg.mix.RunMixin'],
    ['from pkg import mix as m', 'm.RunMixin'],
    ['from .mix import RunMixin as RM', 'RM'],
    ['from . import mix', 'mix.RunMixin'],
    ['from pkg import RunMixin', 'RunMixin']
  ])('resolves %s by module identity', async (statement, base) => {
    const { files, index } = fixture({
      'pkg/mix.py': tick,
      'pkg/__init__.py': 'from .mix import RunMixin\n',
      'other/mix.py': tick,
      'pkg/avatar.py': `${statement}\nclass Avatar(${base}):\n    def run(self):\n        self.tick()\n`
    });
    expect(await index.resolveSelfMethod(files['pkg/avatar.py'], 3, 'tick')).toMatchObject({ filePath: files['pkg/mix.py'] });
  });

  it('never resolves an explicit missing import to an unrelated same-name class', async () => {
    const { files, index } = fixture({
      'unrelated.py': tick,
      'avatar.py': 'from missing import RunMixin\nclass Avatar(RunMixin):\n    def run(self):\n        self.tick()\n'
    });
    expect(await index.resolveSelfMethod(files['avatar.py'], 3, 'tick')).toBeNull();
  });

  it('anchors same-name base/cell entities to the calling file regardless of scan order', async () => {
    const { files, index } = fixture({
      'scripts/base/Avatar.py': 'class Avatar:\n    def tick(self): pass\n',
      'scripts/base/mix.py': tick,
      'scripts/cell/mix.py': tick,
      'scripts/cell/Avatar.py': 'from mix import RunMixin\nclass Avatar(RunMixin):\n    def run(self):\n        self.tick()\n'
    });
    expect(await index.resolveSelfMethod(files['scripts/cell/Avatar.py'], 3, 'tick')).toMatchObject({ filePath: files['scripts/cell/mix.py'] });
  });

  it('keeps sibling mixin candidates separate across packages and respects C3 order', async () => {
    const { files, index } = fixture({
      'a/mix.py': 'class Caller:\n    def run(self):\n        self.tick()\n',
      'b/mix.py': 'class Caller:\n    def run(self):\n        self.tick()\n',
      'a/root.py': 'from .mix import Caller\nclass First:\n    def tick(self): pass\nclass Second:\n    def tick(self): pass\nclass Root(First, Second, Caller): pass\n',
      'b/root.py': 'from .mix import Caller\nclass Wrong:\n    def tick(self): pass\nclass Root(Wrong, Caller): pass\n',
      'a/other.py': 'from .mix import Caller\nclass Alternate:\n    def tick(self): pass\nclass Other(Alternate, Caller): pass\n'
    });
    const candidates = await index.resolveSelfMethodCandidates(files['a/mix.py'], 2, 'tick');
    expect(candidates.map(candidate => [candidate.filePath, candidate.className])).toEqual([
      [files['a/root.py'], 'First'], [files['a/other.py'], 'Alternate']
    ]);
  });

  it('uses unsaved buffers for methods, inheritance and line positions', async () => {
    const { files, index } = fixture({ 'mix.py': tick, 'avatar.py': 'class Avatar:\n    pass\n' });
    await index.findClassesByName('Avatar');
    const edited = 'from mix import RunMixin\n\nclass Avatar(RunMixin):\n    def fresh(self): pass\n    def run(self):\n        self.tick()\n';
    await index.onDocumentChanged(makeTextDocument(edited, { fileName: files['avatar.py'], version: 2 }));
    expect(await index.resolveSelfMethod(files['avatar.py'], 5, 'tick')).toMatchObject({ filePath: files['mix.py'] });
    expect(await index.resolveSelfMethod(files['avatar.py'], 5, 'fresh')).toMatchObject({ line: 3 });
  });

  it('updates new/deleted/external files after filesystem invalidation', async () => {
    const { files, index } = fixture({ 'avatar.py': 'class Avatar(RunMixin):\n    def run(self):\n        self.tick()\n' });
    expect(await index.resolveSelfMethod(files['avatar.py'], 2, 'tick')).toBeNull();
    files['mix.py'] = path.join(path.dirname(files['avatar.py']), 'mix.py');
    fs.writeFileSync(files['mix.py'], tick);
    index.invalidate(files['mix.py']);
    expect(await index.resolveSelfMethod(files['avatar.py'], 2, 'tick')).toMatchObject({ filePath: files['mix.py'] });
    fs.writeFileSync(files['mix.py'], 'class RunMixin:\n    def fresh(self): pass\n');
    index.invalidate(files['mix.py']);
    expect(await index.resolveSelfMethod(files['avatar.py'], 2, 'fresh')).toMatchObject({ filePath: files['mix.py'] });
    fs.unlinkSync(files['mix.py']);
    delete files['mix.py'];
    index.invalidate(path.join(path.dirname(files['avatar.py']), 'mix.py'));
    expect(await index.resolveSelfMethod(files['avatar.py'], 2, 'fresh')).toBeNull();
  });

  it('does not parse closures, docstrings or module functions as class methods', () => {
    const parsed = parsePythonFile('class A:\n    def outer(self):\n        def nested(): pass\n        class LocalOnly:\n            def wrong(self): pass\n        """\n        class Fake:\n            def wrong(self): pass\n        """\n\ndef outside():\n    pass\n', '/scope.py');
    expect(parsed.classes).toHaveLength(1);
    expect([...parsed.classes[0].methods.keys()]).toEqual(['outer']);
    expect(parsed.classes[0].endLine).toBe(10);
  });

  it('distinguishes nested same-name classes by qualified name', async () => {
    const { files, index } = fixture({ 'nested.py': 'class A:\n    class M:\n        def tick(self): pass\nclass B:\n    class M:\n        def tick(self): pass\n        def run(self):\n            self.tick()\n' });
    expect(await index.resolveSelfMethod(files['nested.py'], 7, 'tick')).toMatchObject({ line: 5 });
  });

  it('prefers Python implementation over a .def method declaration and retains declaration fallback', async () => {
    const source = 'from mix import RunMixin\nclass Avatar(RunMixin):\n    def run(self):\n        self.tick()\n        self.remote()\n';
    const { files, index } = fixture({ 'mix.py': tick, 'avatar.py': source });
    const manager = {
      resolvePropertyDefinitionForClass: async () => null,
      resolvePropertyDefinition: async () => null,
      resolveMethodDefinitionForClass: async () => ({ defFile: '/Avatar.def', line: 7 }),
      resolveMethodDefinition: async () => null
    };
    const provider = new PythonDefinitionProvider(manager as never, index);
    const document = makeTextDocument(source, { fileName: files['avatar.py'], languageId: 'python' });
    const implementation = await provider.provideDefinitionTraced(document, new Position(3, 15));
    expect(implementation.location).toMatchObject({ uri: { fsPath: files['mix.py'] }, range: { start: { line: 1 } } });
    expect(implementation.layers.at(-1)).toMatchObject({ layer: 'python-mro', status: 'hit' });
    const fallback = await provider.provideDefinition(document, new Position(4, 15));
    expect(fallback).toMatchObject({ uri: { fsPath: '/Avatar.def' }, range: { start: { line: 6 } } });
  });

  it('file fallback follows same-file MRO and never picks unrelated classes', async () => {
    setPythonMroJumpEnabled(false);
    const source = 'class Unrelated:\n    def missing(self): pass\nclass A:\n    def tick(self): pass\nclass B(A): pass\nclass C(B):\n    def run(self):\n        self.tick()\n        self.missing()\n';
    const manager = {
      resolvePropertyDefinitionForClass: async () => null, resolvePropertyDefinition: async () => null,
      resolveMethodDefinitionForClass: async () => null, resolveMethodDefinition: async () => null
    };
    const provider = new PythonDefinitionProvider(manager as never);
    const document = makeTextDocument(source, { fileName: '/fallback.py' });
    expect(await provider.provideDefinition(document, new Position(7, 15))).toMatchObject({ range: { start: { line: 3 } } });
    expect(await provider.provideDefinition(document, new Position(8, 15))).toBeNull();
  });
});

describe('related navigation and cache failures', () => {
  it('a class can inherit an imported class with the same name without creating a self-cycle', async () => {
    const { files, index } = fixture({
      'parent.py': 'class Avatar:\n    def tick(self): pass\n',
      'avatar.py': 'from parent import Avatar\nclass Avatar(Avatar):\n    def run(self):\n        self.tick()\n'
    });
    expect(await index.resolveSelfMethod(files['avatar.py'], 3, 'tick')).toMatchObject({ filePath: files['parent.py'] });
  });

  it('an edit before the first scan survives the scan, and closing the buffer restores disk contents', async () => {
    const { files, index } = fixture({ 'avatar.py': 'class Avatar:\n    def old(self): pass\n' });
    const document = makeTextDocument('class Avatar:\n    def fresh(self): pass\n', { fileName: files['avatar.py'], version: 2 });
    await index.onDocumentChanged(document);
    expect(await index.resolveSelfMethod(files['avatar.py'], 1, 'fresh')).toMatchObject({ line: 1 });
    index.onDocumentClosed(document);
    expect(await index.resolveSelfMethod(files['avatar.py'], 1, 'fresh')).toBeNull();
    expect(await index.resolveSelfMethod(files['avatar.py'], 1, 'old')).toMatchObject({ line: 1 });
  });

  it('an in-flight disk read cannot overwrite a newer unsaved edit', async () => {
    const { files, index } = fixture({ 'avatar.py': 'class Avatar:\n    def old(self): pass\n' });
    const readFile = fs.promises.readFile.bind(fs.promises);
    let release!: (value: string) => void;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(fs.promises, 'readFile').mockImplementation(((file: string, ...args: unknown[]) => {
      if (file === files['avatar.py']) {
        started();
        return new Promise<string>(resolve => { release = resolve; });
      }
      return (readFile as (...args: unknown[]) => unknown)(file, ...args);
    }) as typeof fs.promises.readFile);
    const scanning = index.findClassesByName('Avatar');
    await reading;
    await index.onDocumentChanged(makeTextDocument('class Avatar:\n    def fresh(self): pass\n', { fileName: files['avatar.py'], version: 2 }));
    release('class Avatar:\n    def old(self): pass\n');
    await scanning;
    expect(await index.resolveSelfMethod(files['avatar.py'], 1, 'fresh')).toMatchObject({ line: 1 });
    expect(await index.resolveSelfMethod(files['avatar.py'], 1, 'old')).toBeNull();
  });

  it('unsaved entity declarations refresh the derived composition roots', async () => {
    const { files, index } = fixture({ 'scripts/entities.xml': '<root><Old/></root>', 'scripts/mix.py': tick });
    expect(await index.rootsContaining('Old')).toEqual(['Old']);
    await index.onDocumentChanged(makeTextDocument('<root><Fresh/></root>', { fileName: files['scripts/entities.xml'], version: 2 }));
    expect(await index.rootsContaining('Fresh')).toEqual(['Fresh']);
    expect(await index.rootsContaining('Old')).toEqual([]);
  });

  it.each([
    'class Avatar:\n    def tick(self): pass\n    # self.tick()\n',
    'class Avatar:\n    def tick(self): pass\n    value = "self.tick()"\n',
    'class Avatar:\n    def tick(self): pass\n    """\n    self.tick()\n    """\n'
  ])('ignores self access text in comments and literals', async source => {
    const { files, index } = fixture({ 'avatar.py': source });
    const manager = { resolvePropertyDefinitionForClass: vi.fn(), resolvePropertyDefinition: vi.fn() };
    const provider = new PythonDefinitionProvider(manager as never, index);
    const document = makeTextDocument(source, { fileName: files['avatar.py'] });
    const lines = source.split('\n');
    const line = lines.findIndex(text => text.includes('self.tick'));
    expect(await provider.provideDefinition(document, new Position(line, lines[line].indexOf('tick') + 1))).toBeNull();
    expect(manager.resolvePropertyDefinition).not.toHaveBeenCalled();
  });

  it('jumps from a multiline aliased mixin base to its Python class definition', async () => {
    const source = 'from mix import RunMixin as RM\nclass Avatar(\n    RM,\n): pass\n';
    const { files, index } = fixture({ 'mix.py': tick, 'avatar.py': source });
    const provider = new PythonDefinitionProvider({} as never, index);
    const result = await provider.provideDefinition(makeTextDocument(source, { fileName: files['avatar.py'] }), new Position(2, 5));
    expect(result).toMatchObject({ uri: { fsPath: files['mix.py'] }, range: { start: { line: 0 } } });
  });
});

describe('incremental indexing and local candidates', () => {
  it('refreshes a changed file without rescanning the workspace and drops unreadable providers', async () => {
    const { files, index } = fixture({
      'mix.py': tick,
      'avatar.py': 'from mix import RunMixin\nclass Avatar(RunMixin):\n    def run(self):\n        self.tick()\n'
    });
    const find = vi.fn(workspace.findFiles);
    workspace.findFiles = find;
    expect(await index.resolveSelfMethod(files['avatar.py'], 3, 'tick')).toBeTruthy();
    const searches = find.mock.calls.length;
    fs.writeFileSync(files['mix.py'], 'class RunMixin:\n    def fresh(self): pass\n');
    await index.onFileChanged(files['mix.py']);
    expect(await index.resolveSelfMethod(files['avatar.py'], 3, 'fresh')).toMatchObject({ filePath: files['mix.py'] });
    expect(find.mock.calls.length).toBe(searches);
    fs.unlinkSync(files['mix.py']);
    await index.onFileChanged(files['mix.py']);
    expect(await index.resolveSelfMethod(files['avatar.py'], 3, 'fresh')).toBeNull();
  });

  it('local fallback returns every valid descendant implementation and excludes unrelated classes', async () => {
    setPythonMroJumpEnabled(false);
    const source = 'class Caller:\n    def run(self):\n        self.tick()\nclass First(Caller):\n    def tick(self): pass\nclass Second(Caller):\n    def tick(self): pass\nclass Unrelated:\n    def tick(self): pass\n';
    const manager = {
      resolvePropertyDefinitionForClass: async () => null, resolvePropertyDefinition: async () => null,
      resolveMethodDefinitionForClass: async () => null, resolveMethodDefinition: async () => null
    };
    const provider = new PythonDefinitionProvider(manager as never);
    const result = await provider.provideDefinition(makeTextDocument(source, { fileName: '/local.py' }), new Position(2, 15));
    expect(Array.isArray(result)).toBe(true);
    expect((result as Array<{ range: { start: { line: number } } }>).map(loc => loc.range.start.line)).toEqual([4, 6]);
  });
});

describe('multiple asset projects', () => {
  it('keeps same-name entity composition declarations isolated by assets directory', async () => {
    const sources: Record<string, string> = {};
    for (const project of ['a', 'b']) {
      const prefix = `${project}/scripts/`;
      sources[prefix + 'entities.xml'] = '<root><Avatar/></root>';
      sources[prefix + 'entity_defs/Avatar.def'] = `<root><Interfaces><interface>Caller</interface><interface>${project === 'a' ? 'Combat' : 'Craft'}</interface></Interfaces></root>`;
      sources[prefix + 'cell/Avatar.py'] = 'class Avatar: pass\n';
      sources[prefix + 'interfaces/Caller.py'] = 'class Caller:\n    def run(self):\n        self.tick()\n';
      sources[prefix + 'interfaces/providers.py'] = 'class Combat:\n    def tick(self): pass\nclass Craft:\n    def tick(self): pass\n';
    }
    const { files, index } = fixture(sources);
    const targets = await index.resolveSelfMethodCandidates(files['a/scripts/interfaces/Caller.py'], 2, 'tick');
    expect(targets.map(target => [target.filePath, target.className])).toEqual([
      [files['a/scripts/interfaces/providers.py'], 'Combat']
    ]);
  });
});
