/**
 * Pure face for the status-bar label of the Kode language service (MCP/LSP) (user order
 * 2026-11-10 "how to indicate whether the lsp and mcp states are on"): pure functions for the
 * status-bar text/tooltip of the core (the LSP kode-server service track) and of the Kode MCP
 * binary-presence face. Fact collection and status-bar wiring live in
 * ../activate/kodeServiceStatus.ts (which depends on the vscode host); this module has zero
 * vscode dependencies and unit tests import it directly. The source strings are all English
 * (the l10n convention), and the zh-cn translations live in l10n/bundle.l10n.zh-cn.json.
 *
 * State definitions (as they are):
 * - core (kode-server): backend=rust and serverPath hits -> the Rust service track;
 *   backend=rust but the binary was not found -> Rust falling back to TS (auto-discovery
 *   missed, the service falls back); backend=ts -> pure TS; backend=shadow -> dual-track shadow
 *   comparison.
 * - Kode MCP (kode-mcp): a **built-in MCP** (user order 2026-11-13 "built-in mcp, enabled by
 *   a click, on by default", overturning the 2026-11-10 "not hosted" accounting): the extension
 *   registers server definitions through the VS Code native MCP extension API (kodeMcpHost.ts,
 *   with kbengine.mcp.enabled=true by default), and clicking the status-bar item toggles it;
 *   the three visible states = built (the binary is present + on) / not built (on but the binary
 *   is missing) / off (the user turned it off).
 * - the core tooltip also carries an "engine version" line (RUST-136 increment 5): the engine
 *   version is an environmental fact, not the hover face (increment 4 was voided), so it lands in
 *   the status bar; the wiring layer passes in the probe result of the engineVersionDetect
 *   chain, and null = not detected, displayed explicitly as "not detected".
 */

import { l10nText } from '../nlsRuntime';
import { INDEX_CACHE_SCHEMA_VERSION } from './indexDiskCache';
import type { KodeMcpProbeResult } from '../kodeMcpHealthProbe';

export interface KodeCoreStateLite {
  mode: 'ts' | 'rust' | 'shadow';
  /** The kode-server binary path; empty = auto-discovery missed (Rust unavailable) */
  serverPath: string;
}

/** Core status-bar text: $(circuit-board)=running / $(warning)=degraded / $(beaker)=shadow comparison */
export function coreStatusBarText(state: KodeCoreStateLite | null): string {
  if (!state) {
    return l10nText('$(circuit-board) Kode LSP: not initialized');
  }
  if (state.mode === 'shadow') {
    return l10nText('$(beaker) Kode LSP: Shadow parity');
  }
  if (state.mode === 'rust') {
    return state.serverPath
      ? l10nText('$(circuit-board) Kode LSP: Rust')
      : l10nText('$(warning) Kode LSP: Rust fallback TS');
  }
  return l10nText('$(circuit-board) Kode LSP: TS');
}

/** Index format line (ENGINE-WORDING-006): the display slot for the kode index data compatibility key, kept apart from the KBEngine engine version */
function indexFormatSchemaLine(): string {
  return l10nText(
    'Index format schema={version} (kode index data compat key, unrelated to the KBEngine engine version)',
    { version: INDEX_CACHE_SCHEMA_VERSION }
  );
}

/**
 * Engine version line (RUST-136 increment 5): the data source = the existing
 * engineVersionDetect detection chain (findEngineRoot + readEngineVersionMarker, see the
 * ../activate wiring). null = not detected / the probe failed, shown explicitly as "not
 * detected" and never guessed; it never falls back to the kbengine.engineVersion setting value
 * (that is the user's declared accounting, not the marker fact in the engine tree).
 */
export function engineVersionLine(engineVersion: string | null): string {
  return engineVersion
    ? l10nText('KBEngine engine version: {version}', { version: engineVersion })
    : l10nText('KBEngine engine version: not detected (no version marker readable in the engine tree)');
}

/** Core tooltip: the current service track and its basis (path / fallback reason) + the engine version line + the fixed index format line */
export function coreStatusBarTooltip(
  state: KodeCoreStateLite | null,
  engineVersion?: string | null
): string {
  return `${coreStatusBarTooltipBody(state)}\n${engineVersionLine(engineVersion ?? null)}\n${indexFormatSchemaLine()}`;
}

function coreStatusBarTooltipBody(state: KodeCoreStateLite | null): string {
  if (!state) {
    return l10nText('Kode core not initialized');
  }
  if (state.mode === 'shadow') {
    return l10nText('kode-server dual-track shadow comparison (shadow mode)');
  }
  if (state.mode === 'rust') {
    return state.serverPath
      ? l10nText('Rust kode-server service track: {path}', { path: state.serverPath })
      : l10nText('kbengine.core.backend=rust but kode-server binary not found (auto-discovery missed), falling back to TS');
  }
  return l10nText('kbengine.core.backend=ts (pure TS service)');
}

/** The MCP liveness probe face (the 2026-11-24 MCP liveness-light batch; the most recent
 * snapshot kept by the wiring layer): probing = in flight; last=null = never probed (the
 * activation window); last = the most recent round's result */
export interface KodeMcpProbeFace {
  probing: boolean;
  last: KodeMcpProbeResult | null;
}

/**
 * MCP status-bar text: $(plug) built / not built / off (the three visible states of the built-in
 * MCP) + the two liveness states (the face flips only when the probe has an account while built
 * + on): ok = the liveness probe passed; no reply = the liveness probe failed (the process will
 * not come up / the handshake gets no answer -- "built" only says the binary is present, it does
 * not mean it can be launched and will answer).
 */
export function mcpStatusBarText(
  binaryFound: boolean,
  enabled: boolean,
  probe?: KodeMcpProbeFace
): string {
  if (!enabled) {
    return l10nText('$(plug) Kode MCP: off');
  }
  if (!binaryFound) {
    return l10nText('$(plug) Kode MCP: not built');
  }
  if (probe?.last) {
    return probe.last.ok
      ? l10nText('$(plug) Kode MCP: ok')
      : l10nText('$(error) Kode MCP: no reply');
  }
  return l10nText('$(plug) Kode MCP: built');
}

/** The liveness probe line (probed only when built + on; the four honest tones: probing / not yet probed / passed / failed) */
function mcpProbeLine(probe: KodeMcpProbeFace): string {
  if (probe.last?.ok) {
    return l10nText(
      'Liveness probe passed ({latency}ms): kode-mcp --probe answered the MCP handshake',
      { latency: probe.last.latencyMs }
    );
  }
  if (probe.last) {
    return probe.last.reason
      ? l10nText('Liveness probe failed: {reason}', { reason: probe.last.reason })
      : l10nText('Liveness probe failed: no answer within budget (suspected hang)');
  }
  return l10nText('Liveness probe: running (first probe after activation)');
}

/** MCP tooltip: the built-in hosting fact + the click-to-toggle hint (click = kbengine.mcp.toggle)
 * + the liveness probe line (when built + on; the result = the most recent round, with no
 * periodic polling) */
export function mcpStatusBarTooltip(
  binaryFound: boolean,
  enabled: boolean,
  probe?: KodeMcpProbeFace
): string {
  if (!enabled) {
    return l10nText('Kode MCP is disabled; click to enable the built-in MCP server');
  }
  if (!binaryFound) {
    return l10nText('kode-mcp not built (source in crates/kode-mcp); build the binary to enable the built-in MCP server; click toggles enable state');
  }
  const body = l10nText('kode-mcp binary present; built-in MCP server definition registered (VS Code native MCP); click to disable');
  if (!probe || (!probe.probing && !probe.last)) {
    return body;
  }
  return `${body}\n${mcpProbeLine(probe)}`;
}
