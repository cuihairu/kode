# Log Viewer


Kode ships a log viewer WebView for the KBEngine logger, to view, filter, and export logs.

The logger protocol adaptation is not finished yet. The extension clearly states this capability is not supported yet, so an unverified protocol implementation is never presented as a working one.

## Overview

- Connect to the logger port
- View connection status and limitation notes
- Level filtering
- Component filtering
- Keyword search
- Regular expression search
- Log export
- Raw log ERROR scan (offline, no logger connection needed)

## Related Commands

- `kbengine.logs.showViewer`
- `kbengine.logs.connect`
- `kbengine.logs.disconnect`
- `kbengine.logs.clear`
- `kbengine.logs.export`
- `kbengine.logs.scanErrors`

See [Commands and Panels](./commands.md) for command details.

## Related Configuration

### `kbengine.loggerPort`

The logger connection port, default `20022`.

### `kbengine.logAutoConnect`

Whether to auto-connect to the log port when starting the server.

### `kbengine.maxLogEntries`

The maximum number of cached entries in the log WebView.

If you notice:

- The panel getting sluggish
- Clearly delayed scrolling
- Memory growing over long runs

lower this value first.

## Jump Decision-Path Log

When an F12 jump finds nothing, the extension can print the whole decision path — how many layers were checked, which one hit or missed, why it gave up, and how long each step took — to an output channel, so you can see exactly which layer broke and paste the captured output to the maintainer.

### Switch

- Setting key: `kbengine.jumpLog`
- Type: boolean, values `true` / `false`, default `false` (off)
- Zero overhead when off: log messages are passed lazily (`() =>`), and the switch is checked before any string is built — with the switch off there is no string construction and no output at all
- This is an editor-behavior setting and deliberately **not** part of `.kbengine/debug.json` — that file holds debug launch actions (commands/scripts/cwd). The log switch lives in the VS Code settings system, so toggling takes effect immediately without editing files or reloading the window

Enable either way.

**Way 1: VS Code Settings UI (search term `jumpLog`)**

1. Open Settings with `Ctrl+,`;
2. Type `jumpLog` and find **Kbengine: Jump Log** (the item described as the jump decision-path logging switch);
3. Tick it — the next F12 is logged.

**Way 2: settings.json snippet**

In your user or workspace `.vscode/settings.json`:

```json
{
  "kbengine.jumpLog": true
}
```

### Where The Logs Go

1. Open the Output panel: `Ctrl+Shift+U` (View → Output);
2. Pick the **KBEngine Navigation** channel from the dropdown at the top right;
3. Type the filter `[kode-jump]` in the filter box.

Disable: set the setting back to `false` (or remove the key) — logging stops on the next jump, no reload needed.

### A Real Failed-Jump Log Sample

Source: `self.func(*(self.args + args))` at `scripts/common/Functor.py:20` in a real KBEngine project, pressed F12.

```text
[kode-jump][info] F12 .../scripts/common/Functor.py:20:11 line="self.func(*(self.args + args))"
[kode-jump][info] resolve start query=func file=Functor.py:20 class=Functor
[kode-jump][info] def full index done: 1 .def → 1 entity, 10ms
[kode-jump][debug] def index[object-level] Functor → miss (negative cache)
[kode-jump][debug] def index[file-level] Functor.py → miss (no owner)
[kode-jump][info] layer1 entity-def missed (property(func) object=Functor miss; property(func) file=Functor.py miss; method object=Functor miss; method file=Functor.py miss) 7ms
[kode-jump][info] py query Functor.py:20 method=func
[kode-jump][info] py full-repo index done: 12 files → 3 classes, 3ms (cached per session)
[kode-jump][debug] py (1) static-class MRO missed (enclosing=Functor)
[kode-jump][info] composition roots derived: 1 root: [Account] 6ms
[kode-jump][debug] py roots containing Functor → [none]
[kode-jump][info] py missed: none of static class / composition roots / reverse descendants has func (9ms)
[kode-jump][info] layer2 python-mro missed (no provider in mro/composition-roots/descendants) 9ms
[kode-jump][info] layer3 file-scope missed (class Functor (of 1 classes in file) does not define func) 0ms
[kode-jump][info] jump gave up: all three layers missed (query=func) total 17ms
```

Line by line:

- `F12 …`: entry — file, line:column, and the text of the cursor line;
- `resolve start … class=Functor`: the symbol being resolved (query) and the class `self` sits in;
- `def full index done …`: cost of building the `.def` index layer 1 needs (cached per session, built once);
- `def index[object-level]/[file-level] …`: layer 1's two probes — take the `.def` by class name, then by file ownership; both missed;
- `layer1 entity-def missed (…)`: layer 1 finished; the parentheses carry each probe's miss reason;
- `py query …` and `py full-repo index done …`: layer 2 starts; the latter is the main source of "takes ages to load" (one-time full `.py` scan, then cached);
- `py (1) static-class MRO missed`: layer 2 step 1 — `func` is not in the static class's own inheritance chain;
- `composition roots derived …` and `py roots containing … [none]`: layer 2 step 2 — which composition roots (entities.xml × `.def` × Python inheritance) contain this class; `Functor` belongs to none;
- `layer2 python-mro missed (…)`: layer 2 step 3 — neither MRO, composition roots, nor reverse descendants has `func`;
- `layer3 file-scope missed (…)`: last layer — the current file's class scope and file-local MRO don't define it either;
- `jump gave up: all three layers missed … total …`: the give-up point — null is returned only after all three layers miss. This failure is expected: `func` is an attribute assigned in `__init__`, not a method of any class.

When a jump hits, the winning layer prints `layerN … hit → file:line` and the jump lands there. Pasting this panel excerpt to the maintainer pinpoints the failing layer immediately.


## Typical Flows

### Day-to-Day Viewing

1. Start the KBEngine components
2. Run `Show Log Viewer`
3. Connect to the logger
4. Filter by level and component to inspect problems

### Investigating Problems

1. Open the log panel
2. Locate entity names, component names, or error fragments by keyword
3. Enable regex search when needed
4. Export the logs for further analysis

## Export

Logs can be exported as:

- `txt`
- `log`
- `json`

Good for:

- Preserving the scene of a problem
- Handing to colleagues for investigation
- Offline analysis with scripts

## Raw Log ERROR Scan

`kbengine.logs.scanErrors` scans raw log files on disk offline, without a logger port connection. After running it, pick files or folders (folders scan one level of `.log`/`.txt`/`.out`, sorted by filename); the extension aggregates `ERROR`/`CRITICAL` lines by "component + normalized signature" and shows them in the WebView panel.

- Normalized signature: digit runs folded into `N`, whitespace compressed, truncated to 160 characters, so the same error with different ids/counters does not split into multiple rows
- Aggregate table: count (descending) / level / component / signature / most recent occurrence; time is taken only from timestamps carried in the line, non-standard lines show `—`
- Clicking a hit row opens the source file and locates the earliest line of that signature
- The "Rescan" button re-runs on the previous batch of files without re-popping the dialog
- A single file over the 64MB read limit, or a read failure, is flagged with its failure reason in the scanned-file list without interrupting the rest
- A summary row gives file count, total lines, total ERROR/CRITICAL entries, and the number of distinct signatures

The scan uses the same parser family as the log panel (logger line format / standard format / non-standard heuristic), so non-standard lines containing `error`/`failed` wording are also counted.

## Usage Advice

### Team Collaboration

Unify the logger port configuration, so "the extension opens but logs won't connect" doesn't happen across people's environments.

### Heavy Log Environments

Recommended:

- Lower `kbengine.maxLogEntries`
- Filter by component first
- Then layer keyword search on top

## Current Boundaries

The current log capability leans "interface and export layer"; it is not a stable collector with the official logger protocol adaptation completed.

Deliberately not done:

- Saving filter presets
- Multi-session comparison
- Automatic clustering by entity semantics
