/**
 * Player Data Clone command orchestration (CLONE-P5 / PDC-0501..0507, plan §7):
 * - connection profile setup/test (0501): Source read-only source + Target local writable target;
 * - export (0502): entity/DBID selection → read-only plan preview → read-only session execution → .kdpclone;
 * - archive browsing (0503): manifest/hash state/redaction state; never row values, sensitive values hidden by default;
 * - import (0504/0505): two-pass plan (pass-1 column order → unique-value bounded probing → pass-2 conflict
 *   rehearsal) → preview (conflict/binding/warnings/Persisted≠Live) → local-environment second confirmation →
 *   progress + cancel (cancel = rollback) → audit written to disk;
 * - audit review (0505): run records echoed from .kode/clone-runs/;
 * - load verification (0506): COUNT recheck shown faithfully as-is; engine-side native load verification
 *   requires a local KBEngine runtime, unwired parts described faithfully, never falsely reported.
 *
 * localization (UX-REVIEW-010d): key = English source string, zh-cn fetched via deps.localize (the wiring
 * layer injects l10nText), no injection falls back to the English source string; comparisons always
 * compare against the same call value (not depending on fixed language text). The key notice "persisted
 * copy (Persisted copy) ≠ live online state (Live state)" appears on both the export and import faces.
 *
 * no vscode imports: UI/connection/file faces all injected via deps (unit tests drive pure orchestration).
 */

import type { CloneProfileRole, CloneProfileStore } from './playerDataCloneProfiles';
import { fingerprintCloneArchive, reserveCloneImport } from './playerDataCloneImportGuard';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  applyImportPlan,
  CloneApplyCancelledError,
  CloneCancelledError,
  CloneCommitUnknownError,
  ClonePostCommitError,
  CloneRollbackUnknownError,
  columnOrderFromPlan,
  executeExportPlan,
  loadMysqlModule,
  openCloneSession,
  probeExistingValues,
  probePhysicalTables,
  testCloneConnection,
  uniqueValuesFromRows,
  type CloneMysqlConnection,
  type CloneMysqlModule
} from './playerDataCloneMysql';
import {
  inspectCloneArchive,
  planCloneExport,
  planCloneImport,
  readCloneArchiveRows,
  writeCloneArchive
} from './playerDataCloneRust';
import type { ArchiveMetaWire, ImportPlanWire, TypedRowWire } from './playerDataCloneWire';

/** Entity-derived table descriptor (structure subset; shape guaranteed by the databaseSchema snapshot). */
export interface EntityTableDescriptorLike {
  name: string;
}

/** {name} placeholder argument (replaced inside the translation; semantics match nlsRuntime.NlsArgs). */
export type L10nArgs = Record<string, string | number | boolean>;

/** Lookup wrapper form: the wiring layer injects localize (= l10nText), no injection falls back to the English source string. */
export type CloneL10n = (message: string, args?: L10nArgs) => string;

/** Fallback when no localize is injected: {name} in the English source string is replaced in place by args. */
export function withL10nArgs(message: string, args?: L10nArgs): string {
  if (!args) {
    return message;
  }
  return message.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : whole
  );
}

export interface PlayerCloneCommandDeps {
  /** Inject VS Code localization at the UI boundary; tests and non-VS Code callers may omit it. */
  localize?(message: string, args?: L10nArgs): string;
  profiles: CloneProfileStore;
  listEntityNames(): string[];
  /** Entity → derived tables (databaseSchema snapshot; unreadable = null, never guessed). */
  resolveEntityTables(entityName: string): EntityTableDescriptorLike[] | null;
  showQuickPick(items: readonly string[], options: { placeHolder: string }): Promise<string | undefined>;
  showInputBox(options: {
    prompt: string;
    /** Existing-config prefill (005a: non-password info already entered is preserved across forward/back); password is never prefilled */
    value?: string;
    /** Title above the input box (005a: shows the role and step number, e.g. "Source 2/5") */
    title?: string;
    password?: boolean;
    validateInput?(value: string): string | null;
  }): Promise<string | undefined>;
  showInformationMessage(message: string): Promise<unknown>;
  showWarningMessage(message: string, ...items: string[]): Promise<unknown>;
  showErrorMessage(message: string): Promise<unknown>;
  withProgress<R>(
    options: { title: string; cancellable: boolean },
    task: (token: { isCancellationRequested: boolean }) => Promise<R>
  ): Promise<R>;
  /** Export archive save-path selection; cancel = undefined. defaultDir = last export directory (prefilled as the save starting point). */
  pickArchiveSavePath(defaultName: string, defaultDir?: string): Promise<string | undefined>;
  /** Import archive selection; cancel = undefined. */
  pickArchiveOpenPath(): Promise<string | undefined>;
  /** Audit-written face; the path is decided by the caller (workspace .kode/clone-runs). */
  writeAuditFile(name: string, content: string): Promise<string>;
  listAuditFiles(): Promise<string[]>;
  readAuditFile(path: string): Promise<string | null>;
  /**
   * Archive encryption key root directory (clone-keys under globalStorage; key material
   * stays in Rust the whole time, TS only passes the directory path). undefined = not
   * encrypted (test doubles / legacy wiring compatible).
   */
  getKeyRoot(): string | undefined;
  /**
   * Archive encryption default (kbengine.clone.archiveEncryption; default = 'encrypted').
   * Used only as the initial state of the export confirmation page, each export can toggle
   * it (PDC-0609); the read face is unaffected (the encryption bit is probed, both plaintext
   * and encrypted archives can be read).
   */
  getArchiveEncryptionDefault?(): 'encrypted' | 'plain';
  /**
   * UX-REVIEW-004b export pre-check: light probe of the Rust clone backend (true = gate present).
   * Sends no RPC, only judges gate absence; server-level faults are still reported faithfully
   * via the plan/write no-gate/error faces.
   * Default = skip this face (test doubles / legacy wiring compatible).
   */
  probeCloneBackend?(): boolean;
  /**
   * UX-REVIEW-004b export pre-check: source-connection real connection test (SELECT VERSION();
   * the probe session closes read-only immediately). On failure the raw reason is carried,
   * and export offers a retry/configure entry before entity/DBID collection.
   * Default = skip this face (test doubles / legacy wiring compatible).
   */
  probeSourceConnection?(config: {
    host: string;
    port: number;
    user: string;
    password?: string;
    database: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * UX-2026-11-22 increment 1: selection memory of the last successful export (workspaceState face
   * injection, databaseWiring reuses the kode.playerClone.profiles mechanism). Default = no memory
   * (zero behavior change, test doubles / legacy wiring compatible). Only success is recorded,
   * not cancel/failure.
   */
  getLastExportSelection?(): {
    entityName: string;
    dbid: string;
    savePath: string;
    encrypt: boolean;
  } | null;
  /** Persist memory after a successful export (called only on the success path). */
  rememberExportSelection?(selection: {
    entityName: string;
    dbid: string;
    savePath: string;
    encrypt: boolean;
  }): void;
  /**
   * Derive the source connection from the engine final config (dbmgr/databaseInterfaces/default) (user order:
   * export prefers reading the final config, never forcing the user to type it by hand). null = final config
   * unavailable (no kbengine.xml and no derived profile). password is the value decrypted from the engine RSA
   * plaintext; undecryptable = undefined, the caller degrades faithfully as "password unreadable". defaultsOnly =
   * only the engine defaults were obtained (kbengine.xml absent, the values are not this project's actual config,
   * must be warned about faithfully).
   */
  resolveFinalConfigSourceConnection?(): Promise<{
    config: { host: string; port: number; user: string; password?: string; database: string };
    defaultsOnly: boolean;
  } | null>;
  /**
   * user order 2026-11-23: export dialog "read from config" face —— kbengine.clone.defaultEntity /
   * defaultDbId effective values (same settings layer as archiveEncryption). Default = no injection
   * (test doubles / legacy wiring compatible, dialog behavior byte-identical to the old version).
   */
  getCloneExportConfigDefaults?(): { defaultEntity?: string; defaultDbId?: string };
  channel: { appendLine(line: string): void; show(preserveFocus?: boolean): void };
  now(): number;
}

const PERSISTED_NOT_LIVE =
  'This is a persisted copy of the database, not the live online state.';

/** Path directory name (handwritten, no node:path dependency; used only as the save starting point prefill). */
function dirnameOf(p: string): string | undefined {
  const sep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return sep > 0 ? p.slice(0, sep) : undefined;
}

const noGateMessage =
  'Player Data Clone requires the Rust backend (kode-server) to be available: check the kode-core server configuration.';

// ---------------------------------------------------------------------------
// 0609 export encryption selection (settings default + per-export toggle on the confirmation page)
// ---------------------------------------------------------------------------

export const EXPORT_CONFIRM_ITEM = 'Export';
export const EXPORT_CANCEL_ITEM = 'Cancel';
const ENCRYPTED_LABEL = 'Encrypted (local key)';
const PLAIN_LABEL = 'Plaintext (portable)';
const TOGGLE_ENCRYPTION_LABEL = 'Toggle encryption';

/**
 * The encryption selection loop of the export confirmation page: the confirm item's text carries the
 * current encryption state, the toggle item flips it repeatedly, until export/cancel. confirmed=false
 * exits the export flow (cancel/window closed).
 * previewSummary (UX-2026-11-22 increment 3): the plan preview summary (table list/row budget/missing)
 * is merged into the placeholder text so the confirmation page can be read and passed on the spot;
 * details are still written to OUTPUT for the record.
 */
export async function pickExportEncryption(
  pick: (
    items: readonly string[],
    options: { placeHolder: string }
  ) => Promise<string | undefined>,
  queryCount: number,
  defaultEncrypt: boolean,
  localize?: CloneL10n,
  previewSummary?: string
): Promise<{ confirmed: boolean; encrypt: boolean }> {
  const l10n: CloneL10n = localize ?? withL10nArgs;
  let encrypt = defaultEncrypt;
  for (;;) {
    // The option text and the comparison share the same call value (010d: comparison does not depend on fixed language text).
    const confirmItem = `${l10n(EXPORT_CONFIRM_ITEM)},${encrypt ? l10n(ENCRYPTED_LABEL) : l10n(PLAIN_LABEL)}`;
    const toggleItem = `${l10n(TOGGLE_ENCRYPTION_LABEL)} → ${encrypt ? l10n(PLAIN_LABEL) : l10n(ENCRYPTED_LABEL)}`;
    const cancelItem = l10n(EXPORT_CANCEL_ITEM);
    const base = l10n('Export {count} read-only query results to the archive?', { count: queryCount });
    const placeHolder = previewSummary ? `${base}\n\n${previewSummary}` : base;
    const picked = await pick([confirmItem, toggleItem, cancelItem], { placeHolder });
    if (!picked || picked === cancelItem) {
      return { confirmed: false, encrypt };
    }
    if (picked === toggleItem) {
      encrypt = !encrypt;
      continue;
    }
    return { confirmed: true, encrypt };
  }
}

// ---------------------------------------------------------------------------
// 0501 connection profile setup / test (UX-REVIEW-005a/005c step-by-step wizard)
// ---------------------------------------------------------------------------

/** Summary page actions (005c): save / test connection / edit / cancel; the choice is judged by the same value. */
export const CLONE_SUMMARY_SAVE = 'Save';
export const CLONE_SUMMARY_TEST = 'Test connection';
export const CLONE_SUMMARY_EDIT = 'Edit';
export const CLONE_SUMMARY_CANCEL = 'Cancel';
/**
 * Keep the stored password (005d explicit keep semantics): appears only when a secret is stored and
 * this input leaves the password empty; selecting it persists via save(password=undefined) and the
 * SecretStorage old key is kept as-is — forming an explicit semantic pair with "save (empty = clear)".
 */
export const CLONE_SUMMARY_KEEP_SECRET = 'Keep stored password';

/** Input-step draft: kept in memory throughout, only written to disk when "save" is chosen on the summary page (cancel writes no half-finished data). */
interface CloneProfileDraft {
  host: string;
  portText: string;
  user: string;
  /** '' = clear the stored password (existing convention); non-empty = overwrite. The summary never echoes this value. */
  password: string;
  database: string;
  environment?: 'local' | 'test';
}

const roleLabel = (role: CloneProfileRole): string => (role === 'source' ? 'Source' : 'Target');

export async function runConfigureCloneProfileCommand(
  deps: PlayerCloneCommandDeps,
  role: CloneProfileRole
): Promise<void> {
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  const existing = deps.profiles.get(role);
  // 005a: prefill the non-password fields from the existing config (revisable after a successful save); the password is never backfilled.
  const draft: CloneProfileDraft = {
    host: existing?.host ?? '',
    portText: existing ? String(existing.port) : '',
    user: existing?.user ?? '',
    password: '',
    database: existing?.database ?? '',
    environment: existing?.environment
  };
  const hostPrompt = role === 'source'
    ? l10n('Source database host')
    : l10n('Target database host (local or test only)');
  const envPrompt = l10n('Target environment (production and staging are not allowed)');
  const steps = [
    {
      key: 'host' as const,
      prompt: hostPrompt,
      validate: (value: string): string | null => (value.trim() ? null : l10n('Enter a host address'))
    },
    {
      key: 'portText' as const,
      prompt: l10n('Port (default 3306)'),
      validate: (value: string): string | null => {
        if (value === '') { return null; }
        if (!/^\d+$/.test(value)) { return l10n('Port must be a number'); }
        const port = Number(value);
        return port >= 1 && port <= 65535 ? null : l10n('Port must be between 1 and 65535');
      }
    },
    {
      key: 'user' as const,
      prompt: l10n('Username'),
      validate: (value: string): string | null => (value.trim() ? null : l10n('Enter a username'))
    },
    { key: 'password' as const, prompt: l10n('Password (leave empty to remove the saved password)'), password: true },
    {
      key: 'database' as const,
      prompt: l10n('Database'),
      validate: (value: string): string | null => (value.trim() ? null : l10n('Enter a database name'))
    }
  ];
  const totalSteps = steps.length + (role === 'target' ? 1 : 0);

  // Step-by-step input (005a): the title carries the role and step number; Esc cancels and abandons everything, writing no half-finished data.
  for (const [index, step] of steps.entries()) {
    const answer = await deps.showInputBox({
      prompt: step.prompt,
      title: `${roleLabel(role)} ${index + 1}/${totalSteps}`,
      value: step.key === 'password' ? undefined : draft[step.key],
      password: step.password,
      validateInput: step.validate
    });
    if (answer === undefined) {
      return; // cancel: what was typed is not written to disk
    }
    draft[step.key] = answer;
  }
  if (role === 'target') {
    // §6.1: the target environment is declared explicitly, only local/test are accepted.
    const environment = await deps.showQuickPick(['local', 'test'], { placeHolder: envPrompt });
    if (environment !== 'local' && environment !== 'test') {
      return;
    }
    draft.environment = environment;
  }

  // Summary page (005c): a password-free summary + save/test/edit/cancel; only save writes to disk.
  // When a secret is stored and the password is left empty this time, additionally offer "keep stored password" (005d explicit keep semantics).
  let keepSecret = false;
  for (;;) {
    // The options and the comparison share the same call value (010d: comparison does not depend on fixed language text).
    const saveLabel = l10n(CLONE_SUMMARY_SAVE);
    const keepSecretLabel = l10n(CLONE_SUMMARY_KEEP_SECRET);
    const testLabel = l10n(CLONE_SUMMARY_TEST);
    const editLabel = l10n(CLONE_SUMMARY_EDIT);
    const cancelLabel = l10n(CLONE_SUMMARY_CANCEL);
    const actions = [saveLabel];
    if (existing?.hasStoredSecret === true && draft.password === '') {
      actions.push(keepSecretLabel);
    }
    actions.push(testLabel, editLabel, cancelLabel);
    const picked = await deps.showQuickPick(actions, {
      placeHolder: cloneSummaryText(l10n, role, draft, existing?.hasStoredSecret === true)
    });
    if (!picked || picked === cancelLabel) {
      return; // cancel: no half-finished data written
    }
    if (picked === testLabel) {
      await testCloneDraftConnection(deps, role, draft);
      continue;
    }
    if (picked === editLabel) {
      await reviseDraftStep(deps, l10n, role, draft, { hostPrompt, envPrompt });
      continue;
    }
    if (picked === keepSecretLabel) {
      keepSecret = true;
      break;
    }
    if (picked === saveLabel) {
      break;
    }
    return; // an unknown choice (host differences / legacy scripts) is treated as cancel, never written to disk
  }

  // Save: keepSecret → password=undefined (the SecretStorage old key is kept as-is);
  // empty → null (clear); typed → overwrite. Secret-face failures report the error faithfully, never falsely reported as saved.
  const password = keepSecret
    ? undefined
    : draft.password === ''
      ? null
      : draft.password;
  try {
    if (role === 'target') {
      await deps.profiles.save(
        'target',
        {
          host: draft.host,
          port: draft.portText === '' ? 3306 : Number(draft.portText),
          user: draft.user,
          database: draft.database,
          environment: draft.environment
        },
        password
      );
    } else {
      await deps.profiles.save(
        'source',
        {
          host: draft.host,
          port: draft.portText === '' ? 3306 : Number(draft.portText),
          user: draft.user,
          database: draft.database
        },
        password
      );
    }
  } catch (error) {
    await deps.showErrorMessage(
      l10n('Save failed: {reason}', { reason: error instanceof Error ? error.message : String(error) })
    );
    return;
  }
  await deps.showInformationMessage(
    role === 'source' ? l10n('Source connection saved.') : l10n('Target connection saved.')
  );
}

/** Summary text (005c): connection parameters + password state, never echoing the password itself. */
function cloneSummaryText(
  l10n: CloneL10n,
  role: CloneProfileRole,
  draft: CloneProfileDraft,
  hasStoredSecret: boolean
): string {
  const passwordState = draft.password !== ''
    ? l10n('Password: entered, applied on save (never echoed)')
    : hasStoredSecret
      ? l10n('Password: saved; leaving empty clears it')
      : l10n('Password: none yet');
  const parts = [
    `Host ${draft.host}`,
    `Port ${draft.portText === '' ? 3306 : Number(draft.portText)}`,
    `User ${draft.user}`,
    `Database ${draft.database}`
  ];
  if (role === 'target') {
    parts.push(`Environment ${draft.environment}`);
  }
  parts.push(passwordState);
  return `${roleLabel(role)}: ${parts.join(' · ')}`;
}

/** Edit / go back to revise (005a): refill the chosen field, the input prefilled with the current draft value (the password is still never echoed). */
async function reviseDraftStep(
  deps: PlayerCloneCommandDeps,
  l10n: CloneL10n,
  role: CloneProfileRole,
  draft: CloneProfileDraft,
  prompts: { hostPrompt: string; envPrompt: string }
): Promise<void> {
  const portPrompt = l10n('Port (default 3306)');
  const userPrompt = l10n('Username');
  const passwordPrompt = l10n('Password (leave empty to remove the saved password)');
  const databasePrompt = l10n('Database');
  const items = [prompts.hostPrompt, portPrompt, userPrompt, passwordPrompt, databasePrompt];
  if (role === 'target') {
    items.push(prompts.envPrompt);
  }
  const picked = await deps.showQuickPick(items, { placeHolder: l10n(CLONE_SUMMARY_EDIT) });
  if (picked === undefined) {
    return; // cancel the edit: the draft is untouched, back to the summary
  }
  switch (picked) {
    case prompts.hostPrompt: {
      const answer = await deps.showInputBox({
        prompt: prompts.hostPrompt,
        title: `${roleLabel(role)} ${l10n(CLONE_SUMMARY_EDIT)}`,
        value: draft.host,
        validateInput: value => (value.trim() ? null : l10n('Enter a host address'))
      });
      if (answer !== undefined) { draft.host = answer; }
      return;
    }
    case portPrompt: {
      const answer = await deps.showInputBox({
        prompt: portPrompt,
        title: `${roleLabel(role)} ${l10n(CLONE_SUMMARY_EDIT)}`,
        value: draft.portText,
        validateInput: value => {
          if (value === '') { return null; }
          if (!/^\d+$/.test(value)) { return l10n('Port must be a number'); }
          const port = Number(value);
          return port >= 1 && port <= 65535 ? null : l10n('Port must be between 1 and 65535');
        }
      });
      if (answer !== undefined) { draft.portText = answer; }
      return;
    }
    case userPrompt: {
      const answer = await deps.showInputBox({
        prompt: userPrompt,
        title: `${roleLabel(role)} ${l10n(CLONE_SUMMARY_EDIT)}`,
        value: draft.user,
        validateInput: value => (value.trim() ? null : l10n('Enter a username'))
      });
      if (answer !== undefined) { draft.user = answer; }
      return;
    }
    case passwordPrompt: {
      const answer = await deps.showInputBox({
        prompt: passwordPrompt,
        title: `${roleLabel(role)} ${l10n(CLONE_SUMMARY_EDIT)}`,
        password: true
      });
      if (answer !== undefined) { draft.password = answer; }
      return;
    }
    case databasePrompt: {
      const answer = await deps.showInputBox({
        prompt: databasePrompt,
        title: `${roleLabel(role)} ${l10n(CLONE_SUMMARY_EDIT)}`,
        value: draft.database,
        validateInput: value => (value.trim() ? null : l10n('Enter a database name'))
      });
      if (answer !== undefined) { draft.database = answer; }
      return;
    }
    case prompts.envPrompt: {
      if (role !== 'target') { return; }
      const environment = await deps.showQuickPick(['local', 'test'], { placeHolder: prompts.envPrompt });
      if (environment === 'local' || environment === 'test') { draft.environment = environment; }
      return;
    }
    default:
      return; // an unknown choice: the draft is untouched
  }
}

/**
 * Summary page "test connection" (005c): builds a connection with the draft values and tests it,
 * carrying the raw reason on failure; the test writes nothing to disk.
 * When the password is left empty and a secret is stored, the existing password is taken with
 * save semantics for the test (consistent with the final save behavior).
 */
async function testCloneDraftConnection(
  deps: PlayerCloneCommandDeps,
  role: CloneProfileRole,
  draft: CloneProfileDraft
): Promise<void> {
  const password =
    draft.password !== ''
      ? draft.password
      : (await deps.profiles.resolveConnection(role))?.password;
  await showCloneConnectionTestResult(deps, role, {
    host: draft.host,
    port: draft.portText === '' ? 3306 : Number(draft.portText),
    user: draft.user,
    password,
    database: draft.database,
    environment: draft.environment
  });
}

/** The presentation face of the connection test (shared by the stored-config and summary-page draft paths): success carries the version, failure carries the reason. */
async function showCloneConnectionTestResult(
  deps: PlayerCloneCommandDeps,
  role: CloneProfileRole,
  config: {
    host: string;
    port: number;
    user: string;
    password: string | undefined;
    database: string;
    environment?: 'local' | 'test';
  }
): Promise<void> {
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  try {
    const connection = await openCloneSession(config);
    try {
      const result = await testCloneConnection(connection);
      if (result.ok) {
        await deps.showInformationMessage(
          l10n('{role} connection succeeded (server version {version}).', {
            role: role === 'source' ? 'Source' : 'Target',
            version: result.version
          })
        );
      } else {
        await deps.showErrorMessage(l10n('Connection failed: {reason}', { reason: result.reason }));
      }
    } finally {
      await connection.end();
    }
  } catch (error) {
    await deps.showErrorMessage(
      l10n('Connection failed: {reason}', { reason: error instanceof Error ? error.message : String(error) })
    );
  }
}

export async function runTestCloneConnectionCommand(
  deps: PlayerCloneCommandDeps,
  role: CloneProfileRole
): Promise<void> {
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  const config = await deps.profiles.resolveConnection(role);
  if (!config) {
    await deps.showWarningMessage(
      l10n('{role} connection is not configured.', { role: roleLabel(role) })
    );
    return;
  }
  await showCloneConnectionTestResult(deps, role, config);
}

// ---------------------------------------------------------------------------
// 0503 archive browsing
// ---------------------------------------------------------------------------

function renderArchiveSummary(l10n: CloneL10n, meta: ArchiveMetaWire): string[] {
  const lines = [
    l10n('Archive entity: {entity}', { entity: meta.entity }),
    l10n('Format: {format} v{version}', { format: meta.format, version: meta.version }),
    l10n('Total rows: {rows}', { rows: meta.total_rows }),
    l10n('Data bytes: {bytes}', { bytes: meta.total_bytes }),
    l10n('Encrypted: {state}', { state: meta.encrypted ? l10n('yes') : l10n('no (plaintext)') })
  ];
  for (const table of meta.tables) {
    lines.push(l10n('- {table}: {rows} rows', { table: table.name, rows: table.rows }));
  }
  lines.push(l10n('Checksums: {state}', {
    state: meta.files.includes('checksums.json') ? 'checksums.json ✓' : l10n('missing')
  }));
  lines.push(l10n('Redaction report: {state}', {
    state: meta.files.includes('redaction-report.json') ? 'redaction-report.json ✓' : l10n('missing')
  }));
  lines.push(l10n(PERSISTED_NOT_LIVE));
  return lines;
}

export async function runInspectCloneArchiveCommand(
  deps: PlayerCloneCommandDeps,
  archivePath?: string
): Promise<void> {
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  const path = archivePath ?? (await deps.pickArchiveOpenPath());
  if (!path) {
    return;
  }
  const inspected = await inspectCloneArchive(path, deps.getKeyRoot());
  if (inspected.status === 'no-gate') {
    await deps.showErrorMessage(l10n(noGateMessage));
    return;
  }
  if (inspected.status === 'error') {
    await deps.showErrorMessage(
      l10n('Failed to read the archive manifest: {reason}', { reason: inspected.reason })
    );
    return;
  }
  const lines = [`[Player Clone] ${path}`, ...renderArchiveSummary(l10n, inspected.result)];
  deps.channel.appendLine(lines.join('\n'));
  deps.channel.show(true);
  await deps.showInformationMessage(
    l10n('Archive manifest written to the output ({entity}, {rows} rows). {persisted}', {
      entity: inspected.result.entity,
      rows: inspected.result.total_rows,
      persisted: l10n(PERSISTED_NOT_LIVE)
    })
  );
}

// ---------------------------------------------------------------------------
// 0502 export
// ---------------------------------------------------------------------------

/**
 * UX-REVIEW-004b pre-checks depend on production wiring (004b-1 covers the missing-config face, these
 * two add the "usable backend + connection test" headroom): the backend probe = a light probe of gate
 * absence; the source-connection probe = a real connection + SELECT VERSION() that closes immediately
 * (the probe is a read-only session, carrying the raw reason on failure).
 */
export function cloneBackendProbe(): NonNullable<PlayerCloneCommandDeps['probeCloneBackend']> {
  return () => getKodeCoreShadowGate() !== null;
}

/**
 * UX-2026-11-22 increment 2: the probe gets an independent short-timeout tier (configurable via
 * kbengine.clone.probeTimeoutMs, default 5000). The probe only answers "can it connect right now",
 * it should not make the user wait for the export-execution side's long timeout (deadline 120s);
 * on timeout it immediately fails into the existing retry/configure dialog, the interaction face
 * unchanged. Export execution (openCloneSession/executeExportPlan) still uses the original timeout tier.
 */
export const CLONE_PROBE_TIMEOUT_MS_DEFAULT = 5000;

export function cloneSourceConnectionProbe(
  loadModule: () => Promise<CloneMysqlModule> = loadMysqlModule,
  probeTimeoutMs: number | (() => number) = CLONE_PROBE_TIMEOUT_MS_DEFAULT
): NonNullable<PlayerCloneCommandDeps['probeSourceConnection']> {
  return async config => {
    // Read the config on every call (gate discipline: the config/trust face is read at fire time, changes after wiring take effect immediately).
    const timeoutMs = typeof probeTimeoutMs === 'function' ? probeTimeoutMs() : probeTimeoutMs;
    // The mutable closure reference goes through a holder: TS cannot track direct-assignment narrowing across an async IIFE.
    const held: { session: CloneMysqlConnection | null } = { session: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probeWork: Promise<{ ok: true } | { ok: false; reason: string }> = (async () => {
      const conn = await openCloneSession(config, {}, loadModule);
      held.session = conn;
      try {
        const result = await testCloneConnection(conn);
        if (result.ok) {
          return { ok: true };
        }
        return { ok: false, reason: result.reason };
      } finally {
        try {
          await conn.end();
        } catch {
          // Same discipline as the export wrap-up: a failure to close the probe does not overwrite the probe result.
        }
      }
    })();
    const timeoutOutcome = new Promise<{ ok: false; reason: string }>(resolve => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            reason: `source connection probe timed out after ${timeoutMs}ms`
          }),
        timeoutMs
      );
    });
    try {
      return await Promise.race([probeWork, timeoutOutcome]);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      // Timeout path: a late-arriving session must be destroyed, the short probe tier must not leak a connection.
      if (held.session) {
        try {
          held.session.abort?.();
        } catch {
          // A failure to destroy an already-closing connection is harmless.
        }
      }
    }
  };
}

/** Source-connection option text (010d: comparison and display share the same value). */
export const EXPORT_SOURCE_FINAL_ITEM_PREFIX = 'Final config';
export const EXPORT_SOURCE_PROFILE_ITEM_PREFIX = 'Clone profile';

/** Single-line display of connection values (never echoing the password, only reporting presence). */
export function formatExportSourceConnectionItem(
  prefix: string,
  c: { host: string; port: number; user: string; database: string },
  l10n: CloneL10n
): string {
  const pwdMark = l10n('password: stored');
  return `${prefix}: ${c.host}:${c.port}  user=${c.user}  db=${c.database}  (${pwdMark})`;
}

/**
 * UX-2026-11-23 user order: export source-connection selection.
 * Prefer offering "read from the final config" (derived from the engine dbmgr/databaseInterfaces/default,
 * same chain as the read-only query), each item shows the actual values; there are also the clone
 * profile (legacy chain) and the configure-wizard items. The final config unavailable (derivation null)
 * and no profile → faithfully report "final config unavailable" and give a configure entry, no longer
 * silently falling straight into the manual-input wizard. Returning null = user cancel / unavailable
 * and unconfigured.
 */
export async function resolveExportSourceConnection(
  deps: PlayerCloneCommandDeps,
  l10n: CloneL10n
): Promise<{
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
} | null> {
  const finalConn = deps.resolveFinalConfigSourceConnection
    ? await deps.resolveFinalConfigSourceConnection()
    : null;
  const profileConn = await deps.profiles.resolveConnection('source');
  const finalItem = finalConn
    ? formatExportSourceConnectionItem(
        l10n(EXPORT_SOURCE_FINAL_ITEM_PREFIX),
        finalConn.config,
        l10n
      )
    : null;
  const profileItem = profileConn
    ? formatExportSourceConnectionItem(
        l10n(EXPORT_SOURCE_PROFILE_ITEM_PREFIX),
        profileConn,
        l10n
      )
    : null;
  const configureItem = l10n('Configure source connection');
  if (!finalItem && !profileItem) {
    // Final config unavailable and no profile: keep the old warning chain (faithfully report unconfigured + a configure entry),
    // no longer silently falling straight into the manual-input wizard.
    const choice = await deps.showWarningMessage(
      l10n('Source connection is not configured.'),
      configureItem
    );
    if (choice === configureItem) {
      await runConfigureCloneProfileCommand(deps, 'source');
      return await deps.profiles.resolveConnection('source');
    }
    return null;
  }
  const items = [finalItem, profileItem, configureItem].filter(
    (x): x is string => typeof x === 'string'
  );
  const placeHolder = l10n(
    'Select the export source connection (values shown are from the engine final config / saved profile)'
  );
  const picked = await deps.showQuickPick(items, { placeHolder });
  if (!picked || picked === configureItem) {
    if (picked === configureItem) {
      await runConfigureCloneProfileCommand(deps, 'source');
      return await deps.profiles.resolveConnection('source');
    }
    return null;
  }
  if (finalItem && picked === finalItem) {
    if (!finalConn) { return null; }
    if (finalConn.defaultsOnly) {
      // defaults-only: the values come from kbengine_defaults.xml, not this project's actual config, warn faithfully.
      await deps.showWarningMessage(l10n(playerCloneDefaultsOnlyWarning()));
    }
    return finalConn.config;
  }
  return profileConn;
}

/** The defaults-only warning (same discipline as the read-only query, but applied to the export source connection). */
export const playerCloneDefaultsOnlyWarning = (): string =>
  withL10nArgs(
    'Component kbengine.xml was not found; these values are engine defaults (kbengine_defaults.xml), not the final merged config. Place kbengine.xml under assetsRoot res/server/ (or check kbengine.assetsRoot) and retry.'
  );

export async function runExportCloneCommand(deps: PlayerCloneCommandDeps): Promise<void> {
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  const entityNames = deps.listEntityNames();
  if (entityNames.length === 0) {
    await deps.showWarningMessage(
      l10n('No registered entities found in the workspace (open a KBEngine project first).')
    );
    return;
  }
  // UX-REVIEW-004b: the backend-availability pre-check comes before input collection — no Rust gate is reported faithfully,
  // rather than dropping the entity/DBID inputs first.
  if (deps.probeCloneBackend && !deps.probeCloneBackend()) {
    await deps.showErrorMessage(l10n(noGateMessage));
    return;
  }
  // UX-2026-11-23 user order: the export source connection prefers reading the engine final config — the same
  // derivation chain as the read-only query (dbmgr/databaseInterfaces/default), no longer popping the manual-input
  // wizard directly when no profile exists.
  // Each quickpick item shows the actual values (host:port/db); choosing "clone profile" takes the legacy wizard chain.
  let config = await resolveExportSourceConnection(deps, l10n);
  if (!config) {
    return;
  }
  // UX-REVIEW-004b: the source-connection test entry — when the config is present but cannot connect,
  // give the reason faithfully with a retry/configure entry before entity/DBID collection;
  // collection continues only after the probe passes.
  if (deps.probeSourceConnection) {
    for (;;) {
      const probe = await deps.probeSourceConnection(config);
      if (probe.ok) { break; }
      const retry = l10n('Retry connection test');
      const configure = l10n('Configure source connection');
      const choice = await deps.showWarningMessage(
        l10n('Source connection test failed: {reason}', { reason: probe.reason }),
        retry,
        configure
      );
      if (choice === configure) {
        await runConfigureCloneProfileCommand(deps, 'source');
        const next = await deps.profiles.resolveConnection('source');
        if (!next) { return; }
        config = next;
        continue;
      }
      if (choice !== retry) { return; }
    }
  }
  // UX-2026-11-22 increment 1: remember the last selection — the last successfully exported entity goes on top (enter to pass),
  // the placeholder carries a "last:" hint; with no historical value the list order and placeholder stay as before (zero behavior change).
  const lastExport = deps.getLastExportSelection?.() ?? null;
  const lastEntity =
    lastExport && entityNames.includes(lastExport.entityName) ? lastExport.entityName : null;
  const orderedEntities = lastEntity
    ? [lastEntity, ...entityNames.filter(name => name !== lastEntity)]
    : entityNames;
  // UX-2026-11-23 user order: entity dialog "read from config" — the kbengine.clone.defaultEntity
  // effective value is inlined as the first item (the config value is visible, enter selects it);
  // when the config is empty, the value is not in the current corpus entity list (entity names are never guessed),
  // or it is the same entity as the last successful export (already on top, not duplicated) → no config item,
  // the list stays consistent with the old behavior.
  const cloneConfigDefaults = deps.getCloneExportConfigDefaults?.() ?? {};
  const configEntity = (cloneConfigDefaults.defaultEntity ?? '').trim();
  const configEntityKnown = configEntity !== '' && entityNames.includes(configEntity);
  const configEntityItem =
    configEntityKnown && configEntity !== lastEntity
      ? l10n('From config: {entity}', { entity: configEntity })
      : null;
  const entityItems = configEntityItem
    ? [configEntityItem, ...orderedEntities]
    : orderedEntities;
  const pickedEntity = await deps.showQuickPick(entityItems, {
    placeHolder: lastEntity
      ? l10n('Select the entity to export (last: {entity})', { entity: lastEntity })
      : l10n('Select the entity to export')
  });
  if (!pickedEntity) {
    return;
  }
  const entityName =
    configEntityItem && pickedEntity === configEntityItem ? configEntity : pickedEntity;
  // UX-REVIEW-004b: the entity-context (table-structure derivation) check is moved up before DBID input —
  // a derivation failure reports the error faithfully instead of dropping the already-typed DBID first.
  const derivationTables = deps.resolveEntityTables(entityName);
  if (!derivationTables || derivationTables.length === 0) {
    await deps.showErrorMessage(
      l10n('Cannot derive table structure for entity {entity} from workspace defs.', { entity: entityName })
    );
    return;
  }
  // UX-2026-11-23 user order: DBID input box "read from config" — the kbengine.clone.defaultDbId
  // effective value is written into the prompt (the config value is visible) and used as the prefill;
  // prefill priority = last successful export > config (consistent with the entity-dialog memory
  // convention); when the config is empty the prompt/prefill is byte-identical to the old behavior.
  const configDbId = (cloneConfigDefaults.defaultDbId ?? '').trim();
  const dbidBasePrompt = l10n('Root-table DBID (the entity primary key id)');
  const dbidPrompt = configDbId
    ? l10n('{base} (config default: {value})', { base: dbidBasePrompt, value: configDbId })
    : dbidBasePrompt;
  const dbidText = await deps.showInputBox({
    prompt: dbidPrompt,
    value: lastExport?.dbid || (configDbId || undefined),
    validateInput: value => (/^\d+$/.test(value) ? null : l10n('DBID must be a number'))
  });
  if (dbidText === undefined) {
    return;
  }

  const savePath = await deps.pickArchiveSavePath(
    `${entityName}-${dbidText}.kdpclone`,
    lastExport?.savePath ? dirnameOf(lastExport.savePath) : undefined
  );
  if (!savePath) {
    return;
  }

  try {
    const connection = await openCloneSession(config);
    try {
      const tableNames = derivationTables.map(table => table.name);
      const physicalTables = await probePhysicalTables(connection, tableNames);
      const plan = await planCloneExport({ tables: derivationTables }, physicalTables);
      if (plan.status === 'no-gate') {
        await deps.showErrorMessage(l10n(noGateMessage));
        return;
      }
      if (plan.status === 'error') {
        await deps.showErrorMessage(
          l10n('Failed to generate the export plan: {reason}', { reason: plan.reason })
        );
        return;
      }
      // UX-2026-11-22 increment 3: the plan preview moves into the dialog — the summary (table list/row budget/missing)
      // is merged into the encryption-confirmation quickpick placeholder, two steps become one; OUTPUT is still written for the record, not deleted.
      const tablesLine = l10n('Tables: {tables}', {
        tables: plan.result.queries.map(q => q.table).join(', ')
      });
      const budgetLine = l10n('Row budget: {budget}', { budget: plan.result.row_budget });
      const missingLine =
        plan.result.missing.length > 0
          ? l10n('Missing in source: {tables}', { tables: plan.result.missing.join(', ') })
          : null;
      const preview = [
        `[Player Clone Export] ${entityName} DBID=${dbidText}`,
        tablesLine,
        budgetLine
      ];
      if (missingLine) {
        preview.push(missingLine);
      }
      preview.push(l10n(PERSISTED_NOT_LIVE));
      deps.channel.appendLine(preview.join('\n'));
      deps.channel.show(true);

      // UX-2026-11-23 user order: the encryption-confirmation dialog "shows the config value" — the settings effective
      // value (kbengine.clone.archiveEncryption) is written into the confirmation dialog placeholder, the initial state
      // from the same source (PDC-0609: the last successful export takes priority over the config default).
      const archiveEncryptionDefault = deps.getArchiveEncryptionDefault?.() ?? 'encrypted';
      const encryptionDefaultLine = l10n(
        'Archive encryption default (kbengine.clone.archiveEncryption): {value}',
        { value: archiveEncryptionDefault }
      );
      const previewSummary = [
        tablesLine,
        budgetLine,
        ...(missingLine ? [missingLine] : []),
        encryptionDefaultLine
      ].join('\n');
      const encryptionChoice = await pickExportEncryption(
        deps.showQuickPick,
        plan.result.queries.length,
        // Increment 1: the last successful export's encryption bit is the initial state; with no historical value fall back to the setting (PDC-0609).
        lastExport ? lastExport.encrypt : archiveEncryptionDefault === 'encrypted',
        l10n,
        previewSummary
      );
      if (!encryptionChoice.confirmed) {
        return;
      }

      const rows = await deps.withProgress(
        { title: l10n('Player Clone: reading {entity} data (cancellable)', { entity: entityName }), cancellable: true },
        token => executeExportPlan(connection, plan.result, BigInt(dbidText), {
          shouldCancel: () => token.isCancellationRequested
        })
      );
      if (rows.length === 0) {
        await deps.showWarningMessage(
          l10n('DBID={dbid} returned no rows from the source database (nothing exported).', { dbid: dbidText })
        );
        return;
      }
      const written = await writeCloneArchive(
        savePath,
        entityName,
        rows,
        plan.result,
        encryptionChoice.encrypt ? deps.getKeyRoot() : undefined
      );
      if (written.status === 'no-gate') {
        await deps.showErrorMessage(l10n(noGateMessage));
        return;
      }
      if (written.status === 'error') {
        await deps.showErrorMessage(
          l10n('Failed to write the archive: {reason}', { reason: written.reason })
        );
        return;
      }
      await deps.showInformationMessage(
        l10n('Export finished: {rows} rows → {path} (sensitive columns redacted, {encryption}). {persisted}', {
          rows: written.result.total_rows,
          path: savePath,
          encryption: encryptionChoice.encrypt
            ? l10n('archive is encrypted')
            : l10n('archive is plaintext (not encrypted)'),
          persisted: l10n(PERSISTED_NOT_LIVE)
        })
      );
      // Increment 1: only the success path persists the memory (cancel/failure does not pollute the next prefill).
      deps.rememberExportSelection?.({
        entityName,
        dbid: dbidText,
        savePath,
        encrypt: encryptionChoice.encrypt
      });
    } finally {
      try {
        await connection.end();
      } catch (closeError) {
        // A cancelled or timed-out stream may already have closed the socket.
        // Do not replace the original export outcome with a close error.
        deps.channel.appendLine(`[Player Clone] ${l10n('Failed to close the read-only connection: {reason}', { reason: String(closeError) })}`);
      }
    }
  } catch (error) {
    if (error instanceof CloneCancelledError) {
      await deps.showWarningMessage(l10n('Export cancelled (read-only surface; no rollback needed).'));
      return;
    }
    await deps.showErrorMessage(
      l10n('Export failed: {reason}', { reason: error instanceof Error ? error.message : String(error) })
    );
  }
}

// ---------------------------------------------------------------------------
// 0504/0505 import (two-pass plan + rehearsal + second confirmation + single-transaction apply + audit)
// ---------------------------------------------------------------------------

export async function runImportCloneCommand(
  deps: PlayerCloneCommandDeps,
  archivePath?: string
): Promise<void> {
  // UX-REVIEW-004c: before importing, check the target config first (a missing config goes straight into the wizard,
  // cancel collects no further information) and the target environment (local/test only, §6.1 double protection);
  // connection reachability is verified as soon as the probe session is established (see testCloneConnection below);
  // a failure reports the reason faithfully and the import has not started (no duplicate guard registered, no write).
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  let targetConfig = await deps.profiles.resolveConnection('target');
  if (!targetConfig) {
    const action = l10n('Configure Target connection');
    const choice = await deps.showWarningMessage(
      l10n('Target connection is not configured (local/test only; run "{action}" first).', { action }),
      action
    );
    if (choice !== action) {
      return;
    }
    await runConfigureCloneProfileCommand(deps, 'target');
    targetConfig = await deps.profiles.resolveConnection('target');
    if (!targetConfig) {
      return; // the configure wizard was cancelled: no further information collected
    }
  }
  // §6.1 double protection: the ledger config gate already rejects prod/staging; an environment gate is added again before the import runs.
  if (targetConfig.environment !== 'local' && targetConfig.environment !== 'test') {
    await deps.showErrorMessage(
      l10n('Target environment accepts local/test only (import never writes production/staging).')
    );
    return;
  }

  const path = archivePath ?? (await deps.pickArchiveOpenPath());
  if (!path) {
    return;
  }

  const inspected = await inspectCloneArchive(path, deps.getKeyRoot());
  if (inspected.status !== 'ok') {
    await deps.showErrorMessage(
      inspected.status === 'no-gate'
        ? l10n(noGateMessage)
        : l10n('Failed to read the archive manifest: {reason}', { reason: inspected.reason })
    );
    return;
  }
  const entityName = inspected.result.entity;
  const derivationTables = deps.resolveEntityTables(entityName);
  if (!derivationTables || derivationTables.length === 0) {
    await deps.showErrorMessage(
      l10n('Cannot derive table structure for entity {entity} from workspace defs (import needs target schema reconciliation).', { entity: entityName })
    );
    return;
  }

  let committed = false;
  try {
    const plannedFingerprint = await fingerprintCloneArchive(path);
    const connection = await openCloneSession(targetConfig);
    let plan: ImportPlanWire | null = null;
    let rowsByTable = new Map<string, TypedRowWire[]>();
    let columnOrder = new Map<string, string[]>();
    try {
      // 004c: after the probe session is established, first verify the connection is reachable (a real SELECT);
      // a failure reports the reason faithfully — the import has not started: no duplicate guard registered, no plan generated, no write.
      const probe = await testCloneConnection(connection);
      if (!probe.ok) {
        await deps.showErrorMessage(
          l10n('Target connection failed: {reason} (import not started)', { reason: probe.reason })
        );
        return;
      }
      const tableNames = derivationTables.map(table => table.name);
      const physicalTables = await probePhysicalTables(connection, tableNames);
      // Unique key = the target's single-column unique index (probed from information_schema; composite keys
      // are not rehearsed in v1, an insert-time conflict still fails closed and rolls back).
      const uniqueKeys = physicalTables
        .filter(table => table.indexes.some(columns => columns.length === 1))
        .flatMap(table =>
          table.indexes
            .filter(columns => columns.length === 1)
            .map(columns => ({ table: table.name, column: columns[0] }))
        );

      // pass-1: an empty-snapshot plan → the column order (archive rows carry no column names, value order = export column order).
      const pass1 = await planCloneImport(
        path,
        {
          environment: targetConfig.environment === 'test' ? 'test' : 'local',
          dbInterface: 'mysql',
          writable: true,
          host: targetConfig.host,
          port: targetConfig.port,
          database: targetConfig.database
        },
        { tables: derivationTables },
        physicalTables,
        { uniqueKeys, existingValues: [] },
        deps.getKeyRoot()
      );
      if (pass1.status === 'no-gate') {
        await deps.showErrorMessage(l10n(noGateMessage));
        return;
      }
      if (pass1.status === 'error') {
        await deps.showErrorMessage(
          l10n('Failed to generate the import plan: {reason}', { reason: pass1.reason })
        );
        return;
      }
      columnOrder = columnOrderFromPlan(pass1.result);

      // Archive rows → unique-value candidates → bounded probe of existing target values → pass-2 conflict rehearsal.
      const rowsCall = await readCloneArchiveRows(path, deps.getKeyRoot());
      if (rowsCall.status === 'no-gate') {
        await deps.showErrorMessage(l10n(noGateMessage));
        return;
      }
      if (rowsCall.status === 'error') {
        await deps.showErrorMessage(
          l10n('Failed to read archive rows: {reason}', { reason: rowsCall.reason })
        );
        return;
      }
      rowsByTable = new Map(rowsCall.result.tables.map(t => [t.name, t.rows]));
      const candidates = uniqueValuesFromRows(rowsByTable, columnOrder, uniqueKeys);
      const existingValues =
        candidates.length > 0 ? await probeExistingValues(connection, candidates) : [];

      const pass2 = await planCloneImport(
        path,
        {
          environment: targetConfig.environment === 'test' ? 'test' : 'local',
          dbInterface: 'mysql',
          writable: true,
          host: targetConfig.host,
          port: targetConfig.port,
          database: targetConfig.database
        },
        { tables: derivationTables },
        physicalTables,
        { uniqueKeys, existingValues },
        deps.getKeyRoot()
      );
      if (pass2.status !== 'ok') {
        await deps.showErrorMessage(
          pass2.status === 'no-gate'
            ? l10n(noGateMessage)
            : l10n('Failed to rehearse the import: {reason}', { reason: pass2.reason })
        );
        return;
      }
      plan = pass2.result;
    } finally {
      // The probe connection is a read-only session; the apply needs a write transaction, so another one is opened (same config).
      await connection.end();
    }
    if (!plan) {
      return;
    }
    const confirmedPlan: ImportPlanWire = plan;

    // ---- preview (PDC-0504: per table / per category / conflicts / binding / warnings + Persisted≠Live) ----
    const perTable = Object.entries(plan.summary.statements_per_table)
      .map(([table, count]) => `${table}×${count}`)
      .join(', ');
    const categories = Object.entries(plan.summary.id_categories)
      .map(([label, count]) => `${label}×${count}`)
      .join(', ');
    const previewLines = [
      `[Player Clone Import] ${path}`,
      l10n('Entity: {entity}', { entity: plan.entity_name }),
      l10n('Statements: {statements}', { statements: perTable }),
      l10n('ID categories: {categories}', { categories: categories || l10n('none') }),
      l10n('Unique conflicts: {count} (strategy: local rebuild with an _imported suffix)', {
        count: plan.summary.unique_conflicts
      }),
      l10n('Account binding: {note}', { note: plan.account_binding.note }),
      l10n('Unresolved references: {count}', { count: plan.summary.unresolved_reference_risks })
    ];
    for (const warning of plan.warnings) {
      previewLines.push(l10n('- warning: {warning}', { warning }));
    }
    previewLines.push(l10n(PERSISTED_NOT_LIVE));
    deps.channel.appendLine(previewLines.join('\n'));
    deps.channel.show(true);

    // The options and the comparison share the same call value (010d: comparison does not depend on fixed language text).
    const continueLabel = l10n('Continue to confirmation');
    const firstCancelLabel = l10n(EXPORT_CANCEL_ITEM);
    const firstConfirm = await deps.showQuickPick(
      [continueLabel, firstCancelLabel],
      { placeHolder: l10n('Import {count} statements into {database}?', {
          count: plan.statements.length,
          database: targetConfig.database
        }) }
    );
    if (firstConfirm !== continueLabel) {
      return;
    }
    // Second confirmation of the local environment (§6.1: the target must be a local/test database, a write must not be disguised as a rehearsal).
    const confirmWriteLabel = l10n('Confirm write to local database {host}:{port}/{database}', {
      host: targetConfig.host,
      port: targetConfig.port,
      database: targetConfig.database
    });
    const secondConfirm = await deps.showQuickPick(
      [confirmWriteLabel, firstCancelLabel],
      { placeHolder: l10n('Second confirmation: this is a real write to a local/test database (single transaction, full rollback on failure).') }
    );
    if (!secondConfirm || secondConfirm !== confirmWriteLabel) {
      return;
    }

    // Persist before any database writes. An interrupted or ambiguous attempt must
    // continue to block automatic retries across extension restarts.
    const keyRoot = deps.getKeyRoot();
    if (!keyRoot) {
      throw new Error(l10n('Missing persistence directory; cannot guard against duplicate imports'));
    }
    const fingerprint = await fingerprintCloneArchive(path);
    if (fingerprint !== plannedFingerprint) {
      throw new Error(l10n('The archive changed while the import was being planned; rehearse again'));
    }
    const reservation = await reserveCloneImport(keyRoot, fingerprint, targetConfig);
    if (reservation.duplicate) {
      deps.channel.appendLine(`[Player Clone] ${l10n('A previous import or unfinished attempt was detected: {reservation}', { reservation: reservation.reservation })}\n${reservation.prior ?? ''}`);
      deps.channel.show(true);
      const copyLabel = l10n('Create another copy anyway');
      const choice = await deps.showQuickPick(
        [firstCancelLabel, copyLabel],
        { placeHolder: l10n('This archive has already been imported (or attempted) on this machine for this target; verify the target database first.') }
      );
      if (choice !== copyLabel) {
        return;
      }
    }

    // ---- Apply: reopen the connection (write transaction; readonly:false) + progress + cancel (§6.4 cancel = rollback) ----
    const writeConnection = await openCloneSession(targetConfig, { readonly: false });
    try {
      const result = await deps.withProgress(
        { title: l10n('Player Clone: importing {entity} (cancel = rollback)', { entity: entityName }), cancellable: true },
        token =>
          applyImportPlan(writeConnection, confirmedPlan, rowsByTable, columnOrder, {
            shouldCancel: () => token.isCancellationRequested
          })
      );
      committed = true;
      const verifyOk = result.verify.every(check => check.ok);
      const audit = {
        kind: 'player-clone-import-run',
        finished_at_unix: Math.floor(deps.now() / 1000),
        archive_path: path,
        entity: plan.entity_name,
        mode: plan.mode,
        autoload_policy: plan.autoload_policy,
        inserted_per_table: result.insertedPerTable,
        resolved_ids: result.resolvedIds,
        new_root_id: result.newRootId,
        verify: result.verify,
        cleanup_plan_not_executed: result.cleanup,
        load_verification: {
          attempted: false,
          note: l10n('Engine-side load verification requires a local KBEngine runtime (PDC-0003) and is not wired yet; the post-commit COUNT recheck above is what runs.')
        }
      };
      const auditPath = await deps.writeAuditFile(
        `import-${plan.entity_name}-${Math.floor(deps.now() / 1000)}.json`,
        JSON.stringify(audit, null, 2)
      );
      if (!verifyOk) {
        await deps.showErrorMessage(
          l10n('Import committed but verification did not fully pass (see audit {path}); the data itself is atomically intact — verify manually.', { path: auditPath })
        );
        return;
      }
      await deps.showInformationMessage(
        l10n('Import finished: new DBID={dbid}; audit {path}; cleanup plan generated but not executed. {persisted}', {
          dbid: result.newRootId ?? l10n('(kept as-is)'),
          path: auditPath,
          persisted: l10n(PERSISTED_NOT_LIVE)
        })
      );
    } finally {
      try {
        await writeConnection.end();
      } catch (closeError) {
        deps.channel.appendLine(`[Player Clone] ${l10n('Failed to close the connection: {reason}', { reason: String(closeError) })}`);
      }
    }
  } catch (error) {
    const target = `${targetConfig.host}:${targetConfig.port}/${targetConfig.database}`;
    const detail = error instanceof Error ? error.message : String(error);
    if (committed || error instanceof ClonePostCommitError) {
      await deps.showErrorMessage(
        l10n('Import committed, but verification or audit failed: {detail}. Check the target {target} and the archive {path} first; do not retry blindly.', { detail, target, path })
      );
      return;
    }
    if (error instanceof CloneCommitUnknownError || error instanceof CloneRollbackUnknownError) {
      await deps.showErrorMessage(
        l10n('Import outcome uncertain: {detail}. Check the target {target} and the archive {path} first; do not retry blindly.', { detail, target, path })
      );
      return;
    }
    if (error instanceof CloneApplyCancelledError) {
      await deps.showWarningMessage(
        l10n('Import cancelled: the transaction was rolled back; no rows were written.')
      );
      return;
    }
    await deps.showErrorMessage(
      l10n('Import failed: {detail}. Target {target}; verify before retrying.', { detail, target })
    );
  }
}

// ---------------------------------------------------------------------------
// 0505 audit review
// ---------------------------------------------------------------------------

export async function runShowCloneAuditCommand(deps: PlayerCloneCommandDeps): Promise<void> {
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  const files = await deps.listAuditFiles();
  if (files.length === 0) {
    await deps.showWarningMessage(l10n('No import audit records yet (.kode/clone-runs/).'));
    return;
  }
  const picked = await deps.showQuickPick(files, { placeHolder: l10n('Select an import audit to view') });
  if (!picked) {
    return;
  }
  const content = await deps.readAuditFile(picked);
  if (content === null) {
    await deps.showErrorMessage(l10n('Failed to read the audit: {path}', { path: picked }));
    return;
  }
  deps.channel.appendLine(`[Player Clone Audit] ${picked}\n${content}`);
  deps.channel.show(true);
}
