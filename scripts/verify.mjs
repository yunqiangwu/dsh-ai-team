// Pre-publish verification: keeps package.json and cordis.patch.yml in sync.
//   node scripts/verify.mjs

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');

const errors = [];

// 1. name consistency between package.json and the bundle patch row.
const m = patch.match(/name:\s*['"]?([^'"\n]+)['"]?/);
if (m && m[1].trim() !== pkg.name) {
  errors.push(`cordis.patch.yml name "${m[1].trim()}" != package.json name "${pkg.name}"`);
}

// 2. bundle patch must be declared.
if (!pkg.dsh?.bundle?.patch) errors.push('package.json dsh.bundle.patch is missing');

// 3. client manifest must be declared for the browser half.
if (!pkg.dsh?.client?.platform) errors.push('package.json dsh.client.platform is missing');

// 4. exports must expose host + client entries.
if (!pkg.exports?.['.']) errors.push('package.json exports["."] is missing');
if (!pkg.exports?.['./client']) errors.push('package.json exports["./client"] is missing');

// 5. required named metadata fields are present (informational, not loadable here).
for (const f of ['main', 'types']) {
  if (!pkg[f]) errors.push(`package.json "${f}" is missing`);
}

if (errors.length) {
  console.error('❌ verification failed:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('✅ verification passed: package.json and cordis.patch.yml are consistent.');
