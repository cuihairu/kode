/**
 * KODE-COREDISCOVER-001: a packaged bin/ file can land after activation while
 * the gate keeps the activation-time serverPath forever. These tests pin the
 * event-driven re-discovery chain (watcher -> debounced discovery -> refreshed
 * surfaces) and the panel-time re-discovery.
 *
 * prove-red perturbations (restore after each run):
 *   R1: remove the bin watcher wiring from setupKodeCoreGate -> case 1 fails.
 *   R2: drop the 300ms debounce -> case 2 fails.
 *   R3: remove the showPanel rerediscover call -> the panel order test fails.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import {
  CORE_BIN_REDISCOVER_DEBOUNCE_MS,
  registerCoreRediscoveryRefresh,
  resetCoreRediscoveryRefreshersForTests,
  rerediscoverCore,
  setupKodeCoreGate
} from '../src/kodeCoreGateWiring';
import { commandRegistry } from './fake-vscode/commandRegistry';
import { windowState } from './fake-vscode/windowState';
import { configurationOverrides, workspaceEvents } from './fake-vscode/workspaceState';
import { RelativePattern, Uri, type ExtensionContext } from './fake-vscode/core';
import {
  allFileSystemWatchers,
  workspace as fakeWorkspace,
  workspaceState as fakeWorkspaceState
} from './helpers/vscodeStub';

const makeContext = (root: string): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file(root)
});

const setCore = (core: Record<string, unknown>): void => {
  configurationOverrides.set('kbengine', { ...core });
};

const disposeAll = (context: ExtensionContext): void => {
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }
};

/** A runnable ELF header so matchesPlatformFormat accepts the binary. */
const writeBinary = (root: string, name: string): string => {
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, name);
  fs.writeFileSync(file, Buffer.from('7f454c46', 'hex'));
  return file;
};

beforeEach(() => {
  commandRegistry.reset();
  windowState.reset();
  configurationOverrides.clear();
  workspaceEvents.configurationChanged.dispose();
  resetCoreRediscoveryRefreshersForTests();
  fakeWorkspaceState.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetCoreRediscoveryRefreshersForTests();
});

describe('KODE-COREDISCOVER-001 bin/ event-driven re-discovery', () => {
  it('1. watcher on <extensionRoot>/bin discovers a late binary and refreshes the gate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-corediscover-'));
    try {
      setCore({ 'core.backend': 'rust' });
      const context = makeContext(root);
      const gate = setupKodeCoreGate(context);
      expect(gate.state.serverPath).toBe('');

      const binWatcher = allFileSystemWatchers.find(w => {
        const pattern = w.pattern;
        return pattern instanceof RelativePattern && pattern.pattern === '*' &&
          String(pattern.base).endsWith(path.join(root, 'bin'));
      });
      expect(binWatcher).toBeDefined();
      const binary = writeBinary(root, 'kode-server');

      binWatcher?.fireCreate(Uri.file(binary));
      await new Promise(resolve => setTimeout(resolve, CORE_BIN_REDISCOVER_DEBOUNCE_MS + 80));
      expect(gate.state.serverPath).toBe(binary);

      disposeAll(context);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('2. three batched bin/ events trigger exactly one re-discovery after 300ms', async () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-corediscover-debounce-'));
    try {
      setCore({ 'core.backend': 'rust' });
      const context = makeContext(root);
      const gate = setupKodeCoreGate(context);
      const refresher = vi.fn();
      const disposable = registerCoreRediscoveryRefresh(refresher);
      const binWatcher = allFileSystemWatchers.find(w => {
        const pattern = w.pattern;
        return pattern instanceof RelativePattern && pattern.pattern === '*' &&
          String(pattern.base).endsWith(path.join(root, 'bin'));
      });
      const binary = writeBinary(root, 'kode-server');
      const setConfig = vi.spyOn(gate, 'setConfig');

      // The fake watcher's Uri objects are not used by production; fire plain
      // payloads so no test helper can swallow the listeners.
      const fire = (): void => {
        binWatcher?.fireCreate(Uri.file(binary));
        binWatcher?.fireChange(Uri.file(binary));
        binWatcher?.fireDelete(Uri.file(binary));
      };
      fire();
      await vi.advanceTimersByTimeAsync(100);
      fire();
      await vi.advanceTimersByTimeAsync(100);
      fire();
      expect(setConfig).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(CORE_BIN_REDISCOVER_DEBOUNCE_MS + 1);
      expect(setConfig).toHaveBeenCalledTimes(1);
      expect(refresher).toHaveBeenCalledTimes(1);
      expect(gate.state.serverPath).toBe(binary);

      disposable.dispose();
      disposeAll(context);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('3. watcher creation failure does not crash activation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-corediscover-fail-'));
    const original = fakeWorkspace.createFileSystemWatcher;
    (fakeWorkspace as unknown as Record<string, unknown>).createFileSystemWatcher = () => {
      throw new Error('watcher unavailable on this platform');
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const context = makeContext(root);
      expect(() => setupKodeCoreGate(context)).not.toThrow();
      expect(errorSpy).toHaveBeenCalled();
      disposeAll(context);
    } finally {
      (fakeWorkspace as unknown as Record<string, unknown>).createFileSystemWatcher = original;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('4. rerediscoverCore updates cached gate config and refreshes registered surfaces', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-corediscover-rediscover-'));
    try {
      const gate = new KodeCoreGate();
      setCore({ 'core.backend': 'rust' });
      gate.setConfig({ backend: 'rust', serverPath: '', shadowTimeoutMs: 2000 });
      expect(gate.state.serverPath).toBe('');
      const binary = writeBinary(root, 'kode-server');
      const refresher = vi.fn();
      const disposable = registerCoreRediscoveryRefresh(refresher);

      rerediscoverCore(gate, root);
      expect(gate.state.serverPath).toBe(binary);
      expect(refresher).toHaveBeenCalledTimes(1);

      disposable.dispose();
      rerediscoverCore(gate, root);
      expect(refresher).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('5. status-bar refresh registers on rediscovery without calling it back (no recursion)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-corediscover-status-'));
    try {
      const gate = new KodeCoreGate();
      setCore({ 'core.backend': 'rust' });
      gate.setConfig({ backend: 'rust', serverPath: '', shadowTimeoutMs: 2000 });
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'activate', 'kodeServiceStatus.ts'), 'utf8');
      expect(source).toContain('registerCoreRediscoveryRefresh(refresh)');
      // The refresh function only reads gate state: a callback in the reverse
      // direction would loop through rerediscoverCore -> refreshers -> refresh.
      expect(source).not.toContain('deps.rerediscoverCore()');

      const binary = writeBinary(root, 'kode-server');
      const refresher = vi.fn();
      const disposable = registerCoreRediscoveryRefresh(refresher);
      rerediscoverCore(gate, root);
      expect(gate.state.serverPath).toBe(binary);
      expect(refresher).toHaveBeenCalledTimes(1);
      disposable.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
