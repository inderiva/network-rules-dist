import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  execFileAsync,
  readJson,
  resetDirectory,
  rootDir,
  ruleValues,
  uniqueSorted,
  writeAtomic,
  writeJson
} from './lib.mjs';
import { ensureSingBox } from './sing-box.mjs';

const fields = ['domain', 'domain_suffix', 'domain_regex', 'ip_cidr'];
const actions = ['reject', 'direct', 'proxy'];

function emptyRules() {
  return Object.fromEntries(fields.map((field) => [field, []]));
}

function flatten(source) {
  const output = { ...emptyRules(), domain_keyword: [] };
  for (const rule of source.rules) {
    for (const field of [...fields, 'domain_keyword']) {
      output[field].push(...ruleValues(rule[field], field));
    }
  }
  for (const field of Object.keys(output)) output[field] = uniqueSorted(output[field]);
  return output;
}

function hasRules(rules) {
  return [...fields, 'domain_keyword'].some((field) => (rules[field]?.length ?? 0) > 0);
}

function validateCustom(source) {
  if (source.version !== 1) throw new Error('src/rules.json version 必须为 1');
  const owners = new Map();
  for (const action of actions) {
    if (!source.groups[action]) throw new Error(`缺少自定义规则组 ${action}`);
    for (const field of fields) {
      if (!Array.isArray(source.groups[action][field])) throw new Error(`${action}.${field} 必须是数组`);
      source.groups[action][field] = uniqueSorted(source.groups[action][field]);
      for (const value of source.groups[action][field]) {
        const key = `${field}:${value}`;
        if (owners.has(key)) throw new Error(`${value} 同时属于 ${owners.get(key)} 和 ${action}`);
        owners.set(key, action);
      }
    }
  }
}

function quoteYaml(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function providerYaml(values) {
  return `payload:\n${values.map((value) => `  - ${quoteYaml(value)}`).join('\n')}\n`;
}

function domainProvider(rules) {
  return uniqueSorted([...rules.domain, ...rules.domain_suffix.map((value) => `+.${value}`)]);
}

function classicalProvider(rules) {
  return uniqueSorted([
    ...rules.domain_regex.map((value) => `DOMAIN-REGEX,${value}`),
    ...(rules.domain_keyword ?? []).map((value) => `DOMAIN-KEYWORD,${value}`)
  ]);
}

function clientPolicy(action, proxyPolicy) {
  return action === 'reject' ? 'REJECT' : action === 'direct' ? 'DIRECT' : proxyPolicy;
}

function shadowrocketDomainSet(rules) {
  return uniqueSorted([
    ...rules.domain,
    ...rules.domain_suffix.map((value) => `.${value}`)
  ]);
}

function shadowrocketRuleSet(rules) {
  return uniqueSorted([
    ...(rules.domain_keyword ?? []).map((value) => `DOMAIN-KEYWORD,${value}`),
    ...rules.ip_cidr.map((value) => `${value.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${value},no-resolve`)
  ]);
}

function shadowrocketProvider(name, type, values) {
  return [
    `# NAME: ${name}`,
    '# REPO: https://github.com/inderiva/network-rules-dist',
    `# TYPE: ${type}`,
    `# TOTAL: ${values.length}`,
    '',
    ...values,
    ''
  ].join('\n');
}

const custom = await readJson(resolve(rootDir, 'src/rules.json'));
const targets = await readJson(resolve(rootDir, 'src/targets.json'));
validateCustom(custom);
const upstream = {
  ads: flatten(await readJson(resolve(rootDir, 'vendor/source/geosite-category-ads-all.json'))),
  cnDomain: flatten(await readJson(resolve(rootDir, 'vendor/source/geosite-cn.json'))),
  cnIp: flatten(await readJson(resolve(rootDir, 'vendor/source/geoip-cn.json')))
};
const singBox = await ensureSingBox();

const singRuleSets = [
  ...actions.filter((action) => hasRules(custom.groups[action])).map((action) => ({
    tag: `custom-${action}`,
    action,
    rules: custom.groups[action]
  })),
  { tag: 'geosite-category-ads-all', action: 'reject', sourceFile: 'geosite-category-ads-all.json' },
  { tag: 'geosite-cn', action: 'direct', sourceFile: 'geosite-cn.json' },
  { tag: 'geoip-cn', action: 'direct', sourceFile: 'geoip-cn.json' }
];

const singBoxDir = resolve(rootDir, 'sing-box');
await resetDirectory(singBoxDir);
const singRulesDir = resolve(singBoxDir, 'rules');
await mkdir(singRulesDir, { recursive: true });
for (const item of singRuleSets) {
  const jsonPath = resolve(singRulesDir, `${item.tag}.json`);
  if (item.sourceFile) await copyFile(resolve(rootDir, 'vendor/source', item.sourceFile), jsonPath);
  else await writeJson(jsonPath, { version: 3, rules: [item.rules] });
  await execFileAsync(singBox, ['rule-set', 'compile', '--output', resolve(singRulesDir, `${item.tag}.srs`), jsonPath]);
}

const routeRules = [
  ...singRuleSets.filter((item) => item.tag.startsWith('custom-')).map((item) => ({
    rule_set: item.tag,
    ...(item.action === 'reject'
      ? { action: 'reject' }
      : { outbound: item.action === 'direct' ? targets.sing_box.direct_outbound : targets.sing_box.proxy_outbound })
  })),
  { rule_set: 'geosite-category-ads-all', action: 'reject' },
  { rule_set: 'geosite-cn', outbound: targets.sing_box.direct_outbound },
  { rule_set: 'geoip-cn', outbound: targets.sing_box.direct_outbound }
];
const localRuleSets = singRuleSets.map((item) => ({
  type: 'local', tag: item.tag, format: 'binary', path: `./rules/${item.tag}.srs`
}));
const remoteRuleSets = singRuleSets.map((item) => ({
  type: 'remote',
  tag: item.tag,
  format: 'binary',
  url: `${targets.public_base_url}/sing-box/rules/${item.tag}.srs`,
  update_interval: '1d'
}));
function routeFragment(ruleSets) {
  return {
    route: {
      rule_set: ruleSets,
      rules: routeRules
    }
  };
}
await writeJson(resolve(singBoxDir, 'route.local.fragment.json'), routeFragment(localRuleSets));
await writeJson(resolve(singBoxDir, 'route.remote.fragment.json'), routeFragment(remoteRuleSets));
await writeJson(resolve(singBoxDir, 'dns.fragment.json'), {
  dns: {
    rules: [
      ...(hasRules(custom.groups.direct) ? [{ rule_set: 'custom-direct', server: targets.sing_box.direct_dns_server }] : []),
      { rule_set: 'geosite-cn', server: targets.sing_box.direct_dns_server }
    ]
  }
});

const stashDir = resolve(rootDir, 'stash');
await resetDirectory(stashDir);
await mkdir(resolve(stashDir, 'rules'), { recursive: true });
const stashProviders = [];
async function addStashProvider(name, behavior, values, action) {
  if (!values.length) return;
  const relative = `rules/${name}.yaml`;
  stashProviders.push({ name, behavior, relative, action });
  await writeAtomic(resolve(stashDir, relative), providerYaml(values));
}
for (const action of actions) {
  await addStashProvider(`custom-${action}-domain`, 'domain', domainProvider(custom.groups[action]), action);
  await addStashProvider(`custom-${action}-ip`, 'ipcidr', custom.groups[action].ip_cidr, action);
  await addStashProvider(`custom-${action}-classical`, 'classical', classicalProvider(custom.groups[action]), action);
}
await addStashProvider('geosite-category-ads-all-domain', 'domain', domainProvider(upstream.ads), 'reject');
await addStashProvider('geosite-category-ads-all-classical', 'classical', classicalProvider(upstream.ads), 'reject');
await addStashProvider('geosite-cn-domain', 'domain', domainProvider(upstream.cnDomain), 'direct');
await addStashProvider('geosite-cn-classical', 'classical', classicalProvider(upstream.cnDomain), 'direct');
await addStashProvider('geoip-cn', 'ipcidr', upstream.cnIp.ip_cidr, 'direct');
const stashOverride = [
  "name: 'Network Rules'",
  "desc: '由公开上游生成的广告拦截与国内直连规则'",
  `homepage: '${targets.public_base_url.replace('raw.githubusercontent.com', 'github.com').replace('/main', '')}'`,
  'rule-providers:',
  ...stashProviders.flatMap(({ name, behavior, relative }) => [
    `  ${name}:`,
    `    behavior: ${behavior}`,
    '    format: yaml',
    `    path: ./rules/network-rules-dist/${name}.yaml`,
    `    url: ${targets.public_base_url}/stash/${relative}`,
    '    interval: 86400'
  ]),
  'rules:',
  ...stashProviders.map(({ name, action }) => `  - RULE-SET,${name},${clientPolicy(action, targets.stash.proxy_policy)}`),
  ''
].join('\n');
await writeAtomic(resolve(stashDir, 'NetworkRules.stoverride'), stashOverride);

const shadowrocketDir = resolve(rootDir, 'shadowrocket');
await resetDirectory(shadowrocketDir);
const shadowrocketRulesDir = resolve(shadowrocketDir, 'rules');
await mkdir(shadowrocketRulesDir, { recursive: true });
const shadowrocketSets = [];
async function addShadowrocketSet(name, type, values, action, section) {
  if (!values.length) return;
  const relative = `rules/${name}.list`;
  shadowrocketSets.push({ name, type, relative, action, section });
  await writeAtomic(
    resolve(shadowrocketDir, relative),
    shadowrocketProvider(name, type === 'DOMAIN-SET' ? 'domain-set' : 'rule-set', values)
  );
}
for (const action of actions) {
  await addShadowrocketSet(
    `custom-${action}-domain`,
    'DOMAIN-SET',
    shadowrocketDomainSet(custom.groups[action]),
    action,
    `自定义${action}`
  );
  await addShadowrocketSet(
    `custom-${action}-rules`,
    'RULE-SET',
    shadowrocketRuleSet(custom.groups[action]),
    action,
    `自定义${action}`
  );
}
await addShadowrocketSet(
  'geosite-category-ads-all-domain',
  'DOMAIN-SET',
  shadowrocketDomainSet(upstream.ads),
  'reject',
  '广告拒绝'
);
await addShadowrocketSet(
  'geosite-category-ads-all-rules',
  'RULE-SET',
  shadowrocketRuleSet(upstream.ads),
  'reject',
  '广告拒绝'
);
await addShadowrocketSet(
  'geosite-cn-domain',
  'DOMAIN-SET',
  shadowrocketDomainSet(upstream.cnDomain),
  'direct',
  '国内直连'
);
await addShadowrocketSet(
  'geosite-cn-rules',
  'RULE-SET',
  shadowrocketRuleSet(upstream.cnDomain),
  'direct',
  '国内直连'
);
await addShadowrocketSet(
  'geoip-cn',
  'RULE-SET',
  shadowrocketRuleSet(upstream.cnIp),
  'direct',
  '国内直连'
);

function shadowrocketReferences(sets) {
  const output = [];
  let previousSection;
  for (const item of sets) {
    if (item.section !== previousSection) {
      if (output.length) output.push('');
      output.push(`# ${item.section}`);
      previousSection = item.section;
    }
    output.push(
      `${item.type},${targets.public_base_url}/shadowrocket/${item.relative},${clientPolicy(item.action, targets.shadowrocket.proxy_policy)}`
    );
  }
  return output;
}

const omittedRegex = actions.reduce((count, action) => count + custom.groups[action].domain_regex.length, 0)
  + upstream.ads.domain_regex.length + upstream.cnDomain.domain_regex.length;
function compatibilityNote(count) {
  return count ? [`# 省略 ${count} 条 Shadowrocket 不兼容的 DOMAIN-REGEX。`, ''] : [];
}

async function writeShadowrocketModule(filename, name, description, sets, omittedRegexCount) {
  const module = [
    `#!url=${targets.public_base_url}/shadowrocket/${filename}`,
    `#!name=${name}`,
    `#!desc=${description}`,
    '#!homepage=https://github.com/inderiva/network-rules-dist',
    '',
    '[Rule]',
    ...compatibilityNote(omittedRegexCount),
    ...shadowrocketReferences(sets),
    ''
  ].join('\n');
  await writeAtomic(resolve(shadowrocketDir, filename), module);
}

const advertisingSets = shadowrocketSets.filter((item) => item.action === 'reject');
const chinaDirectSets = shadowrocketSets.filter((item) => item.name === 'geosite-cn-domain' || item.name === 'geosite-cn-rules' || item.name === 'geoip-cn');
await writeShadowrocketModule(
  'Advertising.sgmodule',
  'Advertising Rules',
  '仅启用公开广告拦截规则',
  advertisingSets,
  custom.groups.reject.domain_regex.length + upstream.ads.domain_regex.length
);
await writeShadowrocketModule(
  'ChinaDirect.sgmodule',
  'China Direct Rules',
  '仅启用国内域名与 IP 直连规则',
  chinaDirectSets,
  upstream.cnDomain.domain_regex.length
);
await writeShadowrocketModule(
  'NetworkRules.sgmodule',
  'Network Rules',
  '轻量引用广告拦截与国内直连规则集',
  shadowrocketSets,
  omittedRegex
);

console.log(`已生成 sing-box ${singRuleSets.length} 个规则集、Stash ${stashProviders.length} 个 provider、Shadowrocket ${shadowrocketSets.length} 个远程规则集`);
