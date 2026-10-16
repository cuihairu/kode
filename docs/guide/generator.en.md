# Code Generator

[English](./generator.en.md) | [中文](./generator.md)

Kode ships a built-in entity code generator for quickly creating `.def` files and companion Python files.

## Overview

- Entity creation wizard
- Preset templates
- Automatic `.def` generation
- Automatic Python file generation
- Automatic registration into `entities.xml`
- Configurable output directories

In particular:

- Whether Python is generated depends on `kbengine.generator.generatePython`
- Whether `entities.xml` is written depends on `kbengine.generator.registerInEntitiesXml`
- The target location of `entities.xml` reads `kbengine.entitiesXmlPath`

## Related Commands

- `kbengine.generator.wizard`
- `kbengine.generator.templates`

## Generation Modes

### Wizard Mode

Good for:

- Creating standard entities
- Filling in properties and methods step by step
- Not wanting to hand-write the initial XML structure

### Template Mode

Good for:

- Quickly generating common entities
- Standard starting points agreed within a team

## Related Configuration

### `kbengine.generator.defOutputPath`

Controls the `.def` file output directory.

### `kbengine.generator.pythonOutputPath`

Controls the Python file output directory.

### `kbengine.generator.generatePython`

Whether to also generate Python files.

### `kbengine.generator.registerInEntitiesXml`

Whether to automatically write into `entities.xml` after generation.

## Typical Flow

1. Run `Create Entity from Wizard`
2. Choose the entity name and template
3. Configure properties, methods, and the Base / Cell / Client structure
4. Generate the `.def`
5. Generate Python or not, per configuration
6. Register into `entities.xml` or not, per configuration

## Fitting Use Cases

### Initial Modeling

Quickly lay out entity skeletons early in a project.

### Team Conventions

Reduce, through unified templates:

- Hand-written XML format errors
- Inconsistent output directories
- Missed `entities.xml` registrations

### Teaching and Onboarding

New members can start from the generator, then move on to understanding the final artifact structure.

## Current Boundaries

The current generator fits "quick starts" and "standard template generation".

Not yet done:

- Team-level template library management
- A custom template editor
- Reverse-extracting templates from existing entities
- More complex inheritance-chain modeling wizards
