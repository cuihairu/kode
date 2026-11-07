#!/usr/bin/env node
// Generate crates/kode-mcp/src/config_catalog.rs from src/serverConfigCatalog.ts.
//
// Single source of truth = the TS engine defaults copy library
// (serverConfigCatalog.ts, harvested from kbe/res/server/kbengine_defaults.xml).
// The Rust snapshot is what kode-mcp's config Q&A face (why_setting) consumes.
// Regenerate on catalog change; --check fails on drift (CI).
//
// Usage:
//   node scripts/gen-config-catalog.mjs          # (re)write the Rust snapshot
//   node scripts/gen-config-catalog.mjs --check  # verify no drift, exit 1 on mismatch

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcFile = path.join(root, 'src', 'serverConfigCatalog.ts');
const outRust = path.join(root, 'crates', 'kode-mcp', 'src', 'config_catalog.rs');
const checkOnly = process.argv.includes('--check');

/** Bundle the pure-data TS catalog to a temp ESM module and import it. */
async function loadCatalog() {
  const cacheDir = path.join(root, 'node_modules', '.cache', 'kode-gen');
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = path.join(cacheDir, 'config-catalog.mjs');
  await build({
    entryPoints: [srcFile],
    outfile: tmp,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    logLevel: 'silent',
  });
  const mod = await import(`${pathToFileURL(tmp).href}?t=${Date.now()}`);
  return mod.SERVER_CONFIG_ITEM_DOCS;
}

/** Minimal raw-string delimiter that survives the text (r#"..."# family). */
function rustStr(s) {
  let hashes = '#';
  while (s.includes(`"${hashes}`)) hashes += '#';
  return `r${hashes}"${s}"${hashes}`;
}

function emitRust(docs) {
  const entries = Object.keys(docs)
    .sort()
    .map(key => {
      const d = docs[key];
      return [
        '    (',
        rustStr(key),
        ', ConfigDoc { zh: ',
        rustStr(d.zh),
        ', en: ',
        rustStr(d.en),
        ', source: ',
        rustStr(d.source),
        ', group: ',
        rustStr(d.group),
        ' }),',
      ].join('');
    })
    .join('\n');
  return `//! Generated from src/serverConfigCatalog.ts by scripts/gen-config-catalog.mjs.
//! DO NOT EDIT BY HAND — regenerate with \`node scripts/gen-config-catalog.mjs\`.
//!
//! Single source of truth = the TS engine defaults copy library
//! (serverConfigCatalog.ts, harvested from kbe/res/server/kbengine_defaults.xml
//! and a few kbe/src/lib/server/serverconfig.cpp read sites). This is the Rust
//! snapshot consumed by the kode-mcp config Q&A face (why_setting).
//!
//! Each entry: dotted key path (root/process sections stripped) -> curated
//! zh/en meaning + authoritative file:line provenance (source).

#[derive(Debug)]
pub struct ConfigDoc {
    pub zh: &'static str,
    pub en: &'static str,
    pub source: &'static str,
    pub group: &'static str,
}

pub static SERVER_CONFIG_ITEM_DOCS: &[(&str, ConfigDoc)] = &[
${entries}
];

/// Look up a config item doc by its dotted key path (e.g. "baseapp.archivePeriod").
pub fn find_doc(key: &str) -> Option<&'static ConfigDoc> {
    SERVER_CONFIG_ITEM_DOCS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, d)| d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_keys_resolve_and_keys_are_sorted_unique() {
        // Every key is present, non-empty, and the table is sorted (deterministic
        // generator output); spot-check a few cross-section entries.
        assert!(SERVER_CONFIG_ITEM_DOCS.iter().all(|(k, d)| {
            !k.is_empty() && !d.zh.is_empty() && !d.en.is_empty() && !d.source.is_empty()
        }));
        let keys: Vec<&str> = SERVER_CONFIG_ITEM_DOCS.iter().map(|(k, _)| *k).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "keys must be sorted for deterministic output");
        assert!(SERVER_CONFIG_ITEM_DOCS.len() > 200, "catalog should be sizeable");

        let archive = find_doc("baseapp.archivePeriod").expect("baseapp.archivePeriod present");
        assert!(archive.zh.contains("存档"));
        assert!(archive.source.contains("kbengine_defaults.xml"));
    }
}
`;
}

async function main() {
  const docs = await loadCatalog();
  const generated = emitRust(docs);
  if (checkOnly) {
    const existing = fs.readFileSync(outRust, 'utf8');
    if (existing !== generated) {
      console.error(
        `config_catalog.rs drifted from serverConfigCatalog.ts — run \`node scripts/gen-config-catalog.mjs\`.`
      );
      process.exit(1);
    }
    console.log(`config_catalog.rs in sync (${Object.keys(docs).length} entries)`);
    return;
  }
  fs.writeFileSync(outRust, generated);
  console.log(`wrote ${outRust} (${Object.keys(docs).length} entries)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
