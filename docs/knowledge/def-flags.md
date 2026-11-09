# `.def` property Flags — the complete engine truth

> User report (2026-11-09): "Flags 很多都解析错误,CELL_PUBLIC_AND_OWN 也是解析错误的" —
> this page is the source-first answer: every Flags spelling the engine accepts, the bit
> it maps to, the relation masks that define its runtime semantics, the two parse paths
> (they disagree on strictness — that disagreement is the root cause of most "wrong
> parsing" reports), and how kode consumes the same table. Grounding domain is
> `kbe/src` at `/home/cui/workspaces/kbengine`, HEAD `3082ab5` (verified at HEAD on
> 2026-11-09); every claim carries a `file:line` anchor. Fills the gap recorded in
> [api-core-concepts](api-core-concepts.md) §"flags are referenced but not enumerated".

## 1. The bits (`common.h:19-27`)

`EntityDataFlags` is a plain bitmask. The engine's own enum spelling `ED_FLAG_UNKOWN`
(missing an S) is preserved here verbatim — `common.cpp:38-40` even returns the string
`"UNKOWN"` from `entityDataFlagsToString`.

| Bit | Name | Engine comment | Meaning |
| --- | --- | --- | --- |
| 0x00 | `ED_FLAG_UNKOWN` | 未定义 | no face anywhere (parse-failure sentinel) |
| 0x01 | `ED_FLAG_CELL_PUBLIC` | 相关所有cell广播 | cellapp-registered, broadcast to all relevant cellapps, never reaches any client |
| 0x02 | `ED_FLAG_CELL_PRIVATE` | 当前cell | cellapp-registered, current cellapp only |
| 0x04 | `ED_FLAG_ALL_CLIENTS` | cell广播与所有客户端 | cellapp-registered + cross-cell broadcast + every client (owner + AOI others) |
| 0x08 | `ED_FLAG_CELL_PUBLIC_AND_OWN` | cell广播与自己的客户端 | cellapp-registered + cross-cell broadcast + owner's client only |
| 0x10 | `ED_FLAG_OWN_CLIENT` | 当前cell和客户端 | cellapp-registered, owner's client only, no cross-cell broadcast |
| 0x20 | `ED_FLAG_BASE_AND_CLIENT` | base和客户端 | baseapp-registered + owner's client only, never touches cellapp |
| 0x40 | `ED_FLAG_BASE` | 当前base | baseapp-registered only, no client face |
| 0x80 | `ED_FLAG_OTHER_CLIENTS` | cell广播和其他客户端 | cellapp-registered + cross-cell broadcast + AOI other clients, never the owner's client |

## 2. The relation masks (`common.h:40-56`)

Per-flag runtime semantics are **entirely** mask membership — there is no separate
per-flag behavior code. `ED_FLAG_ALL` (`common.h:29-31`) is the union of all eight.

| Mask | Members | Consumed at |
| --- | --- | --- |
| `ENTITY_BASE_DATA_FLAGS` (L41) | BASE, BASE_AND_CLIENT | script-module face `setBase(true)` (`entitydef.cpp:1149-1152`) |
| `ENTITY_CELL_DATA_FLAGS` (L43) | CELL_PUBLIC, CELL_PRIVATE, ALL_CLIENTS, CELL_PUBLIC_AND_OWN, OTHER_CLIENTS, OWN_CLIENT | script-module face `setCell(true)` (`entitydef.cpp:1153-1156`) |
| `ENTITY_CLIENT_DATA_FLAGS` (L45) | BASE_AND_CLIENT, ALL_CLIENTS, CELL_PUBLIC_AND_OWN, OTHER_CLIENTS, OWN_CLIENT | script-module face `setClient(true)` (`entitydef.cpp:1157-1160`); clientprop filter (`py_entitydef.cpp:2245`) |
| `ENTITY_BROADCAST_CELL_FLAGS` (L47) | CELL_PUBLIC, ALL_CLIENTS, CELL_PUBLIC_AND_OWN, OTHER_CLIENTS | ghost sync to other cellapps (`cellapp/entity.cpp:689`) |
| `ENTITY_BROADCAST_OTHER_CLIENT_FLAGS` (L49) | OTHER_CLIENTS, ALL_CLIENTS | AOI other-client fan-out (`cellapp/entity.cpp:724/:800/:883`; `entity_macro.h:629`) |
| `ENTITY_BROADCAST_OWN_CLIENT_FLAGS` (L51) | ALL_CLIENTS, CELL_PUBLIC_AND_OWN, OWN_CLIENT, BASE_AND_CLIENT | owner-client push via witness (`cellapp/entity.cpp:854`) |
| `ENTITY_BASEAPP_ANDA_CLIENT_DATA_FLAGS` (L53) | BASE_AND_CLIENT | baseapp↔client coupling |
| `ENTITY_CELLAPP_ANDA_CLIENT_DATA_FLAGS` (L55) | ALL_CLIENTS, CELL_PUBLIC_AND_OWN, OTHER_CLIENTS, OWN_CLIENT | cellapp↔client coupling |

Reading the three broadcast masks together yields each flag's client story:

- **No client ever sees it**: CELL_PUBLIC, CELL_PRIVATE, BASE.
- **Only the owner's client sees it**: OWN_CLIENT, BASE_AND_CLIENT, CELL_PUBLIC_AND_OWN.
- **Owner + AOI others see it**: ALL_CLIENTS.
- **AOI others see it, the owner does not**: OTHER_CLIENTS.

## 3. The name table — 12 spellings the engine accepts (`entitydef.cpp:161-174`)

`g_entityFlagMapping` is populated once in `EntityDef::initialize`. Eight canonical
names plus four legacy aliases that land on the **same bit**:

| Spelling | Bit | Note |
| --- | --- | --- |
| `CELL` | 0x01 | alias → CELL_PUBLIC (`entitydef.cpp:161`) |
| `CELL_AND_CLIENT` | 0x08 | alias → CELL_PUBLIC_AND_OWN (`entitydef.cpp:162`) |
| `CELL_AND_CLIENTS` | 0x04 | alias → ALL_CLIENTS (`entitydef.cpp:163`) |
| `CELL_AND_OTHER_CLIENTS` | 0x80 | alias → OTHER_CLIENTS (`entitydef.cpp:164`) |
| `BASE_AND_CLIENT` | 0x20 | canonical (`entitydef.cpp:165`) |
| `BASE` | 0x40 | canonical (`entitydef.cpp:166`) |
| `CELL_PUBLIC` | 0x01 | canonical (`entitydef.cpp:168`) |
| `CELL_PRIVATE` | 0x02 | canonical (`entitydef.cpp:169`) |
| `ALL_CLIENTS` | 0x04 | canonical (`entitydef.cpp:170`) |
| `CELL_PUBLIC_AND_OWN` | 0x08 | canonical (`entitydef.cpp:171`) |
| `OTHER_CLIENTS` | 0x80 | canonical (`entitydef.cpp:173`) |
| `OWN_CLIENT` | 0x10 | canonical (`entitydef.cpp:174`) |

No other spelling exists anywhere in the engine; there is no `PERSISTENT`/`UNIQUE`
flag — persistence is the separate `<Persistent>` node (`entitydef.cpp:1178+`)
and uniqueness is the separate `<Index>`/`<Unique>` mechanism.

## 4. The two parse paths — and why they disagree

This is the root cause of most "this flag parses wrong" reports: **the same name can be
legal in one path and silently meaningless in the other.**

### 4.1 XML `.def` path — lenient, loud, alias-aware (`entitydef.cpp:1134-1176`)

For every `<Property>` in a `.def` file (`loadDefPropertys`):

1. `<Flags>` node is **mandatory** — missing → `ERROR_MSG` + `return false`, the whole
   def module fails to load (`entitydef.cpp:1170-1176`).
2. The raw text is upper-cased first (`std::transform(... toupper)` at
   `entitydef.cpp:1138`), then looked up as **one whole string** in
   `g_entityFlagMapping` (`entitydef.cpp:1140`). `|`-composed values are *not*
   decomposed — `BASE|CELL` simply fails the lookup.
3. Unknown spelling → `ERROR_MSG "not fount flags[...]"` + `return false` — the
   entity fails to load (`entitydef.cpp:1141-1147`).
4. On success the flags are immediately projected onto the module's base/cell/client
   faces (`entitydef.cpp:1149-1160`).
5. A final guard demands `hasBaseFlags > 0 || hasCellFlags > 0` (`entitydef.cpp:
   1162-1168`); note this can never actually fire, because all 12 mapping values have
   a base or cell face — it is defensive only.

So in XML: case-insensitive, alias-friendly, fail-hard on anything unknown.

### 4.2 Python decorator path — strict, silent, canonical-8-only (`py_entitydef.cpp:2507` → `common.cpp:42-68`)

Properties registered via the `@kbengine.onCommon.../onCell.../onBase...` decorator
family resolve their collected `propertyFlags` through
`stringToEntityDataFlags` (`common.cpp:42-68`), which is an **exact, case-sensitive,
8-name `if`-chain**: the four legacy aliases are absent, there is no `toupper`, and
anything unmatched — including `CELL`, `CELL_AND_CLIENT`, or `cell_public` — returns
`ED_FLAG_UNKOWN` (0x00). The call site (`py_entitydef.cpp:2507`) does not check for
`ED_FLAG_UNKOWN`, so a mistyped name produces a property with **no base, cell or
client face at all** — invisible everywhere, no error. The subsequent face checks
(`py_entitydef.cpp:532-536`) test `!= 0` against the relation masks, which also just
quietly fails.

Practical consequence: **the four legacy aliases are XML-only.** `CELL` works in a
`.def` file and is a silent no-op in a decorator. Decorators accept exactly the eight
canonical spellings, exactly cased.

### 4.3 The mapping is also exposed to Python (`py_entitydef.cpp:2912-2926`)

`PyEntityDef::initialize()` adds every `g_entityFlagMapping` key as a string constant
on the `entitydef` module (so `EntityDef.CELL == "CELL"`, alongside `UNIQUE`,
`INDEX`, `CALLER_ID`). This is why the alias spellings show up as importable module
attributes — it does **not** make them valid decorator inputs (§4.2 still applies,
because the decorator path never consults the map).

## 5. Per-flag runtime semantics (derived from §2, cited to consumption sites)

| Flag | Registered on | Cross-cell broadcast | Owner's client | AOI other clients |
| --- | --- | --- | --- | --- |
| CELL_PUBLIC (0x01) | cellapp | yes (L47; `cellapp/entity.cpp:689`) | no | no |
| CELL_PRIVATE (0x02) | cellapp | no | no | no |
| ALL_CLIENTS (0x04) | cellapp | yes | yes (L51; `:854`) | yes (L49; `:724/:800`) |
| CELL_PUBLIC_AND_OWN (0x08) | cellapp | yes | yes | no |
| OWN_CLIENT (0x10) | cellapp | no | yes | no |
| BASE_AND_CLIENT (0x20) | baseapp | n/a (never on cellapp) | yes | no |
| BASE (0x40) | baseapp | n/a | no | no |
| OTHER_CLIENTS (0x80) | cellapp | yes | no | yes |

## 6. Traps index

1. **Aliases are XML-only** (§4.2) — `CELL`/`CELL_AND_CLIENT`/`CELL_AND_CLIENTS`/
   `CELL_AND_OTHER_CLIENTS` load fine from `.def` but silently become `ED_FLAG_UNKOWN`
   through the decorator path.
2. **`|` composition is never supported** — both paths treat the text as one lookup
   key; `BASE|CELL` is an unknown flag in XML and UNKOWN in decorators. Compose
   behavior by choosing the single pre-composed flag that matches.
3. **Case matters only in decorators** — XML upper-cases first (`entitydef.cpp:1138`);
   `stringToEntityDataFlags` does not (`common.cpp:42-68`).
4. **A decorator typo is silent** — `ED_FLAG_UNKOWN` is never checked at
   `py_entitydef.cpp:2507`; the property just has no face.
5. **`UNKOWN` is the engine's own typo** — enum `ED_FLAG_UNKOWN` (`common.h:19`),
   string `"UNKOWN"` (`common.cpp:38-40`). Do not "fix" the spelling when quoting.

## 7. kode consumption (single-source pipeline)

kode mirrors exactly this table, single-sourced from the Rust parser and lockstep-
verified:

- **Rust normalization** `crates/kode-parser/src/model.rs normalize_flag_tokens`:
  trim + upper-case, the four legacy aliases, legacy-spelling folding (whitespace/
  hyphen/underscore variants), unknown preserved upper-case, de-dup keep-first.
- **Domain projection** `kode_parser::model::flag_domains` + lint consumer
  `crates/kode-server/src/lint/rules.rs:183-187` — the §2 masks as a lookup table.
- **Golden snapshot** `crates/kode-server/tests/golden/flag-domains-parity.json`
  (regen: `cargo run -p kode-server --bin dump-flag-domains-golden`).
- **TS mirror** `src/generated/flagDomains.ts` (generated; do not hand-edit) —
  `CANONICAL_FLAG_TOKENS` / `FLAG_TOKEN_DOMAINS` / `FLAG_DOMAIN_ALIAS` /
  `normalizeFlagTokens`, parity-gated by `tests/flagDomainsParity.test.ts`.
- **Consumers**: duplicate-definition scopes (`src/languageProviders/validation.ts
  normalizePropertyFlag`), analysis faces (`src/backend/defAnalyzer.ts
  propertyFlagDomainList`), completion sets, hover metadata
  (`src/kbengineMetadata.ts KBENGINE_FLAGS`), message table bits
  (`src/messageTableEngine.ts PROPERTY_FLAG_BITS`), dependency-graph & process
  topology projections.

History note (2026-11-09): before this batch, kode's alias handling was incomplete on
both sides — Rust normalization missed `CELL`/`CELL_AND_*` entirely (so
`CELL_PUBLIC_AND_OWN`-era aliases lost their domain faces and flagged as unknown), and
the TS validator only normalized three of the four aliases. Both now derive from the
same 12-entry table above; `tests/kbengineMetadata.test.ts` machine-checks the hover
documentation's per-flag claims against `common.h` masks so the docs cannot drift from
source.

## 8. Engine version caveat

Grounded at fork HEAD `3082ab5` (2026-11-09). The upstream BigWorld-derived code has
carried this exact 12-entry map and 8-relation-mask set for many years; if the fork
advances, `tests/kbengineMetadata.test.ts` (engine-backed tests, skipped when no
engine checkout is present) re-verifies the enum names and every §5 claim directly
against `common.h`.
