# Client Entity SDK Generation


Generates client entity skeletons from `.def` files for the entities registered in `entities.xml`. Currently TypeScript, C# and Python are supported; pick them (multi-select) inside the command.

## Overview

- Generation source: entities registered in `entities.xml`; registered entries missing a `.def` file are skipped
- Profile binding: with an active profile, registration order and type data come from that profile's assets root only (`src/sdkGenerationProfile.ts`); same-named entities from other scanned roots are rejected and named in the completion message, never silently merged; without an active profile the first workspace folder is used
- Property surface: only items whose `Flags` include a client domain (`BASE_AND_CLIENT`/`OWN_CLIENT`/`CELL_PUBLIC_AND_OWN`/`ALL_CLIENTS`/`OTHER_CLIENTS`) become writable fields
- Callback surface: `ClientMethods` become virtual callback slots with full signatures and parameter types, bodies left as TODO
- Request surface: `BaseMethods`/`CellMethods` carrying `<Exposed>` become wrapper calls
- Send seams: `onBaseOutgoing`/`onCellOutgoing` are two empty implementations; the actual send channel is implemented against whichever client plugin you use
- Fixed dicts: `FIXED_DICT` types referenced by client-visible properties get a companion file
- No silent overwrite: existing files are skipped by default; the overwrite policy is chosen inside the command

## Related Commands

- `kbengine.clientSdk.generate`
- `client-sdk-gen` (standalone CLI binary, see below)

See [Commands and Panels](./commands.md) for command details.

## Standalone CLI (`client-sdk-gen`)

The same generation core ships as a headless binary for CI and scripts — no editor session required. The collection contract mirrors the extension flow: `scripts/entities.xml` registration order, component def closure (`entity_defs/components/` preferred, `entity_defs/interfaces/` fallback), `entity_defs/types.xml`.

```bash
cargo build -p kode-server --bin client-sdk-gen --release

./target/release/client-sdk-gen \
  --assets-root <assets-dir> \
  --language python \
  --out <output-dir>                      # default <assets-root>/scripts/client_entities
  # [--namespace <ns>]                    # C# only, default KbEngineClient
  # [--engine-version 2.5.10 --engine-commit 55a66552]   # header trace, must be given as a pair
  # [--generated-at <text>]               # header timestamp, default empty
```

Exit code 0 writes the files (paths printed to stdout); non-zero reports the failure. Existing files are always overwritten in CLI mode — CI regeneration is expected to be deterministic.

## Related Configuration

### `kbengine.clientSdk.outputDir`

Output directory, relative to the workspace root, default `scripts/client_entities`. The language list is not configured here; it is picked when the command runs.

## What Gets Generated

### Entity Files

One file per entity, named `<EntityName>.ts` / `<EntityName>.cs` / `<EntityName>.py`. Inside the class, in order: a read-only entity id member, client-visible properties, the constructor, `ClientMethods` callbacks, Exposed wrapper calls, and the two send seams.

Every generated file (entity files and the fixed-dict companion) carries an engine-trace header: `引擎版本`/`引擎提交` lines record the input engine's version macro and git commit (probed via `readEngineApiMetadata`, profile engine root preferred); when the engine cannot be located both lines read `unknown` verbatim — the trace is never silently omitted (`src/sdkGenerationTrace.ts`).

- TypeScript: properties keep their def names, callbacks are concrete methods, parameters named `_arg0`/`_arg1`… (def `<Arg>` carries types only, no names)
- C#: names are PascalCased (`hp` → `Hp`, `onHPChanged` → `OnHPChanged`), properties are `get; set;`, callbacks are `virtual`, parameters come after the type, named `arg0`/`arg1`…
- Python: files named `<EntityName>.py`; names keep their def spellings (snake_case wrappers `base_call_*`/`cell_call_*`, seams `on_base_outgoing`/`on_cell_outgoing`), properties are class-level annotations, `__init__(entity_id)` assigns the id. FIXED_DICT/component companions are `@dataclass` classes; imports are package-relative (`from .ClientSdkFixedDicts import …`), so consume the output directory as a package. The skeleton is standard-library-only and can be imported/instantiated directly — the intended carrier for e2e tests

### Properties

Only client-visible items are included; server-only properties (`BASE`, `CELL`, `CELL_PRIVATE`) never enter the client surface. Each property is annotated with the def's original `Flags` for tracing engine semantics back.

### Methods

- All of `ClientMethods` is included, `<Exposed>` not required — they are the callback slots the client implements
- `BaseMethods`/`CellMethods` include only `<Exposed>` ones; unexposed server methods cannot be requested by the client and are not generated

### Send Seams

A wrapper call's body does exactly one thing: hand the method name and arguments to the matching seam.

```ts
public baseCallCreateAvatar(_arg0: number): void {
  this.onBaseOutgoing('createAvatar', [_arg0]);
}
```

The seams themselves are empty. Each client plugin's own base/cell call channel (Unity plugin, js plugin, etc.) is implemented by you in a subclass; the generator assumes no plugin API.

## Type Mapping

| def type | TypeScript | C# | Python |
| --- | --- | --- | --- |
| `UINT8` / `UINT16` / `UINT32` | `number` | `byte` / `ushort` / `uint` | `int` |
| `UINT64` | `bigint` | `ulong` | `int` |
| `INT8` / `INT16` / `INT32` | `number` | `sbyte` / `short` / `int` | `int` |
| `INT64` | `bigint` | `long` | `int` |
| `FLOAT` / `DOUBLE` | `number` | `float` / `double` | `float` |
| `STRING` / `UNICODE` | `string` | `string` | `str` |
| `VECTOR2` / `VECTOR3` / `VECTOR4` | `[number, number]` / `[number, number, number]` / `[number, number, number, number]` | `Vector2` / `Vector3` / `Vector4` | `tuple[float, float]` / `tuple[float, float, float]` / `tuple[float, float, float, float]` |
| `ENTITYCALL` / `PYTHON` | `unknown` | `object` | `Any` |
| `PY_DICT` / `PY_TUPLE` / `PY_LIST` | `unknown` | `object` | `dict` / `tuple` / `list` |
| `BLOB` | `unknown` | `object` | `bytes` |
| `ARRAY` (`<of>` element type) | element type + `[]` | element type + `[]` | `list[element]` |
| `FIXED_DICT` alias | the companion file's `interface` name | the companion file's `class` name | the companion file's `@dataclass` name |
| Unrecognized | `unknown` | `object` | `Any` |

The type table shares its source with the engine's registry (17 built-in types). Phantom types the engine never registered, like `BOOL`, get no mapping and fall to the fallback value, while def analysis diagnostics still report them.

### 64-bit integer boundary (TypeScript)

`UINT64`/`INT64` map to `bigint`, not `number`: a JavaScript `number` is an IEEE-754 float64 whose integer precision ends at 2^53-1, so values like `9007199254740993` (2^53+1) silently collapse to 2^53. `bigint` covers the full 64-bit domain exactly. Consequences (each generated TypeScript SDK file carries a header line stating this):

- **Compile target**: the consuming TS project must target **ES2020+** (BigInt support).
- **Codec boundary**: `JSON.stringify` throws on a `bigint`; the wire codec must be BigInt-aware (e.g. encode as a string or via a binary buffer). `entityId` stays `number` (baseapp-assigned, safely below 2^53).
- C# is unaffected (`ulong`/`long` are full-width).
- Python is unaffected: Python 3 `int` is arbitrary-precision, so `UINT64`/`INT64` map to plain `int` with no special-casing (each generated Python SDK file carries a header line stating this).

### Python zero-dependency choice

The Python skeleton deliberately avoids the KBEngine Python stubs (`Vector` classes etc.) and uses stdlib-only annotations (`tuple[float, float, float]` for vectors), so the generated directory imports and instantiates with no engine checkout on `PYTHONPATH` — that is what makes it usable as an e2e/test carrier. If you want engine-typed annotations instead, post-process or extend the generator; do not edit generated files by hand.



C# vectors default to the bare names `Vector2`/`Vector3`/`Vector4` (Unity ships them); non-Unity projects rename to their own vector types.

## Fixed Dict Companion File

A companion file appears only when some client-visible property references a `FIXED_DICT` alias; it is named `ClientSdkFixedDicts.ts` / `ClientSdkFixedDicts.cs` / `ClientSdkFixedDicts.py` and includes only referenced types (aliases declared in `types.xml` but never referenced are not generated). The TypeScript side is an `interface` imported by the entity files; the C# side is a `class` in the same namespace as the entities (fixed `KbEngineClient`; renaming means changing the generator constant `CLIENT_SDK_CSHARP_NAMESPACE`); the Python side is a `@dataclass` imported via package-relative import.

## Typical Flow

1. Open the project and confirm the `scripts/entities.xml` and `scripts/entity_defs/` layout resolve normally
2. Run `Generate Client Entity SDK`
3. Pick the target languages
4. Confirm the output directory (default `scripts/client_entities`)
5. Choose how to treat existing files (default skip)
6. Check the notification for how many files were written
7. Implement `onBaseOutgoing`/`onCellOutgoing` in your subclass, wiring in your client plugin's call channel

## Current Boundaries

Not yet done:

- No client plugin call channel implementation; `onBaseOutgoing`/`onCellOutgoing` must be implemented per plugin
- Language batch is TypeScript, C# and Python; GDScript and C++ are not done
- Only entities registered in `entities.xml` are generated; unregistered `.def` files are not
- Existing files are not overwritten by default; regenerating the same entities skips them
- Generated files do not automatically enter version control or the build flow; integration is up to you
