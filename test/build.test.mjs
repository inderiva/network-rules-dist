import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { readJson, rootDir } from '../scripts/lib.mjs';

test('public custom source is restricted to reviewed suffixes', async () => {
  const source = await readJson(resolve(rootDir, 'src/rules.json'));
  assert.deepEqual(source.groups.direct.domain_suffix, [
    'amemv.com',
    'byteimg.com',
    'douyincdn.com',
    'douyinpic.com',
    'douyinvod.com',
    'iesdouyin.com',
    'pstatp.com',
    'snssdk.com'
  ]);
  assert.deepEqual(source.groups.direct.ip_cidr, []);
});

test('ads are evaluated before China direct rules', async () => {
  const route = await readJson(resolve(rootDir, 'sing-box/route.local.fragment.json'));
  const names = route.route.rules.map((rule) => rule.rule_set).filter(Boolean);
  assert.ok(names.indexOf('geosite-category-ads-all') < names.indexOf('geosite-cn'));
});

test('all clients contain the Douyin direct exception', async () => {
  const shadowrocket = await readFile(resolve(rootDir, 'shadowrocket/NetworkRules.sgmodule'), 'utf8');
  const stash = await readFile(resolve(rootDir, 'stash/rules/custom-direct-domain.yaml'), 'utf8');
  const singBox = await readJson(resolve(rootDir, 'sing-box/rules/custom-direct.json'));
  assert.match(shadowrocket, /DOMAIN-SUFFIX,douyinvod\.com,DIRECT/);
  assert.match(stash, /\+\.douyinvod\.com/);
  assert.ok(singBox.rules[0].domain_suffix.includes('douyinvod.com'));
});

test('remote sing-box rules use stable public URLs', async () => {
  const route = await readJson(resolve(rootDir, 'sing-box/route.remote.fragment.json'));
  assert.ok(route.route.rule_set.every((ruleSet) => ruleSet.type === 'remote'));
  assert.ok(route.route.rule_set.every((ruleSet) => ruleSet.url.startsWith('https://raw.githubusercontent.com/inderiva/network-rules-dist/main/')));
});

test('Shadowrocket output contains no DOMAIN-REGEX entries', async () => {
  const module = await readFile(resolve(rootDir, 'shadowrocket/NetworkRules.sgmodule'), 'utf8');
  assert.doesNotMatch(module, /^DOMAIN-REGEX,/m);
  assert.match(module, /省略 \d+ 条 DOMAIN-REGEX/);
});
