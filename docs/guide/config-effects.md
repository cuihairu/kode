# Config switch effects

Every extension setting with a visible effect, captured before/after by the automated screenshot pipeline (`scripts/config-switch-gifs/`): Xvfb + real VS Code + the packaged extension, switch off → screenshot, switch on → screenshot, ffmpeg-stitched animation. The pipeline is rerunnable and doubles as a regression test — a switch whose effect breaks produces identical frames and fails the run. Switches without a static visual face are listed for manual verification at the end.

Regenerate this page: `python3 scripts/config-switch-gifs/render_docs.py`

> This page is generated from `switches.json` + `manifest.json`; do not edit by hand.

## Diagnostics

### Real-time syntax diagnostics (`kbengine.enableDiagnostics`)

With it off, .def files are no longer checked live: red squiggles and Problems panel entries disappear

| Off | On |
| --- | --- |
| ![Real-time syntax diagnostics off](/config-switch-gifs/enable-diagnostics-off.png) | ![Real-time syntax diagnostics on](/config-switch-gifs/enable-diagnostics-on.png) |

*Animation:* ![Real-time syntax diagnostics](/config-switch-gifs/enable-diagnostics.gif)

### Duplicate definition check (`kbengine.diagnostics.checkDuplicateDefinitions`)

When on, a property/method declared twice in the same .def is flagged as a duplicate-definition Warning

| Off | On |
| --- | --- |
| ![Duplicate definition check off](/config-switch-gifs/check-duplicate-definitions-off.png) | ![Duplicate definition check on](/config-switch-gifs/check-duplicate-definitions-on.png) |

*Animation:* ![Duplicate definition check](/config-switch-gifs/check-duplicate-definitions.gif)

### .def structure validation (`kbengine.enableStructureDiagnostics`)

Structural issues (duplicates, misplaced tags, missing fields) are flagged

| Off | On |
| --- | --- |
| ![.def structure validation off](/config-switch-gifs/enable-structure-diagnostics-off.png) | ![.def structure validation on](/config-switch-gifs/enable-structure-diagnostics-on.png) |

*Animation:* ![.def structure validation](/config-switch-gifs/enable-structure-diagnostics.gif)

## Hover

### Hover tag docs (`kbengine.hover.showTagDocs`)

Hovering a .def tag such as &lt;Flags&gt;/&lt;Type&gt; pops a card explaining what the tag means

| Off | On |
| --- | --- |
| ![Hover tag docs off](/config-switch-gifs/hover-show-tag-docs-off.png) | ![Hover tag docs on](/config-switch-gifs/hover-show-tag-docs-on.png) |

*Animation:* ![Hover tag docs](/config-switch-gifs/hover-show-tag-docs.gif)

### Hover value docs (`kbengine.hover.showValueDocs`)

Hovering a value like BASE_AND_CLIENT pops a card explaining where that flag propagates

| Off | On |
| --- | --- |
| ![Hover value docs off](/config-switch-gifs/hover-show-value-docs-off.png) | ![Hover value docs on](/config-switch-gifs/hover-show-value-docs-on.png) |

*Animation:* ![Hover value docs](/config-switch-gifs/hover-show-value-docs.gif)

### Hover Implemented-By (`kbengine.hover.implementedBy`)

Hovering a def method shows where the script implements it (Implemented-By backlink, file:line)

| Off | On |
| --- | --- |
| ![Hover Implemented-By off](/config-switch-gifs/hover-implemented-by-off.png) | ![Hover Implemented-By on](/config-switch-gifs/hover-implemented-by-on.png) |

*Animation:* ![Hover Implemented-By](/config-switch-gifs/hover-implemented-by.gif)

## CodeLens

### RPC method CodeLens (`kbengine.codeLens.rpc`)

An RPC marker CodeLens appears above the implementing method of a def-declared RPC in entity scripts

| Off | On |
| --- | --- |
| ![RPC method CodeLens off](/config-switch-gifs/codelens-rpc-off.png) | ![RPC method CodeLens on](/config-switch-gifs/codelens-rpc-on.png) |

*Animation:* ![RPC method CodeLens](/config-switch-gifs/codelens-rpc.gif)

### types.xml storage mirror CodeLens (`kbengine.codeLens.typesXml`)

A storage-mirror CodeLens (reference back-scan) appears above type declarations in types.xml

| Off | On |
| --- | --- |
| ![types.xml storage mirror CodeLens off](/config-switch-gifs/codelens-types-xml-off.png) | ![types.xml storage mirror CodeLens on](/config-switch-gifs/codelens-types-xml-on.png) |

*Animation:* ![types.xml storage mirror CodeLens](/config-switch-gifs/codelens-types-xml.gif)

### Event callback CodeLens (`kbengine.codeLens.eventCallbacks`)

An event-callback marker appears above event handler functions in Python scripts

| Off | On |
| --- | --- |
| ![Event callback CodeLens off](/config-switch-gifs/codelens-event-callbacks-off.png) | ![Event callback CodeLens on](/config-switch-gifs/codelens-event-callbacks-on.png) |

*Animation:* ![Event callback CodeLens](/config-switch-gifs/codelens-event-callbacks.gif)

### Property marker CodeLens (`kbengine.codeLens.property`)

A property marker CodeLens appears above self.&lt;property&gt; accesses

| Off | On |
| --- | --- |
| ![Property marker CodeLens off](/config-switch-gifs/codelens-property-off.png) | ![Property marker CodeLens on](/config-switch-gifs/codelens-property-on.png) |

*Animation:* ![Property marker CodeLens](/config-switch-gifs/codelens-property.gif)

## Inlay hints

### Property type inlay hints (`kbengine.inlayHints.typeData`)

Inline `: <type>` hints at self.&lt;property&gt; accesses, from the def/types.xml declaration

| Off | On |
| --- | --- |
| ![Property type inlay hints off](/config-switch-gifs/inlay-type-data-off.png) | ![Property type inlay hints on](/config-switch-gifs/inlay-type-data-on.png) |

*Animation:* ![Property type inlay hints](/config-switch-gifs/inlay-type-data.gif)

### def parameter inlay hints (`kbengine.inlayHints.defParams`)

Unannotated parameters of methods declared in def script sections get inline type hints

| Off | On |
| --- | --- |
| ![def parameter inlay hints off](/config-switch-gifs/inlay-def-params-off.png) | ![def parameter inlay hints on](/config-switch-gifs/inlay-def-params-on.png) |

*Animation:* ![def parameter inlay hints](/config-switch-gifs/inlay-def-params.gif)

### Builtin property inlay hints (`kbengine.python.builtinTypeInlayHints`)

Inline `: <type>` hints after self.&lt;builtin property&gt; accesses such as self.id

| Off | On |
| --- | --- |
| ![Builtin property inlay hints off](/config-switch-gifs/builtin-type-inlay-hints-off.png) | ![Builtin property inlay hints on](/config-switch-gifs/builtin-type-inlay-hints-on.png) |

*Animation:* ![Builtin property inlay hints](/config-switch-gifs/builtin-type-inlay-hints.gif)

## Panels

### Call chain panel initial view (`kbengine.python.callChainView`)

The Show Call Chain panel opens as a mermaid graph (graph) or as plain text (text)

| text | graph |
| --- | --- |
| ![Call chain panel initial view off](/config-switch-gifs/call-chain-view-text.png) | ![Call chain panel initial view on](/config-switch-gifs/call-chain-view-graph.png) |

*Animation:* ![Call chain panel initial view](/config-switch-gifs/call-chain-view.gif)

### Auto-open final config on activation (`kbengine.showFinalConfigOnOpen`)

On, the merged final-config view opens in a background preview tab at activation (path derived from binPath; silently skipped if not found); off, it does not open

| Off | On |
| --- | --- |
| ![Auto-open final config on activation off](/config-switch-gifs/show-final-config-on-open-off.png) | ![Auto-open final config on activation on](/config-switch-gifs/show-final-config-on-open-on.png) |

*Animation:* ![Auto-open final config on activation](/config-switch-gifs/show-final-config-on-open.gif)

### Call chain entry hints (`kbengine.python.callChainHints`)

A Call Chain hint shows at method entries; off also disables Show Call Chain previews

| Off | On |
| --- | --- |
| ![Call chain entry hints off](/config-switch-gifs/python-call-chain-hints-off.png) | ![Call chain entry hints on](/config-switch-gifs/python-call-chain-hints-on.png) |

*Animation:* ![Call chain entry hints](/config-switch-gifs/python-call-chain-hints.gif)

## Manual verification list

These switches have no single static screenshot face: the effect is behavioral (writes files, wires tooling, gates actions inside panels) or only visible mid-interaction. Verify them by following the effect description; the screenshots above deliberately exclude them.

| Setting | Effect |
| --- | --- |
| `kbengine.runtimeQuery.enabled` | Off, the panel opens but stream toggles report "stream disabled"; on, stream toggles work |
| `kbengine.hover.showSymbolDocs` | Hovering a custom property/method name shows its summary |
| `kbengine.hover.typeStorage` | Hovering a custom type in types.xml shows its storage table/column/type info |
| `kbengine.hover.eventStats` | Hovering an event constant shows registration/listener stats |
| `kbengine.hover.serverConfig` | Hovering a kbengine.xml entry shows its resolved value and docs |
| `kbengine.hover.startupScript` | Hovering KBEngine startup args/env vars in .sh/.bat scripts shows their docs |
| `kbengine.hover.returnTypeInference` | Hovering a local variable infers its type from function annotations |
| `kbengine.hover.entityRegistration` | Hovering an entity class shows its entities.xml registration (Utype/index position) |
| `kbengine.hover.defChain` | Hovering a def property/method shows its declaration chain (file and section origin) |
| `kbengine.autoRefreshFinalConfig` | The final-config view recomputes itself when the engine config files change |
| `kbengine.generator.generatePython` | Whether the entity generation wizard also writes the Python entity file |
| `kbengine.generator.registerInEntitiesXml` | Whether generated entities are auto-registered in entities.xml |
| `kbengine.entity.methodStubBody` | Generated implementation skeletons get a pass body or raise NotImplementedError |
| `kbengine.jsoncAssociation` | On activation writes a files.association mapping debug.json to jsonc into workspace settings |
| `kbengine.python.extraPathsSync` | Writes the KBEngine scripts root into python.analysis.extraPaths |
| `kbengine.webviewConsoleLogs` | Webview console errors are captured into the log panel (internal behavior) |
