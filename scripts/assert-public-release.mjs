import { readFileSync } from 'node:fs';

const targets = JSON.parse(readFileSync(new URL('../src/targets.json', import.meta.url)));
const source = JSON.parse(readFileSync(new URL('../src/rules.json', import.meta.url)));
const expectedActions = ['direct', 'proxy', 'reject'];
const expectedFields = ['domain', 'domain_regex', 'domain_suffix', 'ip_cidr'];

if (targets.generator?.profile !== 'public') {
  throw new Error('Public repository must use the public generator profile');
}

if (Object.keys(source.groups ?? {}).sort().join(',') !== expectedActions.join(',')) {
  throw new Error('Public repository has unexpected custom groups');
}

for (const action of expectedActions) {
  if (Object.keys(source.groups[action] ?? {}).sort().join(',') !== expectedFields.join(',')) {
    throw new Error(`Public repository has unexpected ${action} fields`);
  }
  for (const field of expectedFields) {
    const entries = source.groups[action][field];
    if (!Array.isArray(entries) || entries.length !== 0) {
      throw new Error(`Public repository must have an empty ${action}.${field} custom group`);
    }
  }
}
