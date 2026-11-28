/**
 * DEMO-GAME-026: real-machine feature walkthrough matrix (todo 007 matrix ③,
 * one test per face, driven on the shipped demo asset tree with the new
 * entity chains Pet/Equipment/Talisman/Formation/Monster->Avatar).
 *
 * Faces and their real production chains (no provider re-instantiation):
 *  1  def<->py jump          vscode.executeDefinitionProvider both directions
 *  2  parent-chain MRO       kbengine.python.mroChain CodeLens + def provider
 *                            on `class Equipment(Item)` base name
 *  3  RW grouped references  kbengine.findReferencesRW production entry
 *                            (runFindReferencesRW with the real vscode API;
 *                             only the final quickpick is intercepted because
 *                             a headless modal never resolves)
 *  4  dict.get value type    hover over GEM_CATALOG.get(...) read site
 *  5  FIXED_DICT inline      hover spiritRoots in Avatar.def + self-prop face
 *  6  config merge           kbengine.config.showFinalText against the real
 *                            engine defaults (templates/kbe) + override 500
 *  7  createNamespace hover  hover __init__ in base/Pet.py (CREATE-06 face)
 *  8  hot reload panel       kbengine.hotReload.historyPanel -> webview tab
 *  9  base<->cell switch     kbengine.processOwnership.openBase/openCell on
 *                            the real Avatar mirror files
 * 10  create params check    KBEngine.createEntity("Pet", unknown key) ->
 *                            create-params-* diagnostic (Rust chain)
 * 11  entities.xml audit     kbengine.entities.checkRegistration route +
 *                            the same audit functions the command feeds
 *
 * Workspace = --walk026 assembly: tmp copy of tests/fixtures/kbengine-demo-assets
 * (writable), kbengine.engineRoot -> templates/kbe for the config merge face.
 * Evidence: one JSON line per face, appended to
 * docs/acceptance-evidence/evidence/DEMO-GAME-026-walk.jsonl (override via
 * KODE_DEMO026_EVIDENCE).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { runFindReferencesRW } from '../../../rwReferencesCommand';
import { getDefinitionWorkspaceLayout } from '../../../definitionWorkspace';
import {
  auditEntitiesRegistration,
  collectAuditStats,
  renderEntitiesRegistrationAudit
} from '../../../backend/entitiesRegistrationAudit';

const DEMO_ROOT = process.env.KODE_DEMO_WORKSPACE;
assert.ok(DEMO_ROOT, 'runTest.js --walk026 must set KODE_DEMO_WORKSPACE');
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EVIDENCE_PATH = process.env.KODE_DEMO026_EVIDENCE
  ?? path.join(REPO_ROOT, 'docs', 'acceptance-evidence', 'evidence', 'DEMO-GAME-026-walk.jsonl');

const SLEEP_MS = 500;
const WARMUP_MS = 90_000;
const DIAG_MS = 90_000;
const MRO_COMMAND = 'kbengine.python.mroChain';
// DEMO-GAME-026-GAP-B guard: py-side create-params diagnostics are unreachable
// in production until the TS bridge starts pulling Rust diagnostics for python
// documents (todo.md row DEMO-GAME-026-GAP-B). Face 10 flips to active when it
// closes; the probe body below is the acceptance pin for that fix.
const GAP_B_PY_CREATE_PARAMS_UNRESOLVED = true;

function evidence(face: string, data: unknown): void {
  fs.appendFileSync(EVIDENCE_PATH, `${JSON.stringify({ face, data })}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findLine(text: string, needle: string): number {
  const line = text.split(/\r?\n/).findIndex(row => row.includes(needle));
  assert.ok(line >= 0, `anchor missing in workspace: ${needle}`);
  return line;
}

/** Zero-width locations are kode's; VS Code's built-in word-based fallback
 * appends word-wide ranges asynchronously, so filter like demoNavigation. */
function kodeLocations(raw: unknown): vscode.Location[] {
  const locations = Array.isArray(raw) ? raw as vscode.Location[] : raw ? [raw as vscode.Location] : [];
  return locations.filter(location =>
    location.range.start.line === location.range.end.line &&
    location.range.start.character === location.range.end.character);
}

async function openDoc(relative: string): Promise<vscode.TextDocument> {
  // execute*Provider calls need a live text model (Illegal argument on
  // never-opened files), so openTextDocument first.
  return vscode.workspace.openTextDocument(vscode.Uri.file(path.join(DEMO_ROOT!, relative)));
}

async function hoverTextAt(document: vscode.TextDocument, line: number, character: number): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider', document.uri, new vscode.Position(line, character));
  const parts: string[] = [];
  for (const hover of hovers ?? []) {
    for (const content of hover.contents) {
      if (typeof content === 'string') {
        parts.push(content);
      } else if (content instanceof vscode.MarkdownString) {
        parts.push(content.value);
      } else if ('value' in (content as unknown as Record<string, unknown>)) {
        parts.push(String((content as unknown as Record<string, unknown>).value));
      }
    }
  }
  return parts.join('\n');
}

async function mroLenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  await vscode.workspace.openTextDocument(uri);
  const all = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider', uri);
  return (all ?? []).filter(lens => lens.command?.command === MRO_COMMAND);
}

function chainCount(lens: vscode.CodeLens): number {
  const args = (lens.command as unknown as { arguments?: [unknown[]] } | undefined)?.arguments;
  return Array.isArray(args?.[0]) ? (args![0] as unknown[]).length : -1;
}

describe('DEMO-GAME-026 feature walkthrough matrix (real machine)', function () {
  this.timeout(180_000);

  before(async function () {
    const extension = vscode.extensions.getExtension('cuihairu.kode-kbengine');
    assert.ok(extension, 'Kode extension is unavailable in the extension host');
    await extension.activate();
    assert.strictEqual(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, DEMO_ROOT);
    // Cold-start warmup: poll a mirrored cell method until the def-mixin MRO
    // lens chain appears -- asserting on steady state, not first-scan luck.
    const avatar = vscode.Uri.file(path.join(DEMO_ROOT!, 'scripts', 'cell', 'Avatar.py'));
    const deadline = Date.now() + WARMUP_MS;
    let last = -1;
    while (Date.now() < deadline) {
      last = (await mroLenses(avatar)).length;
      if (last > 0) { return; }
      await sleep(SLEEP_MS);
    }
    assert.fail(`warmup timed out: Avatar.py never produced MRO lenses (last=${last})`);
  });

  it('face 1: def<->py jump (reqAttack both directions)', async function () {
    const cellPy = await openDoc('scripts/cell/Avatar.py');
    const pyLine = findLine(cellPy.getText(), 'def reqAttack');
    const pyChar = cellPy.lineAt(pyLine).text.indexOf('reqAttack') + 2;
    const pyRaw = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider', cellPy.uri, new vscode.Position(pyLine, pyChar));
    const pyHits = kodeLocations(pyRaw);
    const defLine = findLine(fs.readFileSync(path.join(DEMO_ROOT!, 'scripts', 'entity_defs', 'Avatar.def'), 'utf8'), '<reqAttack>');
    const toDef = pyHits.find(location => location.uri.fsPath.endsWith('Avatar.def'));
    assert.ok(toDef, `py->def expected an Avatar.def location, got ${JSON.stringify(pyHits.map(l => l.uri.fsPath))}`);
    assert.strictEqual(toDef.range.start.line, defLine, 'py->def must land on the <reqAttack> def declaration line');

    const defDoc = await openDoc('scripts/entity_defs/Avatar.def');
    const defChar = defDoc.lineAt(defLine).text.indexOf('reqAttack') + 2;
    const defRaw = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider', defDoc.uri, new vscode.Position(defLine, defChar));
    const defHits = kodeLocations(defRaw);
    const toPy = defHits.find(location => location.uri.fsPath.endsWith('cell' + path.sep + 'Avatar.py'));
    assert.ok(toPy, `def->py expected cell/Avatar.py, got ${JSON.stringify(defHits.map(l => l.uri.fsPath))}`);
    assert.strictEqual(toPy.range.start.line, pyLine, 'def->py must land on the reqAttack implementation');
    evidence('def-py-jump', { pyToDef: `${toDef.uri.fsPath}:${toDef.range.start.line + 1}`, defToPy: `${toPy.uri.fsPath}:${toPy.range.start.line + 1}` });
  });

  it('face 2: parent-chain faces (lens positive+zero-chain gate, class base names)', async function () {
    // (a) The interfaces-mixin MRO lens: Avatar (def Interfaces ROLE) chains;
    // unchained entities must stay at zero lenses (broadcast-gate discipline:
    // a def-mixin broadcast onto chainless files was the 2026-11-26 defect).
    const avatarLenses = await mroLenses(vscode.Uri.file(path.join(DEMO_ROOT!, 'scripts', 'cell', 'Avatar.py')));
    assert.ok(avatarLenses.some(lens => chainCount(lens) >= 2), 'Avatar must keep its ROLE mixin chains');
    const formation = await openDoc('scripts/cell/Formation.py');
    const formationLenses = await mroLenses(formation.uri);
    assert.strictEqual(formationLenses.length, 0, `Formation has no Interfaces and must carry zero chains, got ${JSON.stringify(formationLenses.map(l => ({ line: l.range.start.line, chains: chainCount(l) })))}`);
    // (b) py-level class base names on the new chains:
    //     Equipment(Item) -> base/Item.py, Monster(Avatar) -> Avatar face.
    const equipment = await openDoc('scripts/base/Equipment.py');
    const baseLine = findLine(equipment.getText(), 'class Equipment(Item');
    const baseChar = equipment.lineAt(baseLine).text.indexOf('(Item') + 2;
    const raw = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider', equipment.uri, new vscode.Position(baseLine, baseChar));
    const hits = kodeLocations(raw);
    const item = hits.find(location => location.uri.fsPath.endsWith('Item.py'));
    assert.ok(item, `expected a base/Item.py location for the base name, got ${JSON.stringify(hits.map(l => l.uri.fsPath))}`);

    const monster = await openDoc('scripts/cell/Monster.py');
    const monsterLine = findLine(monster.getText(), 'class Monster(Avatar');
    const monsterChar = monster.lineAt(monsterLine).text.indexOf('(Avatar') + 2;
    const monsterRaw = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider', monster.uri, new vscode.Position(monsterLine, monsterChar));
    const monsterHits = kodeLocations(monsterRaw);
    const avatarBase = monsterHits.find(location => location.uri.fsPath.endsWith('Avatar.py'));
    assert.ok(avatarBase, `expected an Avatar.py location for the Monster base name, got ${JSON.stringify(monsterHits.map(l => l.uri.fsPath))}`);
    evidence('mro-faces', {
      avatarLensChains: avatarLenses.map(lens => ({ line: lens.range.start.line + 1, chains: chainCount(lens), title: lens.command?.title ?? '' })),
      formationZeroChain: true,
      equipmentToItem: `${item.uri.fsPath}:${item.range.start.line + 1}`,
      monsterToAvatar: `${avatarBase.uri.fsPath}:${avatarBase.range.start.line + 1}`
    });
  });

  it('face 3: RW grouped references on Sect.members (real chain, quickpick intercepted)', async function () {
    const sect = await openDoc('scripts/base/Sect.py');
    const line = findLine(sect.getText(), 'self.members = [m for m in self.members');
    const memberWord = 'self.members';
    const wordAt = sect.lineAt(line).text.indexOf(memberWord) + 'self.'.length;
    const editor = await vscode.window.showTextDocument(sect);
    // The cursor must sit INSIDE the `members` word: the symbol at position
    // selects the read/write face (a cursor on `self` resolves nothing).
    editor.selection = new vscode.Selection(
      new vscode.Position(line, wordAt),
      new vscode.Position(line, wordAt)
    );
    let pickedItems: unknown = null;
    const realWindow = vscode.window;
    const wrapped = {
      window: {
        get activeTextEditor() { return realWindow.activeTextEditor; },
        showQuickPick: async (items: unknown) => { pickedItems = items; return undefined; },
        showInformationMessage: () => undefined,
        showTextDocument: (uri: vscode.Uri, options?: vscode.TextDocumentShowOptions) =>
          realWindow.showTextDocument(uri, options)
      },
      commands: { executeCommand: (command: string, ...args: unknown[]) => vscode.commands.executeCommand(command, ...args as []) },
      workspace: { openTextDocument: (uri: vscode.Uri) => vscode.workspace.openTextDocument(uri) },
      Uri: vscode.Uri,
      QuickPickItemKind: vscode.QuickPickItemKind
    };
    const result = await runFindReferencesRW({ vscode: wrapped as never });
    assert.ok(result && !result.noFace, 'RW reference face must resolve on self.members');
    assert.ok(result.counts.write >= 1, `expected at least one write site, counts=${JSON.stringify(result.counts)}`);
    assert.ok(result.counts.read >= 1, `expected at least one read site, counts=${JSON.stringify(result.counts)}`);
    assert.ok(result.heading.includes('members'), `heading should name the symbol, got: ${result.heading}`);
    evidence('rw-references', {
      heading: result.heading,
      counts: result.counts,
      groups: {
        write: result.groups.write.map(site => `${path.basename(site.file)}:${site.line + 1}`),
        read: result.groups.read.map(site => `${path.basename(site.file)}:${site.line + 1}`).slice(0, 12),
        delete: result.groups.delete.map(site => `${path.basename(site.file)}:${site.line + 1}`)
      },
      quickpickItems: Array.isArray(pickedItems) ? (pickedItems as unknown[]).length : null
    });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('face 4: dict key value-type hover on a literal-key read (incl. .get)', async function () {
    // The production hover resolves the key span of a literal-key read, not
    // the `.get` method name. The probe carries both shapes on a module-level
    // literal dict, then the real registered hover provider answers both.
    const probePath = path.join(DEMO_ROOT!, 'scripts', 'base', 'dictProbe026.py');
    fs.writeFileSync(probePath, [
      'CONFIG_026 = {"PORT": 7000, "NAME": "demo"}',
      'port_026 = CONFIG_026["PORT"]',
      'name_026 = CONFIG_026.get("NAME")',
      ''
    ].join('\n'), 'utf8');
    try {
      const doc = await openDoc('scripts/base/dictProbe026.py');
      const subscriptLine = findLine(doc.getText(), 'CONFIG_026["PORT"]');
      const subscriptChar = doc.lineAt(subscriptLine).text.indexOf('"PORT"') + 1;
      const getLine = findLine(doc.getText(), 'CONFIG_026.get("NAME")');
      const getChar = doc.lineAt(getLine).text.indexOf('"NAME"') + 1;
      const subscriptHover = await hoverTextAt(doc, subscriptLine, subscriptChar);
      const getHover = await hoverTextAt(doc, getLine, getChar);
      assert.ok(subscriptHover.includes('CONFIG_026') && subscriptHover.includes('int'),
        `expected the subscript read hover on CONFIG_026["PORT"], got: ${subscriptHover.slice(0, 400)}`);
      assert.ok(getHover.includes('CONFIG_026') && getHover.includes('str'),
        `expected the .get read hover on CONFIG_026.get("NAME"), got: ${getHover.slice(0, 400)}`);
      evidence('dict-key-hover', {
        subscript: subscriptHover.slice(0, 1000),
        dotGet: getHover.slice(0, 1000)
      });
    } finally {
      fs.rmSync(probePath, { force: true });
    }
  });

  it('face 5: FIXED_DICT inline expansion (def hover + self-property hover)', async function () {
    const defDoc = await openDoc('scripts/entity_defs/Avatar.def');
    const defLine = findLine(defDoc.getText(), '<spiritRoots>');
    const defChar = defDoc.lineAt(defLine).text.indexOf('spiritRoots') + 2;
    const defHover = await hoverTextAt(defDoc, defLine, defChar);
    assert.ok(defHover.includes('SPIRIT_ROOTS'), `expected the def hover to inline SPIRIT_ROOTS, got: ${defHover.slice(0, 400)}`);

    const avatar = await openDoc('scripts/base/Avatar.py');
    const pyLine = findLine(avatar.getText(), 'dominant_root(self.spiritRoots)');
    const pyChar = avatar.lineAt(pyLine).text.indexOf('self.spiritRoots') + 'self.'.length;
    const pyHover = await hoverTextAt(avatar, pyLine, pyChar);
    assert.ok(pyHover.includes('SPIRIT_ROOTS'), `self.spiritRoots hover must resolve the SPIRIT_ROOTS type, got: ${pyHover.slice(0, 400)}`);
    evidence('fixed-dict-hover', {
      defAnchor: `Avatar.def:${defLine + 1}`,
      defHover: defHover.slice(0, 1200),
      pyAnchor: `base/Avatar.py:${pyLine + 1}`,
      pyHover: pyHover.slice(0, 1200)
    });
  });

  it('face 6: config merge shows override 500 on top of real engine defaults', async function () {
    await vscode.commands.executeCommand('kbengine.config.showFinalText');
    let text = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.scheme === 'kbengine-config') {
        text = editor.document.getText();
        break;
      }
      await sleep(SLEEP_MS);
    }
    if (text === '') {
      const uri = vscode.Uri.parse('kbengine-config:/kbengine-final.xml');
      const document = await vscode.workspace.openTextDocument(uri);
      text = document.getText();
    }
    assert.ok(text.includes('backupPeriod'), 'final config missing the overridden key');
    assert.ok(/backupPeriod>\s*500\s*</.test(text), `override 500 not applied in merged view: ${text.slice(0, 300)}`);
    assert.ok(text.includes('<baseappmgr>'), 'defaults-only section baseappmgr missing from merged view');
    evidence('config-merge', {
      bytes: text.length,
      overrideApplied: /backupPeriod>\s*500\s*</.test(text),
      defaultsPresent: text.includes('<baseappmgr>'),
      head: text.slice(0, 400)
    });
  });

  it('face 7: createNamespace timeline hover on base/Pet.py __init__', async function () {
    const pet = await openDoc('scripts/base/Pet.py');
    const line = findLine(pet.getText(), 'def __init__');
    const char = pet.lineAt(line).text.indexOf('__init__') + 2;
    const hover = await hoverTextAt(pet, line, char);
    assert.ok(hover.includes('createNamespace'), `expected the createNamespace timeline hover, got: ${hover.slice(0, 400)}`);
    evidence('create-namespace-hover', { anchor: `base/Pet.py:${line + 1}`, hover: hover.slice(0, 1600) });
  });

  it('face 8: hot reload history panel opens as a real webview tab', async function () {
    const commandKnown = (await vscode.commands.getCommands()).includes('kbengine.hotReload.historyPanel');
    assert.ok(commandKnown, 'kbengine.hotReload.historyPanel must be registered on activate');
    await vscode.commands.executeCommand('kbengine.hotReload.historyPanel');
    const deadline = Date.now() + 15_000;
    let found = false;
    let snapshot: unknown = null;
    while (Date.now() < deadline) {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
      snapshot = tabs.map(tab => ({
        kind: tab.input?.constructor?.name ?? String(tab.input),
        viewType: (tab.input as { viewType?: string } | undefined)?.viewType ?? null
      }));
      found = tabs.some(tab =>
        tab.input instanceof vscode.TabInputWebview &&
        // The host prefixes registered view types on real machines
        // (observed: mainThreadWebview-kbengineHotReloadHistory).
        tab.input.viewType.endsWith('kbengineHotReloadHistory'));
      if (found) { break; }
      await sleep(SLEEP_MS);
    }
    assert.ok(found, `expected a kbengineHotReloadHistory webview tab after the panel command, tabs=${JSON.stringify(snapshot)}`);
    evidence('hot-reload-panel', { opened: true, tabCount: vscode.window.tabGroups.all.flatMap(group => group.tabs).length });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('face 9: base<->cell switch on the real Avatar mirror files', async function () {
    const base = path.join(DEMO_ROOT!, 'scripts', 'base', 'Avatar.py');
    const cell = path.join(DEMO_ROOT!, 'scripts', 'cell', 'Avatar.py');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(base)));
    assert.strictEqual(vscode.window.activeTextEditor?.document.fileName, base);
    await vscode.commands.executeCommand('kbengine.processOwnership.openCell');
    assert.strictEqual(vscode.window.activeTextEditor?.document.fileName, cell, 'openCell must land on cell/Avatar.py');
    await vscode.commands.executeCommand('kbengine.processOwnership.openBase');
    assert.strictEqual(vscode.window.activeTextEditor?.document.fileName, base, 'openBase must land back on base/Avatar.py');
    evidence('base-cell-switch', { base, cell });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('face 10: createEntity("Pet") with an unknown key raises a create-params diagnostic', async function () {
    // Registered product gap (todo.md DEMO-GAME-026-GAP-B): the Rust server
    // already implements the .py create-params analysis chain
    // (server.rs analyze_create_params_calls), but the TS bridge gates the
    // textDocument/diagnostic pull on .def documents (kodeCoreShadowFaces.ts
    // isDefDocument), so py-side diagnostics are unreachable in production.
    // Flip the guard when the gap closes; the probe body below stays as the
    // acceptance钉 for that fix.
    if (GAP_B_PY_CREATE_PARAMS_UNRESOLVED) { this.skip(); }
    const probePath = path.join(DEMO_ROOT!, 'scripts', 'base', 'paramsProbe026.py');
    fs.writeFileSync(probePath, [
      'import KBEngine',
      '',
      '',
      'def spawn_probe():',
      '    KBEngine.createEntity("Pet", {"noSuchParam026": 1})',
      ''
    ].join('\n'), 'utf8');
    try {
      const uri = vscode.Uri.file(probePath);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const deadline = Date.now() + DIAG_MS;
      let hit: vscode.Diagnostic | undefined;
      while (Date.now() < deadline) {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        hit = diagnostics.find(diagnostic =>
          String(diagnostic.code ?? '').includes('create-params') ||
          diagnostic.message.includes('noSuchParam026'));
        if (hit) { break; }
        await sleep(SLEEP_MS);
      }
      assert.ok(hit, `expected a create-params diagnostic on the probe file, got: ${JSON.stringify(vscode.languages.getDiagnostics(uri).map(d => ({ code: String(d.code ?? ''), message: d.message.slice(0, 120) })))}`);
      evidence('create-params', { code: String(hit.code ?? ''), severity: hit.severity, message: hit.message, range: `${hit.range.start.line + 1}` });
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(probePath, { force: true });
    }
  });

  it('face 11: entities.xml audit reports the trimmed registry honestly', async function () {
    // Route proof: the real command runs headless (OutputChannel report).
    await vscode.commands.executeCommand('kbengine.entities.checkRegistration');
    // Same production functions the command feeds, so the findings are
    // captured (an OutputChannel cannot be read back through the API).
    const workspaceRoot = DEMO_ROOT!;
    const layout = getDefinitionWorkspaceLayout(workspaceRoot);
    assert.ok(layout.entitiesXmlPath && fs.existsSync(layout.entitiesXmlPath), 'entities.xml missing from the demo workspace');
    const entitiesXmlText = fs.readFileSync(layout.entitiesXmlPath!, 'utf8');
    const defNames = layout.entityDefsRoot && fs.existsSync(layout.entityDefsRoot)
      ? fs.readdirSync(layout.entityDefsRoot).filter(name => name.endsWith('.def')).map(name => name.slice(0, -4))
      : [];
    const faceScriptNames = (face: 'base' | 'cell'): Set<string> => {
      const names = new Set<string>();
      const directory = layout.entityScriptsRoot ? path.join(layout.entityScriptsRoot, face) : null;
      if (!directory || !fs.existsSync(directory)) { return names; }
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith('.py') || entry.name.endsWith('.pyc'))) {
          names.add(entry.name.replace(/\.(py|pyc)$/, ''));
        }
      }
      return names;
    };
    const findings = auditEntitiesRegistration({
      entitiesXmlText,
      defNames,
      baseScriptNames: faceScriptNames('base'),
      cellScriptNames: faceScriptNames('cell')
    });
    const withoutDef = findings.filter(finding => finding.check === 'entry-without-def');
    const withoutEntry = findings.filter(finding => finding.check === 'def-without-entry');
    const missingFace = findings.filter(finding => finding.check === 'face-script-missing');
    assert.strictEqual(withoutDef.length, 0, `every registry entry must have a def, got: ${JSON.stringify(withoutDef)}`);
    assert.ok(withoutEntry.some(finding => finding.entity === 'Pet'), 'Pet.def must be reported as not in the registry (trimmed entities.xml)');
    assert.ok(!missingFace.some(finding => finding.entity === 'Avatar'), 'Avatar faces must not be reported missing');
    evidence('entities-audit', {
      rendered: renderEntitiesRegistrationAudit(findings, collectAuditStats({
        entitiesXmlText, defNames,
        baseScriptNames: faceScriptNames('base'),
        cellScriptNames: faceScriptNames('cell')
      }), 'en'),
      stats: collectAuditStats({ entitiesXmlText, defNames, baseScriptNames: faceScriptNames('base'), cellScriptNames: faceScriptNames('cell') }),
      withoutEntryEntities: withoutEntry.map(finding => finding.entity)
    });
  });
});
