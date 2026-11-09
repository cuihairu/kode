import { describe, expect, it } from 'vitest';
import {
  inferredDirFor,
  listSourceFiles,
  mirrorPrefixFor,
  planInferredMirror
} from '../src/backend/inferredCopy';

describe('inferredCopy', () => {
  describe('inferredDirFor', () => {
    it('nests under managed dir', () => {
      expect(inferredDirFor('.kbengine')).toBe('.kbengine/inferred');
      expect(inferredDirFor('mykbe')).toBe('mykbe/inferred');
    });
  });

  describe('mirrorPrefixFor', () => {
    it('uses workspace-relative path of scripts root', () => {
      expect(mirrorPrefixFor('/ws', '/ws/scripts')).toBe('scripts');
      expect(mirrorPrefixFor('/ws', '/ws/assets/scripts')).toBe('assets/scripts');
    });
  });

  describe('planInferredMirror', () => {
    const srcRoot = '/ws/scripts';
    const inferredRoot = '/ws/.kbengine/inferred/scripts';

    it('classifies copy / unchanged / overwrite by content compare', () => {
      const files: Record<string, string> = {
        '/ws/scripts/base/Avatar.py': 'class Avatar: pass',
        '/ws/.kbengine/inferred/scripts/base/Avatar.py': 'class Avatar: pass',
        '/ws/scripts/base/Account.py': 'class Account: pass',
        '/ws/.kbengine/inferred/scripts/base/Account.py': 'class Account:  pass',
        '/ws/scripts/base/Monster.py': 'class Monster: pass'
      };
      // WIN-3:产品用 path.join 拼读取路径(win32 反斜杠),查找键同口径归一
      const deps = { readText: (p: string) => files[p.replace(/\\/g, '/')] ?? null };
      const plan = planInferredMirror(
        srcRoot,
        inferredRoot,
        ['base/Avatar.py', 'base/Account.py', 'base/Monster.py'],
        ['base/Avatar.py', 'base/Account.py'],
        deps
      );
      expect(plan.unchanged).toEqual(['base/Avatar.py']);
      expect(plan.copy).toEqual(['base/Monster.py']);
      expect(plan.overwrite).toEqual(['base/Account.py']);
      expect(plan.deleteStale).toEqual([]);
    });

    it('flags stale mirror entries for deletion only within managed set', () => {
      const deps = { readText: () => null };
      const plan = planInferredMirror(
        srcRoot,
        inferredRoot,
        ['base/Avatar.py'],
        ['base/Avatar.py', 'base/Gone.py'],
        deps
      );
      expect(plan.deleteStale).toEqual(['base/Gone.py']);
      expect(plan.copy).toEqual(['base/Avatar.py']);
    });

    it('skips a source file that disappears mid-plan', () => {
      const files: Record<string, string> = {
        '/ws/.kbengine/inferred/scripts/base/X.py': 'old'
      };
      // WIN-3:产品用 path.join 拼读取路径(win32 反斜杠),查找键同口径归一
      const deps = { readText: (p: string) => files[p.replace(/\\/g, '/')] ?? null };
      const plan = planInferredMirror(srcRoot, inferredRoot, ['base/X.py'], ['base/X.py'], deps);
      expect(plan.copy).toEqual([]);
      expect(plan.overwrite).toEqual([]);
      expect(plan.unchanged).toEqual([]);
    });
  });

  describe('listSourceFiles', () => {
    it('walks nested dirs collecting .py/.pyi only', () => {
      const tree: Record<string, readonly { name: string; isDir: boolean }[]> = {
        '/ws/scripts': [
          { name: 'base', isDir: true },
          { name: 'kbemain.py', isDir: false },
          { name: 'readme.md', isDir: false },
          { name: 'entity_defs', isDir: true }
        ],
        '/ws/scripts/base': [
          { name: 'Avatar.py', isDir: false },
          { name: 'Account.pyi', isDir: false },
          { name: 'notes.txt', isDir: false }
        ],
        '/ws/scripts/entity_defs': [{ name: 'Avatar.def', isDir: false }]
      };
      const deps = { listDir: (p: string) => tree[p] ?? [] };
      const result = listSourceFiles('/ws/scripts', deps);
      expect(result.files.sort()).toEqual(['base/Account.pyi', 'base/Avatar.py', 'kbemain.py']);
      expect(result.incomplete).toBe(false);
    });
    it('marks unreadable dir incomplete instead of returning empty as if absent', () => {
      const deps = {
        listDir: () => {
          throw new Error('nope');
        }
      };
      expect(listSourceFiles('/missing', deps)).toEqual({ files: [], incomplete: true });
    });
    it('marks incomplete when a nested dir read fails (partial walk)', () => {
      const tree: Record<string, readonly { name: string; isDir: boolean }[]> = {
        '/ws/scripts': [
          { name: 'base', isDir: true },
          { name: 'kbemain.py', isDir: false }
        ]
      };
      const deps = {
        listDir: (p: string): readonly { name: string; isDir: boolean }[] => {
          if (p === '/ws/scripts/base') {
            throw new Error('EACCES');
          }
          return tree[p] ?? [];
        }
      };
      const result = listSourceFiles('/ws/scripts', deps);
      expect(result.files).toEqual(['kbemain.py']);
      expect(result.incomplete).toBe(true);
    });
  });
});
