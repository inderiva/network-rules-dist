import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  countRuleEntries,
  readJson,
  rootDir,
  validateCountSafety,
  validateRuleSetSafety
} from '../scripts/lib.mjs';

test('public custom source contains no product-specific overrides', async () => {
  const source = await readJson(resolve(rootDir, 'src/rules.json'));
  for (const group of Object.values(source.groups)) {
    for (const values of Object.values(group)) assert.deepEqual(values, []);
  }
});

test('ads are evaluated before China direct rules outside the safe Shadowrocket module', async () => {
  const route = await readJson(resolve(rootDir, 'sing-box/route.local.fragment.json'));
  const names = route.route.rules.map((rule) => rule.rule_set).filter(Boolean);
  assert.ok(names.indexOf('geosite-category-ads-all') < names.indexOf('geosite-cn'));
});

test('a scalar source regex is counted and emitted as one complete rule', async () => {
  assert.equal(countRuleEntries({ rules: [{ domain_regex: '^example\\.com$' }] }), 1);
  const provider = await readFile(resolve(rootDir, 'stash/rules/geosite-category-ads-all-classical.yaml'), 'utf8');
  const regexRules = provider.split('\n').filter((line) => line.includes('DOMAIN-REGEX,'));
  assert.equal(regexRules.length, 1);
  assert.match(regexRules[0], /\^speed\\\.\(coe\|open\)/);
  assert.notEqual(regexRules[0], "  - 'DOMAIN-REGEX,.'");
});

test('remote sing-box rules use stable public URLs', async () => {
  const route = await readJson(resolve(rootDir, 'sing-box/route.remote.fragment.json'));
  assert.ok(route.route.rule_set.every((ruleSet) => ruleSet.type === 'remote'));
  assert.ok(route.route.rule_set.every((ruleSet) => ruleSet.url.startsWith('https://raw.githubusercontent.com/inderiva/network-rules-dist/release/')));
});

test('Shadowrocket module is a self-contained advertising-only module', async () => {
  const module = await readFile(resolve(rootDir, 'shadowrocket/NetworkRules.sgmodule'), 'utf8');
  assert.doesNotMatch(module, /^DOMAIN-REGEX,/m);
  assert.doesNotMatch(module, /^(DOMAIN-SET|RULE-SET),/m);
  assert.match(module, /省略 \d+ 条 Shadowrocket 不兼容的 DOMAIN-REGEX/);
  assert.match(module, /^DOMAIN,p3-ad-sign\.byteimg\.com,REJECT$/m);
  assert.match(module, /^DOMAIN-SUFFIX,doubleclick\.net,REJECT$/m);
  assert.ok(Buffer.byteLength(module) < 100000);
});

test('default Shadowrocket module never overrides the existing routing policy', async () => {
  const module = await readFile(resolve(rootDir, 'shadowrocket/NetworkRules.sgmodule'), 'utf8');
  assert.doesNotMatch(module, /,DIRECT(?:,|$)/m);
  assert.doesNotMatch(module, /^(DOMAIN-SET|RULE-SET),/m);
  assert.doesNotMatch(module, /geosite-cn|geoip-cn/);
  for (const line of module.split('\n').filter((value) => /^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|IP-CIDR|IP-CIDR6),/.test(value))) {
    assert.match(line, /,REJECT$/);
  }
});

test('Shadowrocket main config mirrors the sing-box direct-China final-proxy model', async () => {
  const config = await readFile(resolve(rootDir, 'shadowrocket/NetworkRules.conf'), 'utf8');
  const ads = config.indexOf('/geosite-category-ads-all-domain.list,REJECT');
  const cn = config.indexOf('/geosite-cn-domain.list,DIRECT');
  const geoip = config.indexOf('/geoip-cn.list,DIRECT');
  const final = config.indexOf('FINAL,PROXY');
  assert.ok(ads >= 0 && ads < cn && cn < geoip && geoip < final);
  assert.equal((config.match(/^FINAL,/gm) ?? []).length, 1);
  assert.doesNotMatch(config, /FINAL,DIRECT/);
  assert.match(config, /^dns-server = https:\/\/doh\.pub\/dns-query,https:\/\/dns\.alidns\.com\/dns-query/m);
  assert.match(config, /^block-quic = all-proxy$/m);
});

test('public Shadowrocket main config contains no private environment details', async () => {
  const config = await readFile(resolve(rootDir, 'shadowrocket/NetworkRules.conf'), 'utf8');
  assert.doesNotMatch(config, /192\.168\.0\.\d{1,3}(?!\/)|\.(?:internal|local|test)\./i);
});

test('Shadowrocket providers use native domain-set and rule-set formats', async () => {
  const ads = await readFile(resolve(rootDir, 'shadowrocket/rules/geosite-category-ads-all-domain.list'), 'utf8');
  const cn = await readFile(resolve(rootDir, 'shadowrocket/rules/geosite-cn-domain.list'), 'utf8');
  const ip = await readFile(resolve(rootDir, 'shadowrocket/rules/geoip-cn.list'), 'utf8');
  assert.match(ads, /^p3-ad-sign\.byteimg\.com$/m);
  assert.match(cn, /^p3-ad-sign\.byteimg\.com$/m);
  assert.match(cn, /^\.cn$/m);
  assert.match(ip, /^IP-CIDR,.*no-resolve$/m);
  assert.match(ip, /^IP-CIDR6,.*no-resolve$/m);
  assert.doesNotMatch(ads, /,REJECT$/m);
  assert.doesNotMatch(cn, /,DIRECT$/m);
});

test('public README stays empty and generated metadata remains neutral', async () => {
  const readme = await readFile(resolve(rootDir, 'README.md'), 'utf8');
  const config = await readFile(resolve(rootDir, 'shadowrocket/NetworkRules.conf'), 'utf8');
  const module = await readFile(resolve(rootDir, 'shadowrocket/NetworkRules.sgmodule'), 'utf8');
  const override = await readFile(resolve(rootDir, 'stash/NetworkRules.stoverride'), 'utf8');
  assert.equal(readme, '');
  assert.match(module, /#!desc=仅添加广告拒绝规则，不修改直连、代理或最终策略/);
  assert.match(config, /Public rules only; nodes remain managed by Shadowrocket/);
  assert.match(override, /desc: '仅添加广告拦截，不修改直连、代理或最终策略'/);
});

test('automated updates report exact dispatched validation before merging', async () => {
  const updateWorkflow = await readFile(resolve(rootDir, '.github/workflows/update.yml'), 'utf8');
  const validateWorkflow = await readFile(resolve(rootDir, '.github/workflows/validate.yml'), 'utf8');
  assert.match(updateWorkflow, /actions: write/);
  assert.match(updateWorkflow, /statuses: write/);
  assert.match(updateWorkflow, /gh workflow run validate\.yml --ref "\$branch"/);
  assert.match(updateWorkflow, /--json databaseId,headSha/);
  assert.match(updateWorkflow, /select\(\.headSha == \\"\$head_sha\\"\)/);
  assert.match(updateWorkflow, /--event workflow_dispatch/);
  assert.match(updateWorkflow, /gh run watch "\$run_id" --exit-status/);
  assert.match(updateWorkflow, /gh pr merge "\$pr_number" --squash --delete-branch/);
  const validation = updateWorkflow.indexOf('gh run watch "$run_id" --exit-status');
  const status = updateWorkflow.indexOf('"repos/$GITHUB_REPOSITORY/statuses/$head_sha"');
  const merge = updateWorkflow.indexOf('gh pr merge "$pr_number" --squash --delete-branch');
  assert.ok(validation >= 0 && validation < status && status < merge);
  assert.doesNotMatch(validateWorkflow, /gh pr checks|merge-automated-update/);
});

test('Stash default override is advertising-only and uses a fresh cache namespace', async () => {
  const override = await readFile(resolve(rootDir, 'stash/NetworkRules.stoverride'), 'utf8');
  const rules = override.split('\n').filter((line) => line.trimStart().startsWith('- RULE-SET,'));
  assert.ok(rules.length > 0);
  assert.ok(rules.every((line) => /geosite-category-ads-all-.*?,REJECT$/.test(line)));
  assert.doesNotMatch(override, /geosite-cn|geoip-cn|,DIRECT$|,PROXY$/m);
  assert.match(override, /path: \.\/rules\/network-rules-dist-v2\//);
  assert.match(override, /\/network-rules-dist\/release\/stash\/rules\//);
});

test('sing-box fragments do not replace unrelated host policy', async () => {
  const route = await readJson(resolve(rootDir, 'sing-box/route.remote.fragment.json'));
  const dns = await readJson(resolve(rootDir, 'sing-box/dns.fragment.json'));
  assert.equal('final' in route.route, false);
  assert.equal('auto_detect_interface' in route.route, false);
  assert.equal(route.route.rules.some((rule) => rule.ip_is_private === true), false);
  assert.equal(route.route.rule_set.some((ruleSet) => 'download_detour' in ruleSet), false);
  assert.equal('final' in dns.dns, false);
  assert.equal('strategy' in dns.dns, false);
});

test('upstream safety guard rejects broad or suddenly changed data', () => {
  const base = {
    allowedFields: ['domain_suffix'],
    minimumEntries: 1,
    maximumEntries: 10,
    maximumChangeRatio: 0.25,
    rejectSingleLabelSuffix: true
  };
  assert.throws(() => validateRuleSetSafety(
    { rules: [{ domain_suffix: 'com' }] },
    { ...base, tag: 'ads' }
  ), /高风险顶级后缀/);
  assert.throws(() => validateRuleSetSafety(
    { rules: [{ domain_regex: '^.*' }] },
    { ...base, tag: 'ads', allowedFields: ['domain_regex'], rejectUniversalRegex: true }
  ), /疑似全匹配正则/);
  assert.throws(() => validateRuleSetSafety(
    { rules: [{ domain_suffix: ['a.example', 'b.example'] }] },
    { ...base, tag: 'ads', previousEntries: 1 }
  ), /超过安全阈值/);
  assert.throws(() => validateRuleSetSafety(
    { rules: [{ ip_cidr: '0.0.0.0\/0' }] },
    { ...base, tag: 'geoip', allowedFields: ['ip_cidr'], rejectSingleLabelSuffix: false }
  ), /全网 CIDR/);
});

test('geoip family safety accepts the trusted-transit update and rejects unsafe counts', async () => {
  const geoip = (await readJson(resolve(rootDir, 'src/upstreams.json'))).rule_sets.geoip_cn;
  const options = {
    tag: 'geoip-cn IPv6',
    minimum: geoip.minimum_ipv6,
    maximum: geoip.maximum_ipv6,
    previous: 1606,
    maximumChangeRatio: geoip.maximum_change_ratio
  };
  assert.equal(validateCountSafety(1234, options), 1234);
  assert.throws(() => validateCountSafety(999, options), /超出安全范围/);
  assert.throws(() => validateCountSafety(3001, options), /超出安全范围/);
  assert.throws(() => validateCountSafety(1200, options), /相对上次变化/);
});
