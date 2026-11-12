# Python process typings

`import KBEngine` denotes a different native module on each process. It cannot
be represented accurately by star-importing every process into a single stub.

The committed templates under `typings/processes/<role>/KBEngine` keep each
class in its own file, explicitly re-export public symbols, and expose only the
selected process's functions, constants and callbacks. The directory names are
`base`, `cell`, `bots`, `client`, `dbmgr`, `interfaces`, `logger`, `loginapp`.
`base` maps to engine component `baseapp`, and `cell` maps to `cellapp`.
Directory aliases `scripts/baseapp` and `scripts/cellapp` map to the same roles.
All directory matching is anchored to `scripts/`; an ancestor folder named
`base` does not classify a shared module as a base process.

`scripts/derive-kbengine-stub-typings.mjs` reads the pinned fork typings, then
`scripts/lib/process-stubs.py` applies the C++ corrections and filters process
interfaces. This author-time step requires Node and Python 3.9+. The extension
copies committed files; it does not need Python or an engine checkout to export
them. `typings/process-api.json` is generated alongside the .pyi files and is
embedded by both TS and Rust for matching module completion/hover signatures.

Activation creates missing templates only. It then merges per-directory
`executionEnvironments` into `pyrightconfig.json`, preserving JSONC and unrelated
settings. Each environment's extraPaths begins with its own process stub root,
followed by its script directory and common dependencies. Generated stub roots
also receive environments: imports inside their `entity_types.pyi` must resolve
to the same KBEngine class identities as consuming scripts.

The global stubPath is `stubs/_shared`, deliberately separate from both the old
mixed package and the process packages. A global KBEngine package has priority
over all execution-environment extraPaths and would defeat isolation. Existing
user execution environments are preserved; more specific roots precede broader
ones. An edited generated environment is treated as user-owned. Invalid JSONC,
TOML project configuration, inherited configuration, and conflicting user paths
are reported without replacing those configurations. These cases require
explicit integration using the exported process roots.

The .def generator writes `processes/{base,cell,bots,client}/entity_types.pyi`:
properties are selected using the resolved Flags domains, local methods by their
Base/Cell/ClientMethods section, and each remote channel has its own mailbox
class. Client/bots remote methods are limited to exposed methods. Custom types
remain in the common generated type registry. Generated entity stubs do not
shadow Python implementation files.

The common package contains only vectors and FixedArray; intermediate union
declarations are removed after derivation. Common imports do not silently gain
an arbitrary process's API. Its fresh copy at `processes/shared/KBEngine` leads
the default extraPaths, so a preserved, edited legacy root package cannot leak
into common scripts either. This shared directory is not an engine process.
Module-level `__getattr__ -> Any` is omitted from
selected process entries, so misspelled or cross-process module APIs are errors.
Entity and remote-handle dynamic attribute fallbacks remain for def-defined and
script-defined members; these fallbacks are not a substitute for whole-program
validation of every entity member.

Validation uses actual Pyright runs in one project containing base, cell, bots
and logger scripts, accepting legal calls and asserting diagnostics for APIs
from other processes. Every committed .pyi is also checked for unresolved type
names and incompatible overrides. TS providers and Rust consume one catalog;
Rust unit tests verify the role mapping and signature isolation.

The configuration model follows the official
[Pylance monorepo setup](https://github.com/microsoft/pylance-release/blob/main/docs/howto/monorepo-setup.md)
and [Pyright import resolution](https://github.com/microsoft/pyright/blob/main/docs/import-resolution.md).
