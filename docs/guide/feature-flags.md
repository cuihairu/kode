# Feature Flags: Before/After Evidence

Every `kbengine.*` switch changes real UI behavior. This page pairs each switch with a **real before/after capture**: the pipeline boots a genuine VS Code instance (extension installed from the packaged VSIX) inside Xvfb against a KBEngine demo workspace, flips the one switch in workspace settings, restarts the extension host per state, poses the affected surface (editor / hover / command panel), and stitches the two real screenshots into an animated GIF with ffmpeg.

The whole thing is scripted and rerunnable — no hand-drawn mock-ups:

```bash
python3 scripts/config-switch-gifs/generate.py --list           # switch inventory
python3 scripts/config-switch-gifs/generate.py --all            # capture every GIF-able switch
python3 scripts/config-switch-gifs/generate.py --switch inlay-type-data
```

Prerequisites: `Xvfb`, `xdotool`, ImageMagick `import`, `ffmpeg`, VS Code CLI, and a packaged VSIX (see `scripts/config-switch-gifs/generate.py`). Capture runs against a throwaway `/tmp` workspace — the repo only gains PNG/GIF files under `docs/public/config-switch-gifs/` plus a `manifest.json`.

## Diagnostics

### Real-time syntax diagnostics — `kbengine.enableDiagnostics`

Off: `.def` files are no longer checked live — red squiggles and Problems panel entries disappear.

![enable-diagnostics](/config-switch-gifs/enable-diagnostics.gif) ([off](/config-switch-gifs/enable-diagnostics-off.png) / [on](/config-switch-gifs/enable-diagnostics-on.png))

### Duplicate definition check — `kbengine.diagnostics.checkDuplicateDefinitions`

On: a property declared twice in the same `.def` is flagged as a duplicate-definition Warning.

![check-duplicate-definitions](/config-switch-gifs/check-duplicate-definitions.gif) ([off](/config-switch-gifs/check-duplicate-definitions-off.png) / [on](/config-switch-gifs/check-duplicate-definitions-on.png))

## Hover

### Hover tag docs — `kbengine.hover.showTagDocs`

On: hovering a `.def` tag such as `<Flags>`/`<Type>` pops a card explaining what the tag means.

![hover-show-tag-docs](/config-switch-gifs/hover-show-tag-docs.gif) ([off](/config-switch-gifs/hover-show-tag-docs-off.png) / [on](/config-switch-gifs/hover-show-tag-docs-on.png))

### Hover value docs — `kbengine.hover.showValueDocs`

On: hovering a value like `BASE_AND_CLIENT` pops a card explaining where that flag propagates.

![hover-show-value-docs](/config-switch-gifs/hover-show-value-docs.gif) ([off](/config-switch-gifs/hover-show-value-docs-off.png) / [on](/config-switch-gifs/hover-show-value-docs-on.png))

### Hover Implemented-By — `kbengine.hover.implementedBy`

On: hovering a def method shows where the script implements it (Implemented-By backlink, file:line).

![hover-implemented-by](/config-switch-gifs/hover-implemented-by.gif) ([off](/config-switch-gifs/hover-implemented-by-off.png) / [on](/config-switch-gifs/hover-implemented-by-on.png))

## CodeLens

### RPC method CodeLens — `kbengine.codeLens.rpc`

On: an RPC marker CodeLens appears above the implementing method of a def-declared RPC in entity scripts.

![codelens-rpc](/config-switch-gifs/codelens-rpc.gif) ([off](/config-switch-gifs/codelens-rpc-off.png) / [on](/config-switch-gifs/codelens-rpc-on.png))

### types.xml storage mirror CodeLens — `kbengine.codeLens.typesXml`

On: a storage-mirror CodeLens (reference back-scan) appears above type declarations in types.xml.

![codelens-types-xml](/config-switch-gifs/codelens-types-xml.gif) ([off](/config-switch-gifs/codelens-types-xml-off.png) / [on](/config-switch-gifs/codelens-types-xml-on.png))

## Inlay hints

### Property type inlay hints — `kbengine.inlayHints.typeData`

On: inline `: <type>` hints at `self.<property>` accesses, from the def/types.xml declaration.

![inlay-type-data](/config-switch-gifs/inlay-type-data.gif) ([off](/config-switch-gifs/inlay-type-data-off.png) / [on](/config-switch-gifs/inlay-type-data-on.png))

### def parameter inlay hints — `kbengine.inlayHints.defParams`

On: unannotated parameters of methods declared in def script sections get inline type hints.

![inlay-def-params](/config-switch-gifs/inlay-def-params.gif) ([off](/config-switch-gifs/inlay-def-params-off.png) / [on](/config-switch-gifs/inlay-def-params-on.png))

## Hot reload

### Hot reload master switch — `kbengine.hotReload.enabled`

Off: the hot-reload status-bar item reads 未开启: kbengine.hotReload.enabled=false (watch-off icon); on (with globs set) it goes ready — saving a `.py` fires the default hot-reload request. Watch the bottom status bar.

![hot-reload-enabled](/config-switch-gifs/hot-reload-enabled.gif) ([off](/config-switch-gifs/hot-reload-enabled-off.png) / [on](/config-switch-gifs/hot-reload-enabled-on.png))

## Panels

### Call chain panel initial view — `kbengine.python.callChainView`

`text` → `graph`: the Show Call Chain panel opens as a mermaid graph or as plain text.

![call-chain-view](/config-switch-gifs/call-chain-view.gif) ([text](/config-switch-gifs/call-chain-view-text.png) / [graph](/config-switch-gifs/call-chain-view-graph.png))

## Captured switch summary

| Setting | Switch | States | Effect |
| --- | --- | --- | --- |
| `kbengine.enableDiagnostics` | Real-time syntax diagnostics | `false` → `true` | With it off, .def files are no longer checked live: red squiggles and Problems panel entries disappear |
| `kbengine.diagnostics.checkDuplicateDefinitions` | Duplicate definition check | `false` → `true` | When on, a property/method declared twice in the same .def is flagged as a duplicate-definition Warning |
| `kbengine.hover.showTagDocs` | Hover tag docs | `false` → `true` | Hovering a .def tag such as `<Flags>`/`<Type>` pops a card explaining what the tag means |
| `kbengine.hover.showValueDocs` | Hover value docs | `false` → `true` | Hovering a value like `BASE_AND_CLIENT` pops a card explaining where that flag propagates |
| `kbengine.hover.implementedBy` | Hover Implemented-By | `false` → `true` | Hovering a def method shows where the script implements it (Implemented-By backlink, file:line) |
| `kbengine.codeLens.rpc` | RPC method CodeLens | `false` → `true` | An RPC marker CodeLens appears above the implementing method of a def-declared RPC in entity scripts |
| `kbengine.codeLens.typesXml` | types.xml storage mirror CodeLens | `false` → `true` | A storage-mirror CodeLens (reference back-scan) appears above type declarations in types.xml |
| `kbengine.inlayHints.typeData` | Property type inlay hints | `false` → `true` | Inline `: <type>` hints at `self.<property>` accesses, from the def/types.xml declaration |
| `kbengine.inlayHints.defParams` | def parameter inlay hints | `false` → `true` | Unannotated parameters of methods declared in def script sections get inline type hints |
| `kbengine.hotReload.enabled` | Hot reload master switch | `false` → `true` | Off, the hot-reload status-bar item reads 未开启 (watch-off); on (with globs set) it goes ready — saving a `.py` fires the default hot-reload request |
| `kbengine.python.callChainView` | Call chain panel initial view | `text` → `graph` | The Show Call Chain panel opens as a mermaid graph (graph) or as plain text (text) |

## Manual-capture switches

These switches are real but their effect does not present as a headless-capturable UI state (needs a wizard drive, a file edit mid-capture, or lands as a settings-file diff rather than pixels). They are documented here; the pipeline marks them `capture: false` in `scripts/config-switch-gifs/switches.json` so reruns skip them honestly.

| Setting | Switch | States | Effect |
| --- | --- | --- | --- |
| `kbengine.hover.showSymbolDocs` | Hover symbol docs | `false` → `true` | Hovering a custom property/method name shows its summary |
| `kbengine.hover.typeStorage` | Hover type storage | `false` → `true` | Hovering a custom type in types.xml shows its storage table/column/type info |
| `kbengine.hover.eventStats` | Hover event stats | `false` → `true` | Hovering an event constant shows registration/listener stats |
| `kbengine.hover.serverConfig` | Hover server config | `false` → `true` | Hovering a kbengine.xml entry shows its resolved value and docs |
| `kbengine.hover.startupScript` | Hover startup args | `false` → `true` | Hovering KBEngine startup args/env vars in .sh/.bat scripts shows their docs |
| `kbengine.hover.returnTypeInference` | Hover return-type inference | `false` → `true` | Hovering a local variable infers its type from function annotations |
| `kbengine.hover.entityRegistration` | Hover entity registration | `false` → `true` | Hovering an entity class shows its entities.xml registration (Utype/index position) |
| `kbengine.hover.defChain` | Hover def chain | `false` → `true` | Hovering a def property/method shows its declaration chain (file and section origin) |
| `kbengine.codeLens.eventCallbacks` | Event callback CodeLens | `false` → `true` | An event-callback marker appears above event handler functions in Python scripts |
| `kbengine.codeLens.property` | Property marker CodeLens | `false` → `true` | A property marker CodeLens appears above `self.<property>` accesses |
| `kbengine.python.builtinTypeInlayHints` | Builtin property inlay hints | `false` → `true` | Inline `: <type>` hints after `self.<builtin property>` accesses such as `self.id` |
| `kbengine.enableStructureDiagnostics` | .def structure validation | `false` → `true` | Structural issues (duplicates, misplaced tags, missing fields) are flagged |
| `kbengine.autoRefreshFinalConfig` | Final config auto-refresh | `false` → `true` | The final-config view recomputes itself when the engine config files change |
| `kbengine.generator.generatePython` | Generator: Python files | `false` → `true` | Whether the entity generation wizard also writes the Python entity file |
| `kbengine.generator.registerInEntitiesXml` | Generator: entities.xml registration | `false` → `true` | Whether generated entities are auto-registered in entities.xml |
| `kbengine.entity.methodStubBody` | Method stub body | `pass` → `raise` | Generated implementation skeletons get a `pass` body or `raise NotImplementedError` |
| `kbengine.python.callChainHints` | Call chain entry hints | `false` → `true` | A Call Chain hint shows at method entries; off also disables Show Call Chain previews |
| `kbengine.jsoncAssociation` | debug.json jsonc association | `false` → `true` | On activation writes a files.association mapping debug.json to jsonc into workspace settings |
| `kbengine.python.extraPathsSync` | extraPaths auto-sync | `false` → `true` | Writes the KBEngine scripts root into python.analysis.extraPaths |
| `kbengine.webviewConsoleLogs` | Webview console capture | `false` → `true` | Webview console errors are captured into the log panel (internal behavior) |
| `kbengine.hotReload.tempEdit.enabled` | Hot reload temp edit | `false` → `true` | On, the one-shot hot-reload flow takes the temp-edit → reloadScript → auto-restore path (default off, accident guard) |
| `kbengine.debug.debugpyInject` | debugpy injection | `false` → `true` | On, a debug session injects debugpy into the target process and reports on the debug status board; off, no injection |
| `kbengine.debug.autoDebugpy` | Auto debugpy | `false` → `true` | On, debug startup auto-discovers/launches a debugpy listener and waits for attachment (default off) |
| `kbengine.python.stubSourceMode` | Stub source mode | `generated` → `real-source` | Exported .pyi stubs come from the generator (generated) or reference real source (real-source); the diff lands in stub file content |
| `kbengine.runtimeQuery.enabled` | Runtime Queries panel | `false` → `true` | The panel always opens; off, in-panel queries/streaming error with "enable kbengine.runtimeQuery.enabled"; on, queries work |
| `kbengine.showFinalConfigOnOpen` | Auto-open final config view | `false` → `true` | On, opening the engine defaults file tries to auto-open the final-config view beside it (needs a runnable engine bin for the computation; without an engine the auto-open does not trigger) |
