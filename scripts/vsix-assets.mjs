/** Manifest paths must exist in the ZIP, including assets outside copied directories. */
export function assertRuntimeAssets(manifest, entries) {
  const paths = [
    manifest.main, manifest.icon,
    'out/pythonParserWorker.js', 'out/defParserWorker.js', 'out/buildCommit.json',
    ...['base', 'cell', 'bots', 'client', 'dbmgr', 'interfaces', 'loginapp', 'logger']
      .flatMap(role => ['__init__.pyi', '_module.pyi', 'hooks.pyi']
        .map(file => `typings/${role}/KBEngine/${file}`)),
    'typings/shared/_kbengine_shared/__init__.pyi',
    ...(manifest.contributes?.languages ?? []).map(item => item.configuration),
    ...['grammars', 'snippets', 'themes', 'iconThemes', 'productIconThemes']
      .flatMap(key => (manifest.contributes?.[key] ?? []).map(item => item.path)),
    ...Object.values(manifest.contributes?.viewsContainers ?? {}).flatMap(items => items.map(item => item.icon)),
  ];
  for (const item of paths.filter(Boolean)) {
    const name = `extension/${item.replace(/^\.\//, '')}`;
    if (!entries.has(name)) { throw new Error(`Missing runtime asset: ${name}`); }
  }
}
