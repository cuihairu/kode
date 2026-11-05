import { describe, expect, it } from 'vitest';
import * as path from 'path';
import {
  SOURCE_WRITE_SCOPE_MANAGED,
  SOURCE_WRITE_SCOPE_USER,
  assertWritable,
  buildInferArgs,
  discoverPyrefly
} from '../src/pyreflyInfer';

describe('pyreflyInfer', () => {
  describe('assertWritable (write-scope gate)', () => {
    const ws = '/ws';
    const managed = '.kbengine';

    it('allows writes inside managed dir in managed scope', () => {
      const decision = assertWritable('/ws/.kbengine/inferred/scripts/base/Avatar.py', SOURCE_WRITE_SCOPE_MANAGED, ws, managed, '/ws/scripts');
      expect(decision.allowed).toBe(true);
    });
    it('denies writes to user source in managed scope (default)', () => {
      const decision = assertWritable('/ws/scripts/base/Avatar.py', SOURCE_WRITE_SCOPE_MANAGED, ws, managed, '/ws/scripts');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('outside managed dir');
    });
    it('denies writes outside both scopes even in user scope', () => {
      const decision = assertWritable('/etc/passwd', SOURCE_WRITE_SCOPE_USER, ws, managed, '/ws/scripts');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBeDefined();
    });
    it('allows user source only in user scope (explicit opt-in)', () => {
      const decision = assertWritable('/ws/scripts/base/Avatar.py', SOURCE_WRITE_SCOPE_USER, ws, managed, '/ws/scripts');
      expect(decision.allowed).toBe(true);
    });
    it('never allows writes outside workspace root', () => {
      const decision = assertWritable('/other/place', SOURCE_WRITE_SCOPE_MANAGED, ws, managed, '/ws/scripts');
      expect(decision.allowed).toBe(false);
    });
  });

  describe('discoverPyrefly', () => {
    const noExists = () => false;
    it('honors explicit setting path when it exists', () => {
      const deps = { exists: (p: string) => p === '/opt/pyrefly', homeDir: '/home/u' };
      expect(discoverPyrefly('/opt/pyrefly', deps)).toBe('/opt/pyrefly');
    });
    it('falls back to PATH search', () => {
      // WIN-3:envPath 按平台分隔符拼——win32 split(';') 下 ':' 串不切分。
      const deps = {
        exists: (p: string) => p === '/usr/local/bin/pyrefly',
        envPath: ['/usr/bin', '/usr/local/bin'].join(path.delimiter),
        homeDir: '/home/u'
      };
      expect(discoverPyrefly('', deps)).toBe('/usr/local/bin/pyrefly');
    });
    it('falls back to pipx default location (~/.local/bin)', () => {
      const deps = { exists: (p: string) => p === '/home/u/.local/bin/pyrefly', envPath: '/usr/bin', homeDir: '/home/u' };
      expect(discoverPyrefly('', deps)).toBe('/home/u/.local/bin/pyrefly');
    });
    it('returns null when not found anywhere', () => {
      expect(discoverPyrefly('', { exists: noExists, envPath: '/usr/bin', homeDir: '/home/u' })).toBeNull();
    });
    it('returns null when setting path does not exist', () => {
      expect(discoverPyrefly('/nope', { exists: noExists })).toBeNull();
    });
  });

  describe('buildInferArgs', () => {
    it('builds infer command with python-version and search-path', () => {
      expect(buildInferArgs('3.7', ['/ws/.kbengine/stubs'], '/ws/.kbengine/inferred/scripts')).toEqual([
        'infer',
        '--python-version',
        '3.7',
        '--search-path',
        '/ws/.kbengine/stubs',
        '/ws/.kbengine/inferred/scripts'
      ]);
    });
    it('supports multiple search paths', () => {
      const args = buildInferArgs('3.7', ['/s1', '/s2'], '/t');
      expect(args.filter((a) => a === '--search-path')).toHaveLength(2);
    });
  });
});
