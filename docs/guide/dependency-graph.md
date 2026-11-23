# Entity Dependency Graph


Kode provides an entity dependency graph for viewing entity inheritance structures and references between entities.

## Overview

- Loads the entity list from `entities.xml`
- Analyzes entity inheritance
- Analyzes `ENTITYCALL` and entity references inside containers
- Mermaid-based visualization
- Opens entity definitions from the graph
- Exports SVG
- Exports PNG

## Related Commands

- `kbengine.dependency.show`

## Configuration

The dependency graph reads the fixed layouts `{assetsRoot}/scripts/entities.xml` and `{assetsRoot}/scripts/entity_defs` (no per-directory settings since 2026-11-23 — the engine only loads these fixed locations; `kbengine.assetsRoot` computes both).

If the graph cannot locate them, the failure is reported honestly (discovery report/launch chain) instead of silently missing nodes.

## What the Graph Shows

### Nodes

Each node represents one entity.

Nodes are tagged with the entity's presence flags:

- Base
- Cell
- Client

### Edges

Currently includes:

- Inheritance relations
- `ENTITYCALL` / entity reference relations

## Panel Features

### Refresh

Re-reads the current project structure and updates the graph.

Useful in these situations:

- New entities added
- Inheritance changed
- Entity references adjusted

### Open Entity Definition

Click an entity in the graph to open its `.def` file directly.

### Export

Supported formats:

- SVG
- PNG

Good for:

- Design documents
- Sharing with the team for discussion
- Architecture review material

## Usage Advice

### Reading Inheritance Depth

If you find some entity's inheritance chain too deep, it usually means:

- The structure may be over-coupled
- Behavior layering may be unclear
- Maintenance cost will rise over time

### Reading Reference Hotspots

The most referenced entities are usually the system's core points. They deserve a dedicated look:

- Do they carry too many responsibilities
- Should they be split
- Are they becoming a concentrated risk zone for changes

## Current Boundaries

The dependency graph today fits "structure visualization" and "navigation" better.

Not yet done:

- Clustering and hierarchical filtering for very large projects
- Custom layout strategies
- Showing only a subgraph or a single dependency chain
- Automatic optimization suggestions
