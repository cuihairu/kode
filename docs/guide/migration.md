# Extension Migration (old Kode IDs)

This page records the extension-id history and the exact steps to move from an older Kode id to the current one while keeping your settings. It exists so the rename never leaves a stale duplicate installed.

## Ids on record

| Role | Extension id | Evidence |
| --- | --- | --- |
| Old id | `cuihairu.kode` | initial commit `dc75f33` (`"name": "kode"`, publisher `cuihairu`) |
| Current id | `cuihairu.kode-kbengine` | rename commit `5421b4c` ("rename extension id to kode-kbengine") |

An intermediate repository-history spell used publisher `hairucui` with name `kode-kbengine` (id `hairucui.kode-kbengine`). It was never published; it is listed here only so the history is traceable. The automatic co-activation check (see below) watches `cuihairu.*` ids containing `kode`, so `cuihairu.kode` is covered; `hairucui.kode-kbengine` is outside that automatic net and must be removed manually if it somehow exists.

## What survives the move automatically

- All `kbengine.*` configuration keys in `settings.json` — configuration keys come from the extension's contributed configuration (`kbengine.*`), not from the extension id, so they apply unchanged once the new id is installed.
- Anything stored on disk in your workspace (`.kbengine/debug.json`, `tasks.json` entries, generated SDK output) — files are not tied to the extension id.

## What does not carry over (and what to redo)

The extension's private storage (`workspaceState` mementos) is bound to the extension instance; when the id changes, the old mementos do not migrate. These are the keys kode uses today:

| Storage key | What it holds | Redo action |
| --- | --- | --- |
| `kbengine.projectProfiles.v1` | Profiles list (assets/engine root pairs) | re-create profiles (Profiles view or import command) |
| `kbengine.activeProfileId.v1` | Active profile selection | pick the active profile again |
| `kbengine.testTaskContext` | last captured test-run context | captured again on the next test discovery |
| `kbengine.defCallChain.activeTab` | call-chain panel's selected tab | re-select the tab |
| `kbengine.discovery.<root>` | per-root discovery choices | re-run discovery when needed |

All redo actions are one-shot picks; no data outside the extension is touched.

## Migration steps

1. Install the current id `cuihairu.kode-kbengine`.
2. Disable (or uninstall) the old id `cuihairu.kode` in the Extensions view. If both are actually active at the same time, kode warns once per window activation with the message "检测到两个 Kode 扩展同时激活…"; an installed-but-inactive or disabled sibling never triggers the warning.
3. Reload the window.
4. Verify with **Commands: Extension Identity** (`kbengine.extension.identity`) — the report lists each matching install with separate `installed=` and `active=` facts; after migration only `cuihairu.kode-kbengine` should appear as `active=yes`.
5. Re-create your profiles and re-select the active profile (table above); your `kbengine.*` settings are already in effect.
