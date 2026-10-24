# `.pyi` precedence experiment

Date: 2026-10-22  
Checker: pyright 1.1.414  
Fixture: one `runtime_mod.py` declares `RUNTIME_ONLY`, `py_only`, `STUB_ONLY`, and `stub_only`; a consumer imports the module and accesses all four.

## Observed results

| Case | `STUB_ONLY` | `RUNTIME_ONLY` | `py_only` | `stub_only` |
| --- | --- | --- | --- | --- |
| Stub present | `int` | `Unknown`, attribute error | attribute error | resolved |
| Stub missing | `Unknown`, attribute error | `Literal['runtime']` | resolved | attribute error |
| Stub in `stubPath` directory | `int` | `Unknown`, attribute error | attribute error | resolved |

In every case where the stub was visible, pyright used the `.pyi` surface and hid runtime-only members from static analysis. Removing the stub restored runtime symbol visibility but hid stub-only declarations. The `stubPath` case behaved like the side-by-side case.

## Conclusion

The experiment confirms that a generated `.pyi` can shadow runtime `.py` symbols. Automatic full-`.py` generation therefore remains risky and the default should stay off until the intended generation boundary is settled. This was a pyright-only observation; Pylance, Cursor, and PyCharm still need separate verification before changing the default.

## Switch recommendation (awaiting user ratification)

Current state on `main` is listed so the ratification reads as a diff, not a design exercise.

| # | Knob | Default on `main` | Shadow exposure | Recommendation |
| --- | --- | --- | --- | --- |
| A | `kbengine.python.stubExport` — auto-export `KBEngine.pyi` into the managed stub root | `true` | none: `KBEngine` is an installed engine module with no local runtime file, so nothing can be shadowed | keep enabled |
| B | `kbengine.python.entityStubMethods` — emit `entity_types.pyi` / `kbe_types.pyi` into the managed typings root | `true` | none while the artifact names differ from user module names; the only reachable form is the migration-era single-file `kbe_types.py` if `stubDir` is pointed at the project scripts tree | keep enabled, keep artifacts in the managed root only |
| C | whole-tree generated `.py` next to user modules (T-04 "auto full-`.py`") | not implemented | full shadowing: runtime-only members vanish from static analysis (table row 1) | keep off; if ever implemented, gate it behind an explicit opt-in setting that defaults to off |

Decisions asked of the user:

1. Ratify keeping A and B at their current defaults (no change).
2. Ratify the documented rule that `kbengine.python.stubDir` must stay outside the project scripts tree. The default (`.kbengine/stubs`) is already kode-managed; a user-supplied directory is treated as user asset and only scanned, never overwritten.
3. Ratify that no release ships same-name `.pyi` shadowing of project `.py` files (the T-04 path) without an explicit opt-in that defaults to off.

Scope note: pyright 1.1.414 only. Pylance, Cursor and PyCharm remain unverified, so this evidence alone is not grounds to flip any default in A or B — the recommendation is a lock-in, not a widening.
