/**
 * KBEngine process memory monitor panel (right-column webview): dynamic
 * charts of per-process memory usage over time. Data rides the existing
 * telnet face (no new channel): selecting a component opens a persistent
 * session; each sample period (kbengine.memoryMonitor.sampleHz, 0.5/1/2)
 * sends one exec sampling command; the extension side parses RSS/entity
 * count/debugTracing counters before posting to the panel — the panel only
 * draws (canvas must not use CSS variables — var(--xx) silently fails in
 * 2D contexts, literal colors only).
 *
 * - Process switching: drop the old telnet, connect the new (targets =
 *   telnet target table keyed by component name; port/password share the
 *   same derivation chain as the telnet face); the data window clears and
 *   resampling starts;
 * - Disconnect: exponential-backoff reconnect (1s start, x2, capped 30s),
 *   the status dot reports honestly, no error-dialog bombardment;
 * - Leak counters: debugTracing counter chips get a red border when
 *   nonzero; any type nonzero for 3 consecutive sample periods fires one
 *   VS Code warning (deduplicated, re-armed after returning to zero);
 * - Pause: stop sampling, keep curves; Clear: drop the data.
 */

import * as vscode from 'vscode';
import { discoverLocalComponents } from './backend/kbengineProtocol';
import { l10nText } from './nlsRuntime';
import { KBEngineTelnetClient } from './backend/telnetClient';
import {
  buildMemorySampleCommand,
  computeYRange,
  LeakAlertGate,
  MemorySampleWindow,
  nextBackoffMs,
  parseLeakCounters,
  parseMemorySample
} from './backend/memorySampler';
import { randomNonce, toJsonForScript, webviewScriptCsp } from './webviewSecurity';
import { WEBVIEW_THEME_CSS } from './webviewTheme';
import { htmlLang, resolvePanelLocale, strings, type WebviewLocale } from './webviewStrings';
import { readTelnetTargetsFromSettings } from './telnetService';

export const MEMORY_MONITOR_COMMAND = 'kbengine.memoryMonitor.show';

/** One top-bar button's target (= a telnet target-table row; same-named components expand as #2/#3) */
export interface MemoryMonitorTarget {
  key: string;
  /** Component type name (cellapp/baseapp/loginapp/dbmgr/...) */
  component: string;
  /** Button label (same-named instances append #2/#3) */
  label: string;
  host: string;
  port: number;
  password: string;
}

/** Top-bar status dot: green=sampling / yellow=process alive but session down (backoff) / red=discovery face has no such process */
export type MonitorDotState = 'ok' | 'warn' | 'err';

/** Minimal telnet session surface (real = KBEngineTelnetClient adapter; tests inject a fake) */
export interface MonitorTelnetSession {
  connect(): void;
  disconnect(): void;
  isReady(): boolean;
  sendCommand(command: string): boolean;
  onData(listener: (text: string) => void): void;
  onClose(listener: (hadError: boolean) => void): void;
}

export interface MemoryMonitorDeps {
  /** Telnet target table (same derivation chain as the telnet face; port/password same source) */
  resolveTargets(): MemoryMonitorTarget[];
  /** Machine discovery face: set of alive component type names */
  discoverAlive(): Promise<Set<string>>;
  /** Sample frequency Hz (read fresh every beat; config change takes effect next sample; 0.5/1/2) */
  getSampleHz(): number;
  /** Webview outlet (parsed data only reaches the panel) */
  post(message: unknown): void;
  /** Leak alert outlet (vscode.window.showWarningMessage; tests collect) */
  notifyWarning(message: string): void;
  /** Session factory (production = KBEngineTelnetClient adapter; tests inject a fake) */
  createSession(target: MemoryMonitorTarget): MonitorTelnetSession;
  /** Leak warning wording (production = l10nText; tests inject) */
  formatLeakWarning(type: string, count: number): string;
  timers?: {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

/** Default session: wrap one KBEngineTelnetClient (same construction shape as the hot-reload channel connector) */
export const defaultMonitorSessionFactory = (target: MemoryMonitorTarget): MonitorTelnetSession => {
  let dataListener: ((text: string) => void) | undefined;
  let closeListener: ((hadError: boolean) => void) | undefined;
  const client = new KBEngineTelnetClient({
    host: target.host,
    port: target.port,
    ...(target.password ? { password: target.password } : {}),
    events: {
      onData: text => dataListener?.(text),
      onClose: hadError => closeListener?.(hadError)
    }
  });
  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    isReady: () => client.state === 'ready',
    sendCommand: command => client.sendCommand(command),
    onData: listener => {
      dataListener = listener;
    },
    onClose: listener => {
      closeListener = listener;
    }
  };
};

/** Response buffer cap: a bad stream (never producing a marker line) gets tail-truncated, memory bounded */
const SAMPLE_BUFFER_CAP = 64 * 1024;

/** Discovery face low-frequency refresh interval: dots follow process birth/death, never competes with the sampling beat */
const ALIVE_REFRESH_MS = 5000;

interface ActiveSession {
  target: MemoryMonitorTarget;
  session: MonitorTelnetSession;
  /** Accumulated downstream (marker lines and debugTracing lines all surface here) */
  buffer: string;
  reconnectTimer: unknown;
  state: 'connecting' | 'ok' | 'backoff';
}

export class MemoryMonitorController {
  private targets: MemoryMonitorTarget[] = [];
  private readonly sessions = new Map<string, ActiveSession>();
  /** Backoff attempt counter per target key — survives reconnect rounds (a new session resets to zero, the ladder must not) */
  private readonly backoffAttempts = new Map<string, number>();
  private selectedKey: string | null = null;
  private readonly window = new MemorySampleWindow();
  private readonly leakGate = new LeakAlertGate();
  private paused = false;
  private sampleTimer: unknown = null;
  private statusTimer: unknown = null;
  private disposed = false;
  private readonly timers: NonNullable<MemoryMonitorDeps['timers']>;

  constructor(private readonly deps: MemoryMonitorDeps) {
    this.timers = deps.timers ?? {
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: handle => clearInterval(handle as NodeJS.Timeout)
    };
  }

  /** Panel open: first lookup targets + status dots + default-select the first target and start the sampling loop */
  start(): void {
    if (this.disposed) {
      return;
    }
    this.targets = this.deps.resolveTargets();
    this.postInit();
    void this.refreshAlive();
    if (this.targets.length > 0) {
      this.select(this.targets[0].key);
    }
    this.statusTimer = this.timers.setInterval(() => void this.refreshAlive(), ALIVE_REFRESH_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.stopSamplingTimer();
    if (this.statusTimer !== null) {
      this.timers.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    for (const key of [...this.sessions.keys()]) {
      this.teardownSession(key);
    }
  }

  getTargets(): MemoryMonitorTarget[] {
    return this.targets;
  }

  getSelectedKey(): string | null {
    return this.selectedKey;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Panel→extension: select a component (switch = drop old, connect new, window cleared) */
  select(key: string): void {
    if (this.disposed || !this.targets.some(target => target.key === key)) {
      return;
    }
    if (this.selectedKey !== null) {
      this.teardownSession(this.selectedKey);
    }
    this.selectedKey = key;
    this.window.clear();
    this.leakGate.reset();
    this.backoffAttempts.delete(key);
    this.deps.post({ command: 'clear' });
    this.ensureSession(key);
    this.postInit();
    this.startSamplingTimer();
  }

  /** Panel→extension: pause/resume (stop sampling, keep curves) */
  setPaused(value: boolean): void {
    this.paused = value;
    this.postInit();
  }

  /** Panel→extension: clear the data window */
  clearWindow(): void {
    this.window.clear();
    this.leakGate.reset();
    this.deps.post({ command: 'clear' });
  }

  /** Status dots: ok=session sampling / warn=process alive but session down / err=discovery face has no such process */
  async refreshAlive(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let alive: Set<string>;
    try {
      alive = await this.deps.discoverAlive();
    } catch {
      alive = new Set();
    }
    const states: Record<string, MonitorDotState> = {};
    for (const target of this.targets) {
      const session = this.sessions.get(target.key);
      if (session?.state === 'ok') {
        states[target.key] = 'ok';
      } else if (alive.has(target.component)) {
        states[target.key] = 'warn';
      } else {
        states[target.key] = 'err';
      }
    }
    this.deps.post({ command: 'status', states });
  }

  // ------------------------------------------------------------------
  // Session and sampling
  // ------------------------------------------------------------------

  private ensureSession(key: string): void {
    const target = this.targets.find(item => item.key === key);
    if (!target || this.disposed) {
      return;
    }
    this.teardownSession(key);
    const session = this.deps.createSession(target);
    const active: ActiveSession = {
      target,
      session,
      buffer: '',
      reconnectTimer: null,
      state: 'connecting'
    };
    this.sessions.set(key, active);
    session.onData(text => this.handleData(key, text));
    session.onClose(() => this.handleClose(key));
    session.connect();
  }

  /** Drop only our own session (a late close from a reconnect must never delete the newer session) */
  private teardownSession(key: string): void {
    const active = this.sessions.get(key);
    if (!active) {
      return;
    }
    this.sessions.delete(key);
    if (active.reconnectTimer !== null) {
      this.timers.clearInterval(active.reconnectTimer);
    }
    active.session.disconnect();
  }

  private handleClose(key: string): void {
    const active = this.sessions.get(key);
    if (!active || this.disposed) {
      return;
    }
    const attempt = this.backoffAttempts.get(key) ?? 0;
    this.backoffAttempts.set(key, attempt + 1);
    active.state = 'backoff';
    this.deps.post({ command: 'session', key, state: 'backoff' });
    void this.refreshAlive();
    active.reconnectTimer = this.scheduleReconnect(key, active, nextBackoffMs(attempt));
  }

  private scheduleReconnect(
    key: string,
    active: ActiveSession,
    delayMs: number
  ): unknown {
    // one-shot timer rides setInterval/clone and self-disposes (deps keep
    // the two-handle shape of existing code)
    const handle = this.timers.setInterval(() => {
      this.timers.clearInterval(handle);
      active.reconnectTimer = null;
      // only reconnect sessions still in place (a select teardown must not resurrect)
      if (!this.disposed && this.sessions.get(key) === active) {
        this.ensureSession(key);
      }
    }, delayMs);
    return handle;
  }

  private handleData(key: string, text: string): void {
    const active = this.sessions.get(key);
    if (!active || key !== this.selectedKey) {
      return;
    }
    if (active.state !== 'ok') {
      active.state = 'ok';
      this.backoffAttempts.set(key, 0);
      this.deps.post({ command: 'session', key, state: 'ok' });
      void this.refreshAlive();
    }
    active.buffer += text;
    if (active.buffer.length > SAMPLE_BUFFER_CAP) {
      // bad-stream defense: tail-truncate, keep the freshest half window
      active.buffer = active.buffer.slice(-SAMPLE_BUFFER_CAP / 2);
    }
    if (!active.buffer.includes('KODE_MEM:')) {
      return;
    }
    this.consumeSample(active);
  }

  private consumeSample(active: ActiveSession): void {
    const sample = parseMemorySample(active.buffer);
    const leaks = parseLeakCounters(active.buffer);
    if (sample === null) {
      return;
    }
    active.buffer = '';
    this.window.push(sample);
    const rssRange = computeYRange(this.window.rss(), 6);
    const entRange = computeYRange(this.window.entitiesSeries(), 4);
    this.deps.post({
      command: 'window',
      rssKb: this.window.rss(),
      peakKb: this.window.peaks(),
      entities: this.window.entitiesSeries(),
      rssRange,
      entRange
    });
    this.deps.post({ command: 'leaks', counters: leaks });
    for (const type of this.leakGate.feed(leaks)) {
      const count = leaks.find(counter => counter.type === type)?.count ?? 0;
      this.deps.notifyWarning(this.deps.formatLeakWarning(type, count));
    }
  }

  private startSamplingTimer(): void {
    if (this.sampleTimer !== null) {
      return;
    }
    // Fixed 500ms base beat, sample every N beats by frequency (0.5Hz=4,
    // 1Hz=2, 2Hz=1): frequency is read fresh every beat so a config change
    // takes effect on the next sample, no activation-time snapshot
    let beat = 0;
    this.sampleTimer = this.timers.setInterval(() => {
      beat += 1;
      if (this.disposed || this.paused) {
        return;
      }
      const hz = clampHz(this.deps.getSampleHz());
      const beatsPerSample = Math.max(1, Math.round(2 / hz));
      if (beat % beatsPerSample !== 0) {
        return;
      }
      this.sampleOnce();
    }, 500);
  }

  private sampleOnce(): void {
    const key = this.selectedKey;
    const active = key !== null ? this.sessions.get(key) : undefined;
    if (!active || !active.session.isReady()) {
      return;
    }
    active.session.sendCommand(buildMemorySampleCommand());
  }

  private stopSamplingTimer(): void {
    if (this.sampleTimer !== null) {
      this.timers.clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
  }

  private postInit(): void {
    this.deps.post({
      command: 'init',
      paused: this.paused,
      targets: this.targets.map(({ key, label }) => ({ key, label })),
      selected: this.selectedKey,
      hz: clampHz(this.deps.getSampleHz())
    });
  }
}

function clampHz(hz: number): number {
  return Math.min(Math.max(hz, 0.1), 5);
}

/**
 * Target derivation: expand the telnet table into buttons keyed by
 * component name; same-named instances become #2/#3 (every process has
 * its own telnet port, each gets a button).
 */
export function buildMonitorTargets(
  telnetTargets: ReadonlyArray<{ key: string; component: string; host: string; port: number; password: string }>
): MemoryMonitorTarget[] {
  const seen = new Map<string, number>();
  return telnetTargets.map(target => {
    const count = (seen.get(target.component) ?? 0) + 1;
    seen.set(target.component, count);
    return {
      key: target.key,
      component: target.component,
      label: count > 1 ? `${target.component}#${count}` : target.component,
      host: target.host,
      port: target.port,
      password: target.password
    };
  });
}

// ---------------------------------------------------------------------------
// vscode shell: webview panel
// ---------------------------------------------------------------------------

interface MonitorPanelMessage {
  command: 'select' | 'pause' | 'clear' | 'refresh';
  key?: string;
  value?: boolean;
}

export class MemoryMonitorPanel implements vscode.WebviewViewProvider {
  private panel: vscode.WebviewPanel | null = null;
  private controller: MemoryMonitorController | null = null;

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'kbengine.memoryMonitor',
      strings(resolvePanelLocale()).memoryMonitor.title,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.attach(this.panel);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    this.attach(view);
  }

  private attach(view: vscode.WebviewView | vscode.WebviewPanel): void {
    const locale = resolvePanelLocale();
    const controller = new MemoryMonitorController({
      resolveTargets: () => buildMonitorTargets(readTelnetTargetsFromSettings()),
      discoverAlive: async () => {
        const components = await discoverLocalComponents({ timeoutMs: 1500 });
        return new Set(components.map(component => component.componentName));
      },
      getSampleHz: () =>
        vscode.workspace.getConfiguration('kbengine').get<number>('memoryMonitor.sampleHz', 1),
      post: message => {
        void view.webview.postMessage(message);
      },
      notifyWarning: message => {
        void vscode.window.showWarningMessage(message);
      },
      createSession: defaultMonitorSessionFactory,
      formatLeakWarning: (type, count) =>
        l10nText(
          'KBEngine memory monitor: {type} leak count stayed nonzero for 3 samples (now {count}); possible object leak.',
          { type, count }
        )
    });
    this.controller = controller;
    let started = false;
    const messages = view.webview.onDidReceiveMessage(message => {
      if (message?.command === 'ready' && !started) {
        started = true;
        controller.start();
      } else if (started) {
        this.handleMessage(controller, message as MonitorPanelMessage);
      }
    });
    const disposal = view.onDidDispose(() => {
      messages.dispose();
      disposal.dispose();
      controller.dispose();
      if (this.controller === controller) {
        this.controller = null;
      }
      if (this.panel === view) {
        this.panel = null;
      }
    });
    view.webview.html = renderPanelHtml(locale);
  }

  dispose(): void {
    this.controller?.dispose();
    this.controller = null;
    this.panel?.dispose();
    this.panel = null;
  }

  private handleMessage(controller: MemoryMonitorController, message: MonitorPanelMessage | null): void {
    if (!message) {
      return;
    }
    if (message.command === 'select' && message.key) {
      controller.select(message.key);
      return;
    }
    if (message.command === 'pause') {
      controller.setPaused(message.value === true);
      return;
    }
    if (message.command === 'clear') {
      controller.clearWindow();
      return;
    }
    if (message.command === 'refresh') {
      void controller.refreshAlive();
    }
  }
}

// ---------------------------------------------------------------------------
// Panel HTML (prototype panel.html port: layout/colors/curves match the
// prototype; wording goes through strings(locale); shell uses WEBVIEW_THEME_CSS
// tokens, canvas uses literal colors)
// ---------------------------------------------------------------------------

function renderPanelHtml(locale: WebviewLocale): string {
  const nonce = randomNonce();
  const t = strings(locale).memoryMonitor;
  // Script-side strings only; every other label is inlined directly in HTML
  const ui = {
    deltaLabel: t.deltaLabel,
    pause: t.pause,
    resume: t.resume,
    statusConnected: t.statusConnected,
    statusBackoff: t.statusBackoff,
    statusNoProcess: t.statusNoProcess
  };
  return `<!DOCTYPE html>
<html lang="${htmlLang(locale)}">
<head>
<meta charset="UTF-8" />
<!-- Minimal CSP: inline script only honors this render's nonce, blocking every outbound source -->
<meta http-equiv="Content-Security-Policy" content="${webviewScriptCsp(nonce)}" />
<style>
  ${WEBVIEW_THEME_CSS}
  body { padding: 12px; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
  /* Top: component button bar (prototype .topbar) */
  .topbar {
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
    background: var(--kode-surface); border: 1px solid var(--kode-border);
    border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; flex: none;
  }
  .topbar .title { font-weight: 600; color: var(--kode-fg); }
  #compButtons { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 4px; }
  .comp-btn {
    padding: 3px 10px; border-radius: 4px; border: 1px solid var(--kode-border);
    background: var(--kode-bg); color: var(--kode-fg); cursor: pointer; font-size: 12px;
    transition: all .15s;
  }
  .comp-btn:hover { background: var(--kode-surface-2); }
  .comp-btn.active { background: var(--kode-accent); border-color: var(--kode-accent); color: #fff; }
  .comp-btn .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
  /* Canvas-side literals share the VS Code color family */
  .dot-ok { background: #4ec9b0; }
  .dot-warn { background: #cca700; }
  .dot-err { background: #f14c4c; }
  .paused-badge {
    display: none; padding: 2px 8px; border-radius: 4px;
    background: #cca700; color: #000; font-size: 11px; font-weight: 600;
  }
  /* Number cards (prototype .cards) */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 105px), 1fr)); gap: 10px; margin-bottom: 12px; flex: none; }
  .card {
    background: var(--kode-surface); border: 1px solid var(--kode-border);
    border-radius: 6px; padding: 12px 14px; position: relative; overflow: hidden;
  }
  .card .label { color: var(--kode-fg-3); font-size: 11px; margin-bottom: 6px; letter-spacing: .3px; }
  .card .value { font-size: 22px; font-weight: 600; color: var(--kode-fg); font-variant-numeric: tabular-nums; }
  .card .unit { font-size: 12px; color: var(--kode-fg-3); margin-left: 3px; }
  .card .delta { font-size: 11px; margin-top: 4px; }
  .delta-up { color: #f14c4c; }
  .delta-down { color: #4ec9b0; }
  .delta-flat { color: var(--kode-fg-3); }
  /* Chart area (prototype .chart-area) */
  .chart-area {
    background: var(--kode-surface); border: 1px solid var(--kode-border);
    border-radius: 6px; padding: 14px 16px; flex: 1; min-height: 0;
    display: flex; flex-direction: column;
  }
  .chart-header { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; margin-bottom: 8px; }
  .chart-header .label { color: var(--kode-fg); font-weight: 600; font-size: 13px; }
  .chart-header .legend { display: flex; gap: 14px; margin-left: auto; }
  .legend-item { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--kode-fg-3); }
  .legend-swatch { width: 14px; height: 3px; border-radius: 2px; }
  .canvas-wrap { flex: 1; min-height: 0; position: relative; }
  canvas { width: 100%; height: 100%; display: block; }
  .chart-empty {
    position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    color: var(--kode-fg-3); font-size: 12px;
  }
  /* Bottom: object counters (leak tracking) */
  .counters {
    background: var(--kode-surface); border: 1px solid var(--kode-border);
    border-radius: 6px; padding: 12px 16px; margin-top: 12px; flex: none;
  }
  .counters .label { color: var(--kode-fg); font-weight: 600; margin-bottom: 8px; font-size: 12px; }
  .counter-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .counter-chip {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--kode-bg); border: 1px solid var(--kode-border);
    border-radius: 4px; padding: 5px 10px; font-size: 12px;
  }
  .counter-chip .name { color: var(--kode-fg-3); }
  .counter-chip .num { color: var(--kode-fg); font-weight: 600; font-variant-numeric: tabular-nums; }
  /* Nonzero leak red border (canvas-adjacent literal shares #f14c4c family) */
  .counter-chip.leaked { border-color: #f14c4c; }
  .counter-chip.leaked .num { color: #f14c4c; }
  @media (max-width: 480px), (max-height: 480px) {
    body { height: auto; min-height: 100vh; overflow: auto; padding: 8px; }
    .chart-area { min-height: 180px; padding: 8px; }
    .chart-header .legend { flex-wrap: wrap; gap: 6px 10px; margin-left: 0; }
    .card { padding: 8px; }
    .card .value { font-size: 18px; }
  }
</style>
</head>
<body>
<div class="topbar">
  <span class="title">${t.title}</span>
  <span id="compButtons"></span>
  <span class="paused-badge" id="pausedBadge">${t.pausedBadge}</span>
  <button class="comp-btn" id="pauseBtn">${t.pause}</button>
  <button class="comp-btn" id="clearBtn">${t.clear}</button>
  <span class="muted" id="noTargets" style="display:none;color:var(--kode-fg-3);font-size:11px;max-width:420px">${t.noTargets}</span>
</div>
<div class="cards">
  <div class="card">
    <div class="label">${t.cardRss}</div>
    <div class="value" id="cardRss">-<span class="unit">MB</span></div>
    <div class="delta delta-flat" id="cardRssDelta"></div>
  </div>
  <div class="card">
    <div class="label">${t.cardPeak}</div>
    <div class="value" id="cardPeak">-<span class="unit">MB</span></div>
    <div class="delta delta-flat">${t.cardPeakHint}</div>
  </div>
  <div class="card">
    <div class="label">${t.cardEntities}</div>
    <div class="value" id="cardEnt">-</div>
    <div class="delta delta-flat" id="cardEntDelta"></div>
  </div>
  <div class="card">
    <div class="label">${t.cardHz}</div>
    <div class="value" id="cardHz">1.0<span class="unit">Hz</span></div>
    <div class="delta delta-flat">telnet</div>
  </div>
</div>
<div class="chart-area">
  <div class="chart-header">
    <span class="label">${t.chartTitle(60)}</span>
    <div class="legend">
      <div class="legend-item"><span class="legend-swatch" style="background:#4ec9b0"></span>${t.legendRss}</div>
      <div class="legend-item"><span class="legend-swatch" style="background:#c586c0"></span>${t.legendEntities}</div>
      <div class="legend-item"><span class="legend-swatch" style="background:#808080"></span>${t.legendPeak}</div>
    </div>
  </div>
  <div class="canvas-wrap">
    <canvas id="chart"></canvas>
    <div class="chart-empty" id="chartEmpty">${t.emptyChart}</div>
  </div>
</div>
<div class="counters">
  <div class="label">${t.leaksTitle}</div>
  <div class="counter-row" id="counters"></div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const ui = ${toJsonForScript(ui)};
  const canvas = document.getElementById('chart');
  const ctx = canvas.getContext('2d');
  const emptyEl = document.getElementById('chartEmpty');
  let paused = false;
  // Data window (extension-side sliding window, 60 points; panel only draws)
  let rssKb = [], peakKb = [], ent = [];
  let rssRange = null, entRange = null;
  let dotStates = {};
  let lastTargets = [], lastSelected = null;

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    canvas.width = r.width * devicePixelRatio;
    canvas.height = r.height * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    draw();
  }

  function fmtKb(v) { return v >= 1048576 ? (v / 1048576).toFixed(2) : Math.round(v / 1024); }
  function fmtKbUnit(v) { return v >= 1048576 ? 'GB' : 'MB'; }

  function draw() {
    const W = canvas.width / devicePixelRatio;
    const H = canvas.height / devicePixelRatio;
    ctx.clearRect(0, 0, W, H);
    if (rssKb.length === 0 || !rssRange) {
      emptyEl.style.display = 'flex';
      return;
    }
    emptyEl.style.display = 'none';
    const pad = { l: 48, r: 44, t: 10, b: 24 };
    const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
    // Grid + left-axis ticks (tick values come from extension-side computeYRange tidy steps)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.font = '10px sans-serif';
    const r0 = rssRange;
    const ticks = [];
    for (let v = r0.lo; v <= r0.hi + r0.step * 0.001; v += r0.step) ticks.push(v);
    const nT = Math.max(1, ticks.length - 1);
    for (let i = 0; i < ticks.length; i++) {
      const y = pad.t + ch * i / nT;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.textAlign = 'right';
      ctx.fillText(fmtKb(ticks[nT - i]) + fmtKbUnit(ticks[nT - i]), pad.l - 6, y + 3);
    }
    for (let i = 0; i <= 6; i++) {
      const x = pad.l + cw * i / 6;
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
    }
    const lo = r0.lo, hi = r0.hi;
    const n = rssKb.length;
    const xOf = i => pad.l + cw * (n > 1 ? i / (n - 1) : 0);
    const yOf = v => pad.t + ch * (1 - (v - lo) / (hi - lo || 1));
    // Peak line (window max, gray dashed)
    const peak = Math.max(...peakKb.slice(0, n));
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.l, yOf(peak)); ctx.lineTo(W - pad.r, yOf(peak)); ctx.stroke();
    ctx.setLineDash([]);
    // RSS line + gradient fill (canvas literal #4ec9b0)
    ctx.beginPath();
    rssKb.forEach((v, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)));
    ctx.strokeStyle = '#4ec9b0';
    ctx.lineWidth = 2; ctx.stroke();
    ctx.lineTo(xOf(n - 1), H - pad.b); ctx.lineTo(xOf(0), H - pad.b); ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
    grad.addColorStop(0, 'rgba(78,201,176,0.25)');
    grad.addColorStop(1, 'rgba(78,201,176,0)');
    ctx.fillStyle = grad; ctx.fill();
    // Entities (right axis, purple dashed #c586c0; range from extension side)
    if (entRange && ent.length > 0) {
      const e0 = entRange;
      const yEnt = v => pad.t + ch * (1 - (v - e0.lo) / (e0.hi - e0.lo || 1));
      ctx.fillStyle = 'rgba(197,134,192,0.75)';
      ctx.textAlign = 'left';
      ctx.fillText(String(Math.round(e0.hi)), W - pad.r + 6, pad.t + 3);
      ctx.fillText(String(Math.round((e0.hi + e0.lo) / 2)), W - pad.r + 6, pad.t + ch / 2 + 3);
      ctx.fillText(String(Math.round(e0.lo)), W - pad.r + 6, pad.t + ch + 3);
      ctx.beginPath();
      ent.forEach((v, i) => i === 0 ? ctx.moveTo(xOf(i), yEnt(v)) : ctx.lineTo(xOf(i), yEnt(v)));
      ctx.strokeStyle = '#c586c0';
      ctx.lineWidth = 2; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(xOf(n - 1), yEnt(ent[n - 1]), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#c586c0'; ctx.fill();
    }
    // Latest point (cyan)
    ctx.beginPath(); ctx.arc(xOf(n - 1), yOf(rssKb[n - 1]), 3, 0, Math.PI * 2);
    ctx.fillStyle = '#4ec9b0'; ctx.fill();
  }

  function renderCards() {
    if (rssKb.length === 0) {
      return;
    }
    const last = rssKb[rssKb.length - 1];
    const prev = rssKb.length > 1 ? rssKb[rssKb.length - 2] : last;
    const dRss = last - prev;
    document.getElementById('cardRss').innerHTML =
      fmtKb(last) + '<span class="unit">' + fmtKbUnit(last) + '</span>';
    const dRssEl = document.getElementById('cardRssDelta');
    const mb = Math.round(dRss / 1024 * 10) / 10;
    dRssEl.textContent = ui.deltaLabel + ': ' + (dRss >= 0 ? '+' : '') + mb + 'MB';
    dRssEl.className = 'delta ' + (dRss > 512 ? 'delta-up' : dRss < -512 ? 'delta-down' : 'delta-flat');
    const peak = Math.max(...peakKb.slice(0, rssKb.length));
    document.getElementById('cardPeak').innerHTML =
      fmtKb(peak) + '<span class="unit">' + fmtKbUnit(peak) + '</span>';
    const lastEnt = ent[ent.length - 1];
    const prevEnt = ent.length > 1 ? ent[ent.length - 2] : lastEnt;
    const dEnt = lastEnt - prevEnt;
    document.getElementById('cardEnt').textContent = String(lastEnt);
    const dEntEl = document.getElementById('cardEntDelta');
    dEntEl.textContent = ui.deltaLabel + ': ' + (dEnt >= 0 ? '+' : '') + dEnt;
    dEntEl.className = 'delta ' + (dEnt > 0 ? 'delta-up' : dEnt < 0 ? 'delta-down' : 'delta-flat');
  }

  function renderCounters(counters) {
    const row = document.getElementById('counters');
    row.innerHTML = '';
    for (const entry of counters) {
      const chip = document.createElement('span');
      chip.className = 'counter-chip' + (entry.count > 0 ? ' leaked' : '');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.type;
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(entry.count);
      chip.appendChild(name);
      chip.appendChild(num);
      row.appendChild(chip);
    }
  }

  function renderButtons(targets, selected) {
    // init carries the full set; status only refreshes dots, targets/selection stay cached
    if (targets) lastTargets = targets;
    if (selected !== undefined && selected !== null) lastSelected = selected;
    const holder = document.getElementById('compButtons');
    holder.innerHTML = '';
    document.getElementById('noTargets').style.display = lastTargets.length === 0 ? 'inline' : 'none';
    for (const target of lastTargets) {
      const btn = document.createElement('button');
      btn.className = 'comp-btn' + (target.key === lastSelected ? ' active' : '');
      btn.dataset.key = target.key;
      const dot = document.createElement('span');
      const state = dotStates[target.key] || 'err';
      dot.className = 'dot dot-' + state;
      dot.title = state === 'ok' ? ui.statusConnected : state === 'warn' ? ui.statusBackoff : ui.statusNoProcess;
      btn.appendChild(dot);
      btn.appendChild(document.createTextNode(target.label));
      btn.addEventListener('click', () => {
        vscode.postMessage({ command: 'select', key: target.key });
      });
      holder.appendChild(btn);
    }
  }

  function setPausedUi(value) {
    paused = value;
    document.getElementById('pauseBtn').textContent = paused ? ui.resume : ui.pause;
    document.getElementById('pausedBadge').style.display = paused ? 'inline-block' : 'none';
  }

  document.getElementById('pauseBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'pause', value: !paused });
  });
  document.getElementById('clearBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'clear' });
  });
  window.addEventListener('resize', resize);
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.command === 'init') {
      setPausedUi(message.paused === true);
      renderButtons(message.targets || [], message.selected);
      if (typeof message.hz === 'number') {
        document.getElementById('cardHz').innerHTML =
          message.hz.toFixed(1) + '<span class="unit">Hz</span>';
      }
      return;
    }
    if (message.command === 'clear') {
      rssKb = []; peakKb = []; ent = [];
      renderCounters([]);
      draw();
      return;
    }
    if (message.command === 'window') {
      rssKb = message.rssKb || [];
      peakKb = message.peakKb || [];
      ent = message.entities || [];
      rssRange = message.rssRange || null;
      entRange = message.entRange || null;
      renderCards();
      draw();
      return;
    }
    if (message.command === 'leaks') {
      renderCounters(message.counters || []);
      return;
    }
    if (message.command === 'status') {
      dotStates = message.states || {};
      renderButtons();
      return;
    }
    if (message.command === 'session') {
      // session-state changes ride on the status refresh (kept for extension growth)
      return;
    }
  });
  resize();
  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
}
