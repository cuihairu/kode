import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  HookCategory,
  HOOK_CATEGORY_NAMES,
  KBENGINE_HOOKS,
  getHookByName,
  getHooksByCategory
} from '../src/hooks';
import { resolveEngineRoot } from './helpers/engineRoot';

const engineRoot = resolveEngineRoot();

// 与 src/hooks.ts 保持一致的分类计数(36 个回调)
const EXPECTED_COUNTS: Record<HookCategory, string[]> = {
  lifecycle: ['onDestroy', 'onTimer', 'onRestore'],
  database: ['onWriteToDB', 'onPreArchive'],
  movement: ['onMove', 'onMoveOver', 'onMoveFailure', 'onTurn'],
  space: ['onEnterSpace', 'onLeaveSpace', 'onSpaceGone'],
  teleport: ['onTeleport', 'onTeleportSuccess', 'onTeleportFailure'],
  trap: ['onEnterTrap', 'onLeaveTrap', 'onLeaveTrapID'],
  cell: [
    'onGetCell',
    'onCreateCellFailure',
    'onEnteredCell',
    'onEnteringCell',
    'onLeavingCell',
    'onLeftCell'
  ],
  witness: [
    'onGetWitness',
    'onLoseWitness',
    'onWitnessed',
    'onEnteredView',
    'onUpdateBegin',
    'onUpdateEnd'
  ],
  control: ['onLoseControlledBy'],
  client: [
    'onClientEnabled',
    'onLogOnAttempt',
    'onClientDeath',
    'onClientGetCell',
    'onStreamComplete'
  ]
};

describe('KBEngine hook data', () => {
  it('contains exactly 36 uniquely named hooks', () => {
    expect(KBENGINE_HOOKS).toHaveLength(36);
    const names = KBENGINE_HOOKS.map(hook => hook.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('categorizes hooks exactly as documented', () => {
    expect(Object.keys(HOOK_CATEGORY_NAMES).sort()).toEqual(
      Object.keys(EXPECTED_COUNTS).sort()
    );

    for (const [category, expected] of Object.entries(EXPECTED_COUNTS)) {
      expect(getHooksByCategory(category as HookCategory).map(hook => hook.name).sort())
        .toEqual([...expected].sort());
    }
  });

  it('documents every hook completely', () => {
    for (const hook of KBENGINE_HOOKS) {
      expect(hook.category in EXPECTED_COUNTS, hook.name).toBe(true);
      expect(hook.description.length, hook.name).toBeGreaterThan(0);
      expect(hook.documentation.length, hook.name).toBeGreaterThan(0);
      expect(hook.signature, hook.name).toMatch(new RegExp(`^def ${hook.name}\\(self[\\s\\S]*\\):`));
      expect(hook.timing.length, hook.name).toBeGreaterThan(0);
      expect(hook.sourceLocation, hook.name).toMatch(
        /^kbe\/src\/server\/(cellapp|baseapp)\/[\w./]+\.cpp:\d+(; kbe\/src\/server\/(cellapp|baseapp)\/[\w./]+\.cpp:\d+)*$/
      );
    }
  });

  it('exposes lookups by name and never resolves unknown hooks', () => {
    expect(getHookByName('onMove')?.category).toBe('movement');
    expect(getHookByName('onCreate')).toBeUndefined();
  });
});

describe.skipIf(!engineRoot)('KBEngine hooks vs engine source', () => {
  const engineFiles = [
    'kbe/src/server/cellapp/entity.cpp',
    'kbe/src/server/baseapp/entity.cpp',
    'kbe/src/server/baseapp/proxy.cpp',
    'kbe/src/server/cellapp/witness.cpp'
  ];

  const fileLines = new Map<string, string[]>();
  function readLines(relative: string): string[] {
    let lines = fileLines.get(relative);
    if (!lines) {
      lines = fs.readFileSync(path.join(engineRoot!, relative), 'utf8').split('\n');
      fileLines.set(relative, lines);
    }
    return lines;
  }

  it('names every hook as an engine script callback', () => {
    for (const hook of KBENGINE_HOOKS) {
      const invoked = engineFiles.some(file => readLines(file).some(line => line.includes(`"${hook.name}"`)));
      expect(invoked, `${hook.name} must be invoked by the engine`).toBe(true);
    }
  });

  it('points every sourceLocation at the line that invokes the callback', () => {
    let verified = 0;

    for (const hook of KBENGINE_HOOKS) {
      for (const ref of hook.sourceLocation!.split(';').map(part => part.trim())) {
        const match = /^(.+):(\d+)$/.exec(ref);
        expect(match, `malformed sourceLocation for ${hook.name}: ${ref}`).not.toBeNull();

        const [, file, lineText] = match!;
        const lines = readLines(file);
        expect(lines.length, `${file} exists`).toBeGreaterThan(0);

        const line = lines[Number(lineText) - 1] ?? '';
        expect(
          line.includes(`"${hook.name}"`),
          `${hook.name} expected at ${file}:${lineText}, got: ${line.trim().slice(0, 80)}`
        ).toBe(true);
        verified += 1;
      }
    }

    expect(verified).toBeGreaterThanOrEqual(KBENGINE_HOOKS.length);
  });
});
