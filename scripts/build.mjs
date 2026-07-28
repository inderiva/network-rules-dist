import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  execFileAsync,
  readJson,
  resetDirectory,
  rootDir,
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
    for (const field of [...fields, 'domain_keyword']) output[field].push(...(rule[field] ?? []));
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

function shadowrocketLines(rules, action, proxyPolicy) {
  const target = clientPolicy(action, proxyPolicy);
  return [
    ...rules.domain.map((value) => `DOMAIN,${value},${target}`),
    ...rules.domain_suffix.map((value) => `DOMAIN-SUFFIX,${value},${target}`),
    ...(rules.domain_keyword ?? []).map((value) => `DOMAIN-KEYWORD,${value},${target}`),
    ...rules.ip_cidr.map((value) => `${value.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${value},${target},no-resolve`)
  ];
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
  { ip_is_private: true, outbound: targets.sing_box.direct_outbound },
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
  download_detour: targets.sing_box.direct_outbound,
  update_interval: '1d'
}));
function routeFragment(ruleSets) {
  return {
    route: {
      rule_set: ruleSets,
      rules: routeRules,
      final: targets.sing_box.proxy_outbound,
      auto_detect_interface: true
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
    ],
    final: targets.sing_box.remote_dns_server,
    strategy: 'ipv4_only'
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
  "desc: '公开维护的广告拦截、国内直连和抖音直连规则'",
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
const shadowSections = [
  ['自定义拒绝', shadowrocketLines(custom.groups.reject, 'reject', targets.shadowrocket.proxy_policy)],
  ['抖音等国内服务优先直连', shadowrocketLines(custom.groups.direct, 'direct', targets.shadowrocket.proxy_policy)],
  ['自定义代理', shadowrocketLines(custom.groups.proxy, 'proxy', targets.shadowrocket.proxy_policy)],
  ['广告拒绝', shadowrocketLines(upstream.ads, 'reject', targets.shadowrocket.proxy_policy)],
  ['国内域名直连', shadowrocketLines(upstream.cnDomain, 'direct', targets.shadowrocket.proxy_policy)],
  ['国内 IP 直连', shadowrocketLines(upstream.cnIp, 'direct', targets.shadowrocket.proxy_policy)]
];
const flatRules = shadowSections.flatMap(([title, lines]) => lines.length ? [`# ${title}`, ...lines, ''] : []);
const omittedRegex = actions.reduce((count, action) => count + custom.groups[action].domain_regex.length, 0)
  + upstream.ads.domain_regex.length + upstream.cnDomain.domain_regex.length;
const compatibilityNote = omittedRegex
  ? [`# Shadowrocket 输出省略 ${omittedRegex} 条 DOMAIN-REGEX；sing-box 与 Stash 完整保留。`, '']
  : [];
const list = [...compatibilityNote, ...flatRules].join('\n').trimEnd();
await writeAtomic(resolve(shadowrocketDir, 'NetworkRules.list'), `${list}\n`);
const module = [
  `#!url=${targets.public_base_url}/shadowrocket/NetworkRules.sgmodule`,
  '#!name=Network Rules',
  '#!desc=公开维护的广告拦截、国内直连和抖音直连规则',
  '#!author=inderiva',
  '#!homepage=https://github.com/inderiva/network-rules-dist',
  '',
  '[Rule]',
  list
].join('\n');
await writeAtomic(resolve(shadowrocketDir, 'NetworkRules.sgmodule'), `${module.trimEnd()}\n`);

console.log(`已生成 sing-box ${singRuleSets.length} 个规则集、Stash ${stashProviders.length} 个 provider、Shadowrocket ${flatRules.filter((line) => line && !line.startsWith('#')).length} 条规则`);
