import { describe, expect, it } from 'vitest';
import {
  GITIGNORE_MARKER,
  detectVcs,
  exclusionKeyFor,
  gitignoreIgnores,
  gitignoreLineFor,
  planExclusion,
  planGitignoreAdd
} from '../src/managedDirExclusions';

describe('managedDirExclusions', () => {
  describe('exclusionKeyFor', () => {
    it('uses <managedDir>/** root-relative glob', () => {
      expect(exclusionKeyFor('.kbengine')).toBe('.kbengine/**');
    });
    it('strips surrounding slashes', () => {
      expect(exclusionKeyFor('/.kbengine/')).toBe('.kbengine/**');
    });
  });

  describe('gitignoreLineFor', () => {
    it('appends trailing slash (directory form only)', () => {
      expect(gitignoreLineFor('.kbengine')).toBe('.kbengine/');
      expect(gitignoreLineFor('mykbe')).toBe('mykbe/');
    });
  });

  describe('gitignoreIgnores', () => {
    it('matches exact directory forms', () => {
      expect(gitignoreIgnores('.kbengine\n', '.kbengine')).toBe(true);
      expect(gitignoreIgnores('.kbengine/\n', '.kbengine')).toBe(true);
      expect(gitignoreIgnores('/.kbengine\n', '.kbengine')).toBe(true);
      expect(gitignoreIgnores('/.kbengine/\n', '.kbengine')).toBe(true);
      expect(gitignoreIgnores('.kbengine/stubs/\n', '.kbengine')).toBe(true);
    });
    it('does not match user wildcard globs (conservative: re-add own segment)', () => {
      expect(gitignoreIgnores('**/.kbengine/**\n', '.kbengine')).toBe(false);
      expect(gitignoreIgnores('*.pyc\n', '.kbengine')).toBe(false);
    });
    it('ignores blank lines and comments', () => {
      expect(gitignoreIgnores('# comment\n\n.kbengine/\n', '.kbengine')).toBe(true);
      expect(gitignoreIgnores('# only comment\n', '.kbengine')).toBe(false);
    });
  });

  describe('planGitignoreAdd', () => {
    it('appends marker + line to empty content', () => {
      const plan = planGitignoreAdd('', '.kbengine');
      expect(plan.action).toBe('append');
      if (plan.action === 'append') {
        expect(plan.nextContent).toBe(`${GITIGNORE_MARKER}\n.kbengine/\n`);
      }
    });
    it('appends after existing content, preserving it', () => {
      const plan = planGitignoreAdd('node_modules/\n', '.kbengine');
      if (plan.action === 'append') {
        expect(plan.nextContent).toBe(`node_modules/\n${GITIGNORE_MARKER}\n.kbengine/\n`);
      } else {
        expect.unreachable('should append');
      }
    });
    it('is a no-op when already ignored', () => {
      expect(planGitignoreAdd('.kbengine/\n', '.kbengine').action).toBe('none');
    });
    it('is a no-op when kode segment already present', () => {
      expect(planGitignoreAdd(`${GITIGNORE_MARKER}\n.kbengine/\n`, '.kbengine').action).toBe('none');
    });
    it('reappends own segment even if user wrote a wildcard (never trust user glob as coverage)', () => {
      expect(planGitignoreAdd('**/.kbengine/**\n', '.kbengine').action).toBe('append');
    });
  });

  describe('detectVcs', () => {
    it('prefers git over svn', () => {
      const deps = {
        findGitRoot: () => '/repo',
        findSvnRoot: () => '/repo'
      };
      expect(detectVcs(deps, '/repo')).toEqual({ kind: 'git', root: '/repo' });
    });
    it('detects svn when no git', () => {
      const deps = { findGitRoot: () => null, findSvnRoot: () => '/svn' };
      expect(detectVcs(deps, '/x')).toEqual({ kind: 'svn', root: '/svn' });
    });
    it('none when neither', () => {
      const deps = { findGitRoot: () => null, findSvnRoot: () => null };
      expect(detectVcs(deps, '/x')).toEqual({ kind: 'none', root: null });
    });
  });

  describe('planExclusion', () => {
    const managedKey = '.kbengine/**';
    it('adds managed key when enabled and nothing present', () => {
      const plan = planExclusion({}, '.kbengine', [], true);
      expect(plan.next).toEqual({ [managedKey]: true });
      expect(plan.changed).toBe(true);
      expect(plan.managedKeys).toEqual([managedKey]);
    });
    it('preserves user entries while adding managed', () => {
      const plan = planExclusion({ '**/*.pyc': true }, '.kbengine', [], true);
      expect(plan.next).toEqual({ '**/*.pyc': true, [managedKey]: true });
    });
    it('removes stale managed key (setting change) and keeps user', () => {
      const plan = planExclusion({ '**/*.pyc': true, '.kbengine/**': true }, '.kbengine', ['.kbengine/**'], true);
      expect(plan.next).toEqual({ '**/*.pyc': true, [managedKey]: true });
    });
    it('removes managed key when disabled, keeps user', () => {
      const plan = planExclusion({ '**/*.pyc': true, '.kbengine/**': true }, '.kbengine', ['.kbengine/**'], false);
      expect(plan.next).toEqual({ '**/*.pyc': true });
      expect(plan.managedKeys).toEqual([]);
    });
    it('is unchanged when value already correct', () => {
      const plan = planExclusion({ [managedKey]: true }, '.kbengine', [managedKey], true);
      expect(plan.changed).toBe(false);
    });
    it('handles non-object current without crashing', () => {
      const plan = planExclusion('not-an-object', '.kbengine', [], true);
      expect(plan.next).toEqual({ [managedKey]: true });
    });
  });
});
