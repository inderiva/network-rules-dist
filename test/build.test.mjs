import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { countRuleEntries, readJson, rootDir, validateRuleSetSafety } from '../scripts/lib.mjs';

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
  assert.ok(route.route.rule_set.every((ruleSet) => ruleSet.url.startsWith('https://raw.githubusercontent.com/inderiva/network-rules-dist/main/')));
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

test('public metadata is neutral', async () => {
  const readme = await readFile(resolve(rootDir, 'README.md'), 'utf8');
  const module = await readFile(resolve(rootDir, 'shadowrocket/NetworkRules.sgmodule'), 'utf8');
  const override = await readFile(resolve(rootDir, 'stash/NetworkRules.stoverride'), 'utf8');
  assert.match(readme, /仓库仅发布公开上游生成的数据，不包含私有覆盖配置/);
  assert.match(module, /#!desc=仅添加广告拒绝规则，不修改直连、代理或最终策略/);
  assert.match(override, /desc: '由公开上游生成的广告拦截与国内直连规则'/);
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
