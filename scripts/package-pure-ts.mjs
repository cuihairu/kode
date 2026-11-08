import { packageVsix, run } from './vsix-staging.mjs';

const output = packageVsix({ pureTS: true });
run(process.execPath, ['scripts/verify-pure-ts-vsix.mjs', output]);
