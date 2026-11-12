# KBEngine Python debugger version pins

Verified 2026-11-11. For an embedded **CPython 3.7.3** engine, pin the target package to **debugpy==1.7.0** and the VS Code debugger extension to **ms-python.debugpy@2024.0.0**. The [official Microsoft compatibility table](https://github.com/microsoft/vscode-python-debugger#limited-support-for-deprecated-python-versions) assigns Python 3.7 to the 2024.0.x/1.7.0 line. [debugpy 1.8.0 requires Python >=3.8](https://pypi.org/project/debugpy/1.8.0/).

| Component | Reproducible Python 3.7.3 baseline | Scope |
| --- | --- | --- |
| Engine-side package | debugpy **1.7.0** | [PyPI metadata](https://pypi.org/project/debugpy/1.7.0/) supports Python >=3.7. |
| Python Debugger extension | ms-python.debugpy **2024.0.0** | [Manifest](https://github.com/microsoft/vscode-python-debugger/blob/v2024.0.0/package.json) requires VS Code ^1.78.0. |
| Python extension | ms-python.python **2024.0.1** | Project-selected reproduction baseline, **not** an asserted last supported release; [manifest](https://github.com/microsoft/vscode-python/blob/v2024.0.1/package.json) requires VS Code ^1.82.0. |
| VS Code host | >=1.82.0; record the exact tested build | Satisfies these manifests and Kode's host requirement; future builds are not automatically validated. |

The Python extension and debugger are independent. [Microsoft's historical README](https://github.com/microsoft/vscode-python-debugger/blob/v2024.0.0/README.md#purpose) explains that an older debugger can be retained separately. Pylance is an analyzer, not the debugging adapter; no unverified mandatory Pylance pin is invented here.

## Install and retain the extension versions

Use a dedicated VS Code Profile. Install Python first and the fixed debugger last:

```sh
code --profile KBEngine-Py37 --install-extension ms-python.python@2024.0.1 --force
code --profile KBEngine-Py37 --install-extension ms-python.debugpy@2024.0.0 --force
code --profile KBEngine-Py37 --list-extensions --show-versions
```

Disable Auto Update for these extensions. On older VS Code versions, use `"extensions.autoUpdate": false` in the dedicated Profile's **user settings**. Workspace extension recommendations contain IDs and do not pin versions. Recheck the effective versions on Remote SSH/container extension hosts and after Settings Sync or manual updates. For offline installation, retain the correct platform VSIX, manifest version and SHA-256. See [official extension management](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#install-an-extension).

## Install the target package

Use [the pinned requirements file](https://github.com/cuihairu/kode/blob/main/scripts/requirements/debugpy-py37.txt) in a dedicated environment matching the engine's Python, ABI, OS and architecture:

```sh
/path/to/python3.7 -c "import sys; print(sys.version, sys.executable)"
/path/to/python3.7 -m pip install --force-reinstall -r scripts/requirements/debugpy-py37.txt
/path/to/python3.7 -c "import debugpy; print(debugpy.__version__, debugpy.__file__)"
```

For this engine, verify the interpreter actually reports 3.7.3. Do not use an unbounded `pip install -U debugpy`, ignore Requires-Python, or copy a modern host interpreter's package into the old embedded runtime. Newer engines need their own tested pins.

## Current Kode automation blocker

**This documentation change does not fix the existing automatic installer/synchronizer.** `autoDebugpy.ts` currently hardcodes Python 3.12.13/debugpy >=1.8.0; `debugpyPreflight.ts` shares that check, while `debugpyPortProbe.ts` still installs with `-U debugpy`. Package-directory existence also does not prove compatibility. Until `DBG-COMPAT-*` tasks are completed, do not use these automatic paths to establish a Python 3.7.3 environment.

Deploy the correctly prepared package manually to `<assets>/scripts/common/debugpy`: back up the old directory outside the watched tree, stage a clean full package and replace the target rather than merging incompatible versions. Check the selected environment's `debugpy.__file__` to locate the source. In a fresh engine process, verify:

```python
import sys, debugpy
print(sys.version)
print(debugpy.__version__)
print(debugpy.__file__)
debugpy.listen(("127.0.0.1", 5678))
```

Then connect with `type: "debugpy"`, `request: "attach"` and `connect: {"host":"127.0.0.1","port":5678}`. Add actual path mappings for remote source trees and use distinct ports per process. Installing/syncing does not start a listener, and an open port does not prove breakpoint operation.

## Newer engines and evidence limits

Microsoft lists Python 3.8 with extension 2024.2.x/debugpy 1.8.1 and Python 3.9 with 2025.5.x/1.8.13. Those are extension support lines. For example, [debugpy 1.8.13 itself requires >=3.8](https://pypi.org/project/debugpy/1.8.13/), which is not the same constraint as its companion extension's support line. Select exact versions from metadata and tests instead of assuming newer Python always permits every latest release.

The package imported successfully under an independently built CPython 3.7.3 using a Linux x86-64 cp37 wheel. Starting `debugpy.listen` in this temporary Linux CPython 3.7.3 build exited with code **139**, both with default settings and with Cython/frame-eval disabled. The cause is not yet established; this does not prove all Python 3.7.3 distributions fail. Import is verified, listener operation is not. Full VS Code breakpoint, embedded-engine, Windows and PID-attach validation are separate, pending checks. See the [detailed Chinese guide](../zh/guide/python-debugger-compatibility.md) and `DBG-COMPAT-*` in the project TODO for installation, preflight, synchronization and extension-version checks.
