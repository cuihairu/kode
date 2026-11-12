# KBEngine Coding Pitfalls and Lint Rules

Kode distinguishes engine constraints, explanatory editor hints, and implemented lint diagnostics. A type appearing in hover or inlay hints does not mean a corresponding misuse check exists.

The [detailed rule catalog](../zh/guide/kbengine-lint-rules.md) records the source symbols, examples, implementation status, and known analysis limits. The source review used Kode `bf26cbf` and KBEngine `f85ad81`; the `hasattr` correction is in Kode `c351606`.

| Area | Implemented behavior | Limits |
| --- | --- | --- |
| Optional EntityCall receivers | `kbengine.receiverNone` reports unguarded `self.cell/base/client` member uses as Warnings | Guard analysis is heuristic; aliases, nested exits, compound conditions and lexical filtering still have gaps |
| Attribute existence | `hasattr(self, "cell")` no longer suppresses the None warning | The getter may exist while returning None; check the returned value |
| RPC routing | `kbengine.sectionMismatch` compares known declarations with receiver sections | Unknown declarations cannot establish a mismatch; adding a None guard does not fix routing |
| `.def` structure and scalar values | Type, Flags, DetailLevel, duplicates and required fields have checks | On-demand analysis suggestions are separate from diagnostics on edit |
| Readonly attributes and role restrictions | `kbengine.readOnlyWrite` reports writes to engine readonly properties; `kbengine.roleMisuse` reports `self.<property>` uses whose registered face set (baseapp/cellapp/client) does not include the current script's face, citing the registering face's engine source | Assignment checks and property wrong-role checks are implemented; wrong-role *API* (method) checks remain hint-only until a role table for methods exists |
| RPC argument misuse and lifecycle hazards | `kbengine.rpcArgCount` reports a call-site argument count that definitely mismatches the `.def` method's `<Arg>` count for the routed section (star-args, dynamic receivers, out-of-section declarations and declaration-not-ready stay unknown); `kbengine.postDestroy` reports a `self.<member>` access (excluding identity/state items and `destroy`) that a determinable same-block `self.destroy()` precedes within one function | Argument *type* checks remain planned; post-destroy covers only the determinable same-function same-block core (conditional destroys, cross-callback/cross-block flows, exceptions and def-declared `destroy` are never guessed) |
| cellData known-field writes | `kbengine.cellDataWriteType` validates a whole-line literal assignment to a known `self.cellData["<key>"]` field against the declared engine scalar structure and range (datatypes.cpp registry) and reports the actual/expected types with the declaration source | Unknown keys, non-scalar types (PYTHON family/ARRAY/FIXED_DICT/custom aliases), non-literal or cross-line right-hand sides and unknown-element vector components stay unreported; alias receivers follow the latest-assignment rule and are skipped after rebinding |
| Behavior-knowledge pipeline (KB-001) | `kbengine.fixedDictNestedMutation` reports FIXED_DICT property sub-key assignment (Warning + whole-reassign quick fix); `kbengine.destroyedEntityReference` reports `self` stored into a module-level container (Warning); `kbengine.timerCleanupOnDestroy` reports redundant `delTimer` inside `onDestroy` (Information — `destroy()` already cancels all timers) | The three rules publish to the dedicated `kbengine-trap-lints` collection with per-rule toggles; only statically determinable single-line patterns are analyzed — closure escape, cross-block flows and multi-line statements are never guessed |

## EntityCall values can be None

KBEngine registers EntityCall getters as attributes. The getter can return None when the peer is absent, including before creation or after losing the peer. Therefore attribute existence is insufficient:

```python
if hasattr(self, "cell"):
    self.cell.send()  # Still warns: the getter can return None.
```

Check the value instead:

```python
if self.cell is not None:
    self.cell.send()
```

This checks local None risk; it does not guarantee remote delivery or execution.

Python receiver checks are enabled by `kbengine.receiverNoneDiagnostics`. The existing document scheduler publishes results to Problems. Disabling the setting suppresses diagnostics without changing engine behavior. New rules must share versioned parsing, avoid executing user Python, support cancellation and large-file yielding, and include both unsafe and legal examples before being marked complete.
