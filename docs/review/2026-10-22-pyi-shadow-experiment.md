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
