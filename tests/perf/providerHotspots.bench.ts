import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it } from 'vitest';
import { buildDefCallChain } from '../../src/defCallChain';
import { parseDefDocument } from '../../src/defParser';
import { EntityMappingManager } from '../../src/entityMapping';
import type { EntityMappingIndex } from '../../src/entityMapping';
import { resolveLocalVariableReturnType } from '../../src/pythonReturnTypeInference';
import { resetPythonReturnAnnotationCache } from '../../src/pythonReturnTypeInference';
import { resetScanRootCache } from '../../src/scanRoots';
import { Uri } from '../helpers/vscodeStub';
import { workspace as stubWorkspace } from '../fake-vscode/workspaceState';
import { buildLargeDefFixture } from '../helpers/largeDefFixture';

const documentLines = [
  'class Avatar:',
  '    def run(self):',
  '        data = loader.get_data()',
  '        return data'
];
const documentText = documentLines.join('\n');
const originalFindFiles = stubWorkspace.findFiles;
const resetBenchmarkCaches = (): void => {
  resetScanRootCache();
  resetPythonReturnAnnotationCache();
};
const document = {
  getText: () => documentText
};

function buildTree(root: string): void {
  for (const directory of ['scripts/entity_defs', 'scripts/base', 'scripts/cell']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, 'scripts/entity_defs/Avatar.def'), '<root><BaseMethods><run/></BaseMethods></root>');
  for (let file = 0; file < 120; file += 1) {
    writeFileSync(
      join(root, `scripts/base/Module${file}.py`),
      `class Module${file}:\n    def unrelated_${file}(self):\n        return ${file}\n`
    );
  }
  writeFileSync(
    join(root, 'scripts/cell/AnnotationSource.py'),
    'class AnnotationSource:\n    def get_data(self) -> JSONDATA:\n        return {}\n'
  );
}

function managerFor(root: string): EntityMappingManager {
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'workspace', index: 0 }];
  stubWorkspace.findFiles = async pattern =>
    typeof pattern === 'string' && pattern.includes('*.def')
      ? [Uri.file(join(root, 'scripts/entity_defs/Avatar.def'))]
      : [];
  return new EntityMappingManager({ subscriptions: [] });
}

function median(samples: number[]): number {
  return [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)];
}

function measureSync(
  name: string,
  operation: () => unknown,
  iterations = 9
): void {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    operation();
  }
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    operation();
    samples.push(performance.now() - started);
  }
  console.log(`PERF ${name} median=${median(samples).toFixed(3)}ms max=${Math.max(...samples).toFixed(3)}ms`);
}

async function measure(
  name: string,
  operation: () => unknown | Promise<unknown>,
  iterations = 31
): Promise<void> {
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  console.log(`PERF ${name} median=${median(samples).toFixed(3)}ms`);
}

describe('provider hotspots', () => {
  let root = '';
  let manager: EntityMappingManager;
  let index: EntityMappingIndex | undefined;

  it('documents measured hotspots', async () => {
    const largeDef = buildLargeDefFixture();
    measureSync('large def document parse', () => parseDefDocument(largeDef));

    await measure('document reparsing', async () => {
      const lines = document.getText().split(/\r?\n/);
      await manager.resolveMethodDefinition('/project/scripts/base/Avatar.py', 'run');
      await manager.getEntityComponentFacesForPythonFile('/project/scripts/base/Avatar.py');
      resolveLocalVariableReturnType(lines, 2, 'data', root);
    });

    await measure('project method fallback', () =>
      manager.resolveMethodDefinition('/project/scripts/base/Missing.py', 'missing_method')
    );

    await measure('call chain BFS', () => {
      if (index) {
        buildDefCallChain(index, { filePath: '/project/scripts/entity_defs/Avatar.def', methodName: 'run', line: 2 });
      }
    });
  });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'kode-perf-'));
    buildTree(root);
    resetBenchmarkCaches();
    manager = managerFor(root);
    await manager.waitForInitialScan();
    index = manager.getIndex('Avatar');
    if (!index) {
      throw new Error('Avatar def was not indexed');
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    stubWorkspace.findFiles = originalFindFiles;
    resetBenchmarkCaches();
  });
});
