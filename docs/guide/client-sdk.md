# Client Entity SDK Generation


Generates client entity skeletons from `.def` files for the entities registered in `entities.xml`. Currently TypeScript and C# are supported; pick them (multi-select) inside the command.

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

See [Commands and Panels](./commands.md) for command details.

## Related Configuration

### `kbengine.clientSdk.outputDir`

Output directory, relative to the workspace root, default `scripts/client_entities`. The language list is not configured here; it is picked when the command runs.

## What Gets Generated

### Entity Files

One file per entity, named `<EntityName>.ts` / `<EntityName>.cs`. Inside the class, in order: a read-only entity id member, client-visible properties, the constructor, `ClientMethods` callbacks, Exposed wrapper calls, and the two send seams.

Every generated file (entity files and the fixed-dict companion) carries an engine-trace header: `引擎版本`/`引擎提交` lines record the input engine's version macro and git commit (probed via `readEngineApiMetadata`, profile engine root preferred); when the engine cannot be located both lines read `unknown` verbatim — the trace is never silently omitted (`src/sdkGenerationTrace.ts`).

- TypeScript: properties keep their def names, callbacks are concrete methods, parameters named `_arg0`/`_arg1`… (def `<Arg>` carries types only, no names)
- C#: names are PascalCased (`hp` → `Hp`, `onHPChanged` → `OnHPChanged`), properties are `get; set;`, callbacks are `virtual`, parameters come after the type, named `arg0`/`arg1`…

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

| def type | TypeScript | C# |
| --- | --- | --- |
| `UINT8` / `UINT16` / `UINT32` / `UINT64` | `number` | `byte` / `ushort` / `uint` / `ulong` |
| `INT8` / `INT16` / `INT32` / `INT64` | `number` | `sbyte` / `short` / `int` / `long` |
| `FLOAT` / `DOUBLE` | `number` | `float` / `double` |
| `STRING` / `UNICODE` | `string` | `string` |
| `VECTOR2` / `VECTOR3` / `VECTOR4` | `[number, number]` / `[number, number, number]` / `[number, number, number, number]` | `Vector2` / `Vector3` / `Vector4` |
| `ENTITYCALL` / `PYTHON` / `PY_DICT` / `PY_TUPLE` / `PY_LIST` / `BLOB` | `unknown` | `object` |
| `ARRAY` (`<of>` element type) | element type + `[]` | element type + `[]` |
| `FIXED_DICT` alias | the companion file's `interface` name | the companion file's `class` name |
| Unrecognized | `unknown` | `object` |

The type table shares its source with the engine's registry (17 built-in types). Phantom types the engine never registered, like `BOOL`, get no mapping and fall to the fallback value, while def analysis diagnostics still report them.

C# vectors default to the bare names `Vector2`/`Vector3`/`Vector4` (Unity ships them); non-Unity projects rename to their own vector types.

## Fixed Dict Companion File

A companion file appears only when some client-visible property references a `FIXED_DICT` alias; it is named `ClientSdkFixedDicts.ts` / `ClientSdkFixedDicts.cs` and includes only referenced types (aliases declared in `types.xml` but never referenced are not generated). The TypeScript side is an `interface` imported by the entity files; the C# side is a `class` in the same namespace as the entities (fixed `KbEngineClient`; renaming means changing the generator constant `CLIENT_SDK_CSHARP_NAMESPACE`).

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
- First language batch is TypeScript and C# only; GDScript and C++ are not done
- Only entities registered in `entities.xml` are generated; unregistered `.def` files are not
- Existing files are not overwritten by default; regenerating the same entities skips them
- Generated files do not automatically enter version control or the build flow; integration is up to you
