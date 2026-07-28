import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileAsync, readJson, rootDir, writeJson } from './lib.mjs';
import { ensureSingBox } from './sing-box.mjs';

const required = [
  'shadowrocket/NetworkRules.sgmodule',
  'stash/NetworkRules.stoverride',
  'sing-box/route.local.fragment.json',
  'sing-box/route.remote.fragment.json',
  'sing-box/rules/geosite-cn.srs',
  'sing-box/rules/geosite-category-ads-all.srs',
  'sing-box/rules/geoip-cn.srs'
];
for (const path of required) await readFile(resolve(rootDir, path));

const publicCustom = await readJson(resolve(rootDir, 'src/rules.json'));
const allowedPublicSuffixes = [
  'amemv.com',
  'byteimg.com',
  'douyincdn.com',
  'douyinpic.com',
  'douyinvod.com',
  'iesdouyin.com',
  'pstatp.com',
  'snssdk.com'
];
if (JSON.stringify(publicCustom.groups.direct.domain_suffix) !== JSON.stringify(allowedPublicSuffixes)) {
  throw new Error('公开自定义后缀不在审核白名单中');
}
for (const action of ['reject', 'direct', 'proxy']) {
  for (const field of ['domain', 'domain_regex', 'ip_cidr']) {
    if (publicCustom.groups[action][field].length) throw new Error(`公开源 ${action}.${field} 必须经过单独审核`);
  }
}
if (publicCustom.groups.reject.domain_suffix.length || publicCustom.groups.proxy.domain_suffix.length) {
  throw new Error('公开 reject/proxy 自定义后缀必须经过单独审核');
}

const targets = await readJson(resolve(rootDir, 'src/targets.json'));
const route = await readJson(resolve(rootDir, 'sing-box/route.local.fragment.json'));
const tags = route.route.rule_set.map(({ tag }) => tag);
if (tags.includes('geosite-geolocation-cn')) throw new Error('仍包含重复的 geosite-geolocation-cn');
const adsIndex = route.route.rules.findIndex((rule) => rule.rule_set === 'geosite-category-ads-all');
const cnIndex = route.route.rules.findIndex((rule) => rule.rule_set === 'geosite-cn');
if (adsIndex < 0 || cnIndex < 0 || adsIndex >= cnIndex) throw new Error('广告规则必须位于国内直连规则之前');

const checkDirectory = await mkdtemp(join(tmpdir(), 'network-rules-dist-check-'));
try {
  const checkRoute = structuredClone(route.route);
  for (const ruleSet of checkRoute.rule_set) ruleSet.path = resolve(rootDir, 'sing-box', ruleSet.path);
  const configPath = resolve(checkDirectory, 'config.json');
  await writeJson(configPath, {
    log: { disabled: true },
    outbounds: [
      { type: 'direct', tag: targets.sing_box.direct_outbound },
      { type: 'direct', tag: targets.sing_box.proxy_outbound }
    ],
    route: checkRoute
  });
  await execFileAsync(await ensureSingBox(), ['check', '--config', configPath]);
} finally {
  await rm(checkDirectory, { recursive: true, force: true });
}

const shadowrocket = await readFile(resolve(rootDir, 'shadowrocket/NetworkRules.sgmodule'), 'utf8');
if (!shadowrocket.includes(`${targets.public_base_url}/shadowrocket/NetworkRules.sgmodule`)) throw new Error('Shadowrocket 缺少公开更新 URL');
if (!shadowrocket.includes('DOMAIN-SUFFIX,douyinvod.com,DIRECT')) throw new Error('Shadowrocket 缺少抖音直连规则');
if (/^DOMAIN-REGEX,/m.test(shadowrocket)) throw new Error('Shadowrocket 包含不兼容的 DOMAIN-REGEX');

const stash = await readFile(resolve(rootDir, 'stash/NetworkRules.stoverride'), 'utf8');
if (!stash.includes('behavior: domain') || !stash.includes('behavior: ipcidr')) throw new Error('Stash 未使用优化 provider');
if (!stash.includes(`${targets.public_base_url}/stash/rules/`)) throw new Error('Stash provider 缺少公开 URL');
if (stash.indexOf('geosite-category-ads-all-domain') >= stash.lastIndexOf('geosite-cn-domain')) throw new Error('Stash 规则顺序错误');

const manifest = await readJson(resolve(rootDir, 'vendor/manifest.json'));
const counts = Object.fromEntries(manifest.sources.map((source) => [source.tag, source.entries]));
if (counts['geosite-cn'] < 1000 || counts['geosite-category-ads-all'] < 500 || counts['geoip-cn'] < 5500) {
  throw new Error('上游规则数量低于安全阈值');
}
console.log('检查通过：无内部信息、规则顺序正确、公开 URL 完整、sing-box 配置有效');
