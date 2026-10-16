# Log Viewer


Kode ships a log viewer WebView for the KBEngine logger, to view, filter, and export logs.

The logger protocol adaptation is not finished yet. The extension clearly states this capability is not supported yet, so an unverified protocol implementation is never presented as a working one.

## Overview

- Connect to the logger port
- View connection status and limitation notes
- Level filtering
- Component filtering
- Keyword search
- Regular expression search
- Log export
- Raw log ERROR scan (offline, no logger connection needed)

## Related Commands

- `kbengine.logs.showViewer`
- `kbengine.logs.connect`
- `kbengine.logs.disconnect`
- `kbengine.logs.clear`
- `kbengine.logs.export`
- `kbengine.logs.scanErrors`

See [Commands and Panels](./commands.md) for command details.

## Related Configuration

### `kbengine.loggerPort`

The logger connection port, default `20022`.

### `kbengine.logAutoConnect`

Whether to auto-connect to the log port when starting the server.

### `kbengine.maxLogEntries`

The maximum number of cached entries in the log WebView.

If you notice:

- The panel getting sluggish
- Clearly delayed scrolling
- Memory growing over long runs

lower this value first.

## Typical Flows

### Day-to-Day Viewing

1. Start the KBEngine components
2. Run `Show Log Viewer`
3. Connect to the logger
4. Filter by level and component to inspect problems

### Investigating Problems

1. Open the log panel
2. Locate entity names, component names, or error fragments by keyword
3. Enable regex search when needed
4. Export the logs for further analysis

## Export

Logs can be exported as:

- `txt`
- `log`
- `json`

Good for:

- Preserving the scene of a problem
- Handing to colleagues for investigation
- Offline analysis with scripts

## Raw Log ERROR Scan

`kbengine.logs.scanErrors` scans raw log files on disk offline, without a logger port connection. After running it, pick files or folders (folders scan one level of `.log`/`.txt`/`.out`, sorted by filename); the extension aggregates `ERROR`/`CRITICAL` lines by "component + normalized signature" and shows them in the WebView panel.

- Normalized signature: digit runs folded into `N`, whitespace compressed, truncated to 160 characters, so the same error with different ids/counters does not split into multiple rows
- Aggregate table: count (descending) / level / component / signature / most recent occurrence; time is taken only from timestamps carried in the line, non-standard lines show `—`
- Clicking a hit row opens the source file and locates the earliest line of that signature
- The "Rescan" button re-runs on the previous batch of files without re-popping the dialog
- A single file over the 64MB read limit, or a read failure, is flagged with its failure reason in the scanned-file list without interrupting the rest
- A summary row gives file count, total lines, total ERROR/CRITICAL entries, and the number of distinct signatures

The scan uses the same parser family as the log panel (logger line format / standard format / non-standard heuristic), so non-standard lines containing `error`/`failed` wording are also counted.

## Usage Advice

### Team Collaboration

Unify the logger port configuration, so "the extension opens but logs won't connect" doesn't happen across people's environments.

### Heavy Log Environments

Recommended:

- Lower `kbengine.maxLogEntries`
- Filter by component first
- Then layer keyword search on top

## Current Boundaries

The current log capability leans "interface and export layer"; it is not a stable collector with the official logger protocol adaptation completed.

Deliberately not done:

- Saving filter presets
- Multi-session comparison
- Automatic clustering by entity semantics
