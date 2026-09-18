import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  execFileAsync,
  outputDir,
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

function shadowrocketRuleSet(rules, { resolveIp = false } = {}) {
  return uniqueSorted([
    ...(rules.domain_keyword ?? []).map((value) => `DOMAIN-KEYWORD,${value}`),
    ...rules.ip_cidr.map((value) => `${value.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${value}${resolveIp ? '' : ',no-resolve'}`)
  ]);
}

function shadowrocketProvider(name, type, values, homepage) {
  return [
    `# NAME: ${name}`,
    ...(homepage ? [`# REPO: ${homepage}`] : []),
    `# TYPE: ${type}`,
    `# TOTAL: ${values.length}`,
    '',
    ...values,
    ''
  ].join('\n');
}

function shadowrocketInlineRules(rules, action, proxyPolicy) {
  const target = clientPolicy(action, proxyPolicy);
  return uniqueSorted([
    ...rules.domain.map((value) => `DOMAIN,${value},${target}`),
    ...rules.domain_suffix.map((value) => `DOMAIN-SUFFIX,${value},${target}`),
    ...(rules.domain_keyword ?? []).map((value) => `DOMAIN-KEYWORD,${value},${target}`),
    ...rules.ip_cidr.map((value) => `${value.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${value},${target},no-resolve`)
  ]);
}

const custom = await readJson(resolve(rootDir, 'src/rules.json'));
const targets = await readJson(resolve(rootDir, 'src/targets.json'));
validateCustom(custom);
const profile = targets.generator?.profile ?? 'public';
if (!['public', 'private'].includes(profile)) throw new Error(`不支持的生成配置：${profile}`);
const privateProfile = profile === 'private';
const rulesBaseUrl = (process.env.RULES_BASE_URL || targets.public_base_url || '').replace(/\/$/, '');
if (!privateProfile && !rulesBaseUrl) throw new Error('公共生成配置必须提供 public_base_url');
const homepage = targets.homepage
  || (rulesBaseUrl.includes('raw.githubusercontent.com')
    ? rulesBaseUrl.replace('raw.githubusercontent.com', 'github.com').replace(/\/(?:main|release)$/, '')
    : '');
const stashCacheNamespace = targets.generator?.stash_cache_namespace ?? 'network-rules-v2';
if (!/^[a-zA-Z0-9._-]+$/.test(stashCacheNamespace)) throw new Error('stash_cache_namespace 只能包含字母、数字、点、下划线和连字符');
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

const singBoxDir = resolve(outputDir, 'sing-box');
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
  url: `${rulesBaseUrl}/sing-box/rules/${item.tag}.srs`,
  update_interval: '1d'
}));
function routeFragment(ruleSets, resolveIp = false) {
  return {
    route: {
      rule_set: ruleSets,
      rules: routeRules.flatMap((rule) =>
        resolveIp && rule.rule_set === 'geoip-cn' ? [{ action: 'resolve' }, rule] : [rule]
      )
    }
  };
}
await writeJson(resolve(singBoxDir, 'route.local.fragment.json'), routeFragment(localRuleSets));
if (rulesBaseUrl) await writeJson(resolve(singBoxDir, 'route.remote.fragment.json'), routeFragment(remoteRuleSets));
await writeJson(resolve(singBoxDir, 'route.resolve.local.fragment.json'), routeFragment(localRuleSets, true));
if (rulesBaseUrl) await writeJson(resolve(singBoxDir, 'route.resolve.remote.fragment.json'), routeFragment(remoteRuleSets, true));
await writeJson(resolve(singBoxDir, 'dns.fragment.json'), {
  dns: {
    rules: [
      ...(hasRules(custom.groups.direct) ? [{ rule_set: 'custom-direct', server: targets.sing_box.direct_dns_server }] : []),
      { rule_set: 'geosite-cn', server: targets.sing_box.direct_dns_server }
    ]
  }
});

const stashDir = resolve(outputDir, 'stash');
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
const stashOverrideProviders = stashProviders.filter(({ name }) =>
  name.startsWith('geosite-category-ads-all-') || (privateProfile && name.startsWith('custom-'))
);
function stashOverride(providers, chinaDirect = false) {
  return [
    chinaDirect ? "name: 'Network Rules - China Direct'" : "name: 'Network Rules'",
    chinaDirect
      ? `desc: '${privateProfile ? '私有例外、' : ''}广告拦截和国内直连；其他流量沿用主配置'`
      : privateProfile
        ? "desc: '私有覆盖与广告拦截，不修改通用国内直连策略'"
        : "desc: '仅添加广告拦截，不修改直连、代理或最终策略'",
    ...(homepage ? [`homepage: '${homepage}'`] : []),
    'rule-providers:',
    ...providers.flatMap(({ name, behavior, relative }) => [
      `  ${name}:`,
      `    behavior: ${behavior}`,
      '    format: yaml',
      `    path: ${rulesBaseUrl ? `./rules/${stashCacheNamespace}/${name}.yaml` : `./${relative}`}`,
      ...(rulesBaseUrl ? [`    url: ${rulesBaseUrl}/stash/${relative}`] : []),
      '    interval: 86400'
    ]),
    'rules:',
    ...providers.map(({ name, action }) => `  - RULE-SET,${name},${clientPolicy(action, targets.stash.proxy_policy)}`),
    ''
  ].join('\n');
}
await writeAtomic(resolve(stashDir, 'NetworkRules.stoverride'), stashOverride(stashOverrideProviders));
await writeAtomic(resolve(stashDir, 'NetworkRules-ChinaDirect.stoverride'), stashOverride(
  stashProviders.filter(({ name }) => privateProfile || !name.startsWith('custom-')), true
));
await writeAtomic(resolve(stashDir, 'USAGE.md'), `# Stash

选择一个覆写文件启用：

- \`NetworkRules.stoverride\`：${privateProfile ? '私有例外和广告拦截' : '广告拦截'}，国内分流由主配置负责。
- \`NetworkRules-ChinaDirect.stoverride\`：${privateProfile ? '私有例外、' : ''}广告拦截、国内域名和国内 IP 直连；其余流量沿用主配置的最终策略。国内 IP 规则会在需要时触发 DNS 解析。

两个文件二选一。Stash 会把覆写的规则插到主配置规则前面；如果主配置已有必须优先代理的特殊域名，应先核对顺序。节点、DNS 和最终策略继续由主配置维护。${rulesBaseUrl ? '' : '\n\n本地导入请保留整个 stash 目录及 rules 子目录；只导入覆写文件不足以加载本地规则。'}
`);

const shadowrocketDir = resolve(outputDir, 'shadowrocket');
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
    shadowrocketProvider(name, type === 'DOMAIN-SET' ? 'domain-set' : 'rule-set', values, homepage)
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
  shadowrocketRuleSet(upstream.cnIp, { resolveIp: true }),
  'direct',
  '国内直连'
);

const shadowrocketModuleSections = [
  ...(privateProfile ? actions.map((action) => ({
    title: `自定义${action}`,
    rules: shadowrocketInlineRules(custom.groups[action], action, targets.shadowrocket.proxy_policy)
  })) : []),
  { title: '广告拒绝', rules: shadowrocketInlineRules(upstream.ads, 'reject', targets.shadowrocket.proxy_policy) }
].filter(({ rules }) => rules.length);
const omittedRegex = upstream.ads.domain_regex.length
  + (privateProfile ? actions.reduce((count, action) => count + custom.groups[action].domain_regex.length, 0) : 0);
const shadowrocketModule = [
  ...(rulesBaseUrl ? [`#!url=${rulesBaseUrl}/shadowrocket/NetworkRules.sgmodule`] : []),
  privateProfile ? '#!name=Network Rules (Private Overlay)' : '#!name=Network Rules (Ads Only)',
  privateProfile
    ? '#!desc=添加私有覆盖与广告拒绝，不加载通用国内直连规则'
    : '#!desc=仅添加广告拒绝规则，不修改直连、代理或最终策略',
  ...(homepage ? [`#!homepage=${homepage}`] : []),
  '',
  '[Rule]',
  ...(omittedRegex ? [`# 省略 ${omittedRegex} 条 Shadowrocket 不兼容的 DOMAIN-REGEX。`, ''] : []),
  ...shadowrocketModuleSections.flatMap(({ title, rules }) => [`# ${title}`, ...rules, '']),
  ''
].join('\n');
await writeAtomic(resolve(shadowrocketDir, 'NetworkRules.sgmodule'), `${shadowrocketModule.trimEnd()}\n`);

if (!privateProfile) {
  const shadowrocketMainConfig = [
  '# Network Rules - Shadowrocket main configuration',
  '# Public rules only; nodes remain managed by Shadowrocket.',
  '',
  '[General]',
  `update-url = ${rulesBaseUrl}/shadowrocket/NetworkRules.conf`,
  'skip-proxy = 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,localhost,*.local,captive.apple.com',
  'tun-excluded-routes = 10.0.0.0/8,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.168.0.0/16,224.0.0.0/4,255.255.255.255/32,ff02::fb/128',
  'dns-server = https://doh.pub/dns-query,https://dns.alidns.com/dns-query,223.5.5.5,119.29.29.29',
  'fallback-dns-server = system',
  'ipv6 = false',
  'prefer-ipv6 = false',
  'dns-direct-system = false',
  'private-ip-answer = true',
  'dns-direct-fallback-proxy = true',
  'icmp-auto-reply = true',
  'hijack-dns = 8.8.8.8:53,8.8.4.4:53',
  'udp-policy-not-supported-behaviour = REJECT',
  'block-quic = all-proxy',
  '',
  '[Rule]',
  '# Advertising must be rejected before China direct rules.',
  `DOMAIN-SET,${rulesBaseUrl}/shadowrocket/rules/geosite-category-ads-all-domain.list,REJECT`,
  '',
  '# Local networks.',
  'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
  'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
  'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
  'IP-CIDR6,::1/128,DIRECT,no-resolve',
  'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
  'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
  '',
  '# China direct; everything else uses the selected proxy node.',
  `DOMAIN-SET,${rulesBaseUrl}/shadowrocket/rules/geosite-cn-domain.list,DIRECT`,
  `RULE-SET,${rulesBaseUrl}/shadowrocket/rules/geoip-cn.list,DIRECT`,
  'FINAL,PROXY,dns-failed',
  ''
  ].join('\n');
  await writeAtomic(resolve(shadowrocketDir, 'NetworkRules.conf'), shadowrocketMainConfig);
}

await writeAtomic(resolve(shadowrocketDir, 'USAGE.md'), `# Shadowrocket

${privateProfile ? '本仓库的 `NetworkRules.sgmodule` 只提供私有例外和广告拦截；国内分流需由已启用的主配置负责。可配合公开仓库的 `shadowrocket/NetworkRules.conf` 使用。' : '`NetworkRules.conf` 是国内直连、其余代理的主配置；`NetworkRules.sgmodule` 只是广告模块，不能替代主配置。'}

使用主配置时，把全局路由设为“配置”。国内 IP 清单允许为未收录域名解析 IP；局域网和私有 IP 例外仍使用 no-resolve。公开主配置的最终代理规则带 dns-failed，使本地解析失败的域名仍可交给代理。原生行为需要在 Shadowrocket 中复核。
`);
await writeAtomic(resolve(singBoxDir, 'USAGE.md'), `# sing-box

路由片段二选一，不要把两份 rules 数组叠加：

- \`route.local.fragment.json\`${rulesBaseUrl ? ' / `route.remote.fragment.json`' : ''}：保持原有行为。国内域名直连；国内 IP 规则只匹配已有的目标 IP。仅传域名、且主配置未提前解析时，未收录域名继续走主配置的默认出口。
- \`route.resolve.local.fragment.json\`${rulesBaseUrl ? ' / `route.resolve.remote.fragment.json`' : ''}：在国内 IP 规则前使用主配置的 DNS 路由解析目标，补上未收录国内域名的 IP 分流。sing-box 1.13.4 解析失败会断开请求，不能自动继续走代理；需要可靠的 DNS。

保留原有主配置的 final、DNS 服务器和入站。将所选片段的规则放在主配置兜底规则之前，规则集定义合并到 route.rule_set；有明确代理例外时，应放在通用国内直连规则前面。按需合并 dns.fragment.json，其中引用的 ${targets.sing_box.direct_dns_server} 必须已在主配置定义。单独合并 DNS 片段不会替仅传域名的代理请求预先解析 IP。

规则引用使用本地路径时，同时复制 rules 目录；远程版本需要能访问其下载地址。
`);

console.log(`已生成 ${profile} 配置：sing-box ${singRuleSets.length} 个规则集、Stash ${stashOverrideProviders.length} 个默认 provider、Shadowrocket ${shadowrocketSets.length} 个规则集`);
