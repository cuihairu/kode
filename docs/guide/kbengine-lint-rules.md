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
