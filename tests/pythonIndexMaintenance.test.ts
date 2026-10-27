import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { PythonClassIndex } from '../src/pythonClassIndex';
import { EntityMappingManager } from '../src/entityMapping';
import { PY_SCAN_EXCLUDE, PY_SCAN_EXCLUDED_DIRS } from '../src/pythonScanRules';
import { resetScanRootCache } from '../src/scanRoots';
import { Uri, workspace } from './helpers/vscodeStub';
import { configurationOverrides } from './fake-vscode/workspaceState';

type ClassIndexInternals = {
  updateFile(file: string, content: string, version: number): void;
  invalidate(file: string, kind: 'delete'): void;
  byName: Map<string, Array<{ filePath: string }>>;
};

describe('Python index maintenance', () => {
  it('indexes new files without visiting existing buckets and removes only the changed file', () => {
    const index = new PythonClassIndex() as unknown as ClassIndexInternals;
    let bucketReads = 0;
    const originalGet = index.byName.get.bind(index.byName);
    index.byName.get = (name: string) => { bucketReads += 1; return originalGet(name); };
    for (let i = 0; i < 2_000; i += 1) {
      index.updateFile(`/project/${i}.py`, `class Unique${i}:\n    pass\n`, 1);
    }
    // One read for each new class; the old implementation visited 1,999,000 buckets.
    expect(bucketReads).toBe(2_000);
    index.updateFile('/project/a.py', 'class Shared:\n    pass\n', 1);
    index.updateFile('/project/b.py', 'class Shared:\n    pass\n', 1);
    index.updateFile('/project/a.py', 'class Renamed:\n    pass\n', 2);
    expect(index.byName.get('Shared')?.map(cls => cls.filePath)).toEqual(['/project/b.py']);
    expect(index.byName.get('Renamed')?.map(cls => cls.filePath)).toEqual(['/project/a.py']);
    index.invalidate('/project/b.py', 'delete');
    expect(index.byName.has('Shared')).toBe(false);
    expect(index.byName.has('Unique1999')).toBe(true);
  });

  it('loads an explicit local import while workspace discovery is still pending', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-python-local-'));
    const importer = path.join(root, 'Child.py');
    const dependency = path.join(root, 'Base.py');
    fs.writeFileSync(importer, 'from Base import Base\nclass Child(Base):\n    pass\n');
    fs.writeFileSync(dependency, 'class Base:\n    def work(self):\n        pass\n');
    try {
      const index = new PythonClassIndex() as unknown as ClassIndexInternals & {
        stageRequestFiles(file: string): Promise<void>;
        ensureDiscovered(): Promise<never>;
      };
      index.updateFile(importer, fs.readFileSync(importer, 'utf8'), 1);
      index.ensureDiscovered = () => new Promise<never>(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([
        index.stageRequestFiles(importer).then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 300); })
      ]);
      if (timer) { clearTimeout(timer); }
      expect(finished).toBe(true);
      expect(index.byName.get('Base')?.map(cls => cls.filePath)).toEqual([dependency]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a new or uncached Python file does not invalidate the whole scan generation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-python-create-'));
    const file = path.join(root, 'New.py');
    const index = new PythonClassIndex() as unknown as ClassIndexInternals & {
      scanGeneration: number;
      onFileChanged(file: string): Promise<void>;
    };
    try {
      const generation = index.scanGeneration;
      index.invalidate(file, 'delete');
      expect(index.scanGeneration).toBe(generation);
      fs.writeFileSync(file, 'class New:\n    pass\n');
      await index.onFileChanged(file);
      expect(index.scanGeneration).toBe(generation);
      expect(index.byName.get('New')?.map(cls => cls.filePath)).toEqual([file]);
      const vendor = path.join(root, 'third_party', 'Vendor.py');
      fs.mkdirSync(path.dirname(vendor));
      fs.writeFileSync(vendor, 'class Vendor:\n    pass\n');
      await index.onFileChanged(vendor);
      expect(index.byName.has('Vendor')).toBe(false);
      expect(index.scanGeneration).toBe(generation);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops queuing request-local dependency batches after cancellation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-python-cancel-'));
    const importer = path.join(root, 'Caller.py');
    const source = Array.from({ length: 20 }, (_, i) => `import Module${i}`).join('\n') + '\nclass Caller: pass\n';
    fs.writeFileSync(importer, source);
    const token = { isCancellationRequested: false };
    const index = new PythonClassIndex() as unknown as ClassIndexInternals & {
      stageRequestFiles(file: string, token: unknown): Promise<void>;
      loadFileOnDemand(file: string): Promise<void>;
    };
    try {
      index.updateFile(importer, source, 1);
      let queued = 0;
      index.loadFileOnDemand = async () => {
        queued += 1;
        if (queued === 8) { token.isCancellationRequested = true; }
      };
      await index.stageRequestFiles(importer, token);
      expect(queued).toBe(8);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the same excluded directories for workspace discovery and method scanning', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-python-rules-'));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-python-assets-'));
    const oldFolders = workspace.workspaceFolders;
    const oldFindFiles = workspace.findFiles;
    const write = (relative: string) => {
      const full = path.join(root, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'def target():\n    pass\n');
      return full;
    };
    try {
      const business = write('scripts/base/Avatar.py');
      const externalBusiness = path.join(external, 'scripts', 'cell', 'Avatar.py');
      fs.mkdirSync(path.dirname(externalBusiness), { recursive: true });
      fs.writeFileSync(externalBusiness, 'def target():\n    pass\n');
      for (const dir of PY_SCAN_EXCLUDED_DIRS) { write(`${dir}/Noise.py`); }
      for (const dir of PY_SCAN_EXCLUDED_DIRS) {
        fs.mkdirSync(path.join(external, dir), { recursive: true });
        fs.writeFileSync(path.join(external, dir, 'Noise.py'), 'def target():\n    pass\n');
      }
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      workspace.findFiles = (async () => []) as typeof workspace.findFiles;
      configurationOverrides.set('kbengine', { assetsRoot: external });
      resetScanRootCache();
      const manager = new EntityMappingManager({ subscriptions: [] } as never, undefined, { deferStartup: true });
      const internal = manager as unknown as {
        performBuildPythonDefIndex(): Promise<Map<string, Array<{ filePath: string }>>>;
        buildPythonDefIndex(): Promise<Map<string, Array<{ filePath: string }>>>;
        handlePythonFileChanged(file: string): void;
      };
      const hits = await internal.performBuildPythonDefIndex();
      expect(hits.get('target')?.map(hit => hit.filePath)).toEqual([business, externalBusiness]);
      expect(PY_SCAN_EXCLUDE).toBe(`**/{${[...PY_SCAN_EXCLUDED_DIRS].join(',')}}/**`);

      // A save or deletion updates the published index without another tree walk.
      const published = await internal.buildPythonDefIndex();
      const originalReaddir = fs.promises.readdir;
      let directoryReads = 0;
      fs.promises.readdir = (async (...args: Parameters<typeof originalReaddir>) => {
        directoryReads += 1;
        return originalReaddir(...args);
      }) as typeof fs.promises.readdir;
      try {
        fs.writeFileSync(business, 'def changed():\n    pass\n');
        internal.handlePythonFileChanged(business);
        expect(await internal.buildPythonDefIndex()).toBe(published);
        expect(published.get('target')?.map(hit => hit.filePath)).toEqual([externalBusiness]);
        expect(published.get('changed')?.map(hit => hit.filePath)).toEqual([business]);
        fs.rmSync(business);
        internal.handlePythonFileChanged(business);
        await internal.buildPythonDefIndex();
        expect(published.has('changed')).toBe(false);
        expect(directoryReads).toBe(0);
      } finally {
        fs.promises.readdir = originalReaddir;
      }
    } finally {
      workspace.workspaceFolders = oldFolders;
      workspace.findFiles = oldFindFiles;
      configurationOverrides.delete('kbengine');
      resetScanRootCache();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('applies a save that arrives during the first method-index build before publishing results', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-python-race-'));
    const file = path.join(root, 'Hero.py');
    fs.writeFileSync(file, 'def old_method():\n    pass\n');
    const oldFolders = workspace.workspaceFolders;
    const oldFindFiles = workspace.findFiles;
    const originalRead = fs.promises.readFile;
    let reading!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.findFiles = (async () => []) as typeof workspace.findFiles;
    fs.promises.readFile = (async (...args: Parameters<typeof originalRead>) => {
      if (String(args[0]) === file && !held) {
        held = true;
        const oldText = await originalRead(...args);
        reading();
        await gate;
        return oldText;
      }
      return originalRead(...args);
    }) as typeof fs.promises.readFile;
    try {
      const manager = new EntityMappingManager({ subscriptions: [] } as never, undefined, { deferStartup: true });
      const internal = manager as unknown as {
        buildPythonDefIndex(): Promise<Map<string, Array<{ filePath: string }>>>;
        handlePythonFileChanged(file: string): void;
      };
      void internal.buildPythonDefIndex();
      await started;
      fs.writeFileSync(file, 'def new_method():\n    pass\n');
      internal.handlePythonFileChanged(file);
      release();
      const index = await internal.buildPythonDefIndex();
      expect(index.has('old_method')).toBe(false);
      expect(index.get('new_method')?.map(hit => hit.filePath)).toEqual([file]);
    } finally {
      release();
      fs.promises.readFile = originalRead;
      workspace.workspaceFolders = oldFolders;
      workspace.findFiles = oldFindFiles;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
