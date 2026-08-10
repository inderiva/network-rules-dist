import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileAsync, outputDir, readJson, rootDir, writeJson } from './lib.mjs';
import { ensureSingBox } from './sing-box.mjs';

const targets = await readJson(resolve(rootDir, 'src/targets.json'));
const upstreams = await readJson(resolve(rootDir, 'src/upstreams.json'));
const profile = targets.generator?.profile ?? 'public';
const privateProfile = profile === 'private';
const rulesBaseUrl = (process.env.RULES_BASE_URL || targets.public_base_url || '').replace(/\/$/, '');
const required = [
  'shadowrocket/NetworkRules.sgmodule',
  'shadowrocket/rules/geosite-category-ads-all-domain.list',
  'shadowrocket/rules/geosite-cn-domain.list',
  'shadowrocket/rules/geoip-cn.list',
  'stash/NetworkRules.stoverride',
  'sing-box/route.local.fragment.json',
  'sing-box/rules/geosite-cn.srs',
  'sing-box/rules/geosite-category-ads-all.srs',
  'sing-box/rules/geoip-cn.srs'
];
if (!privateProfile) required.push('shadowrocket/NetworkRules.conf', 'sing-box/route.remote.fragment.json');
for (const path of required) await readFile(resolve(outputDir, path));

const publicCustom = await readJson(resolve(rootDir, 'src/rules.json'));
if (!privateProfile) {
  for (const action of ['reject', 'direct', 'proxy']) {
    for (const field of ['domain', 'domain_suffix', 'domain_regex', 'ip_cidr']) {
      if (publicCustom.groups[action][field].length) throw new Error(`公开源不允许产品专用规则：${action}.${field}`);
    }
  }
}

const route = await readJson(resolve(outputDir, 'sing-box/route.local.fragment.json'));
const tags = route.route.rule_set.map(({ tag }) => tag);
if (tags.includes('geosite-geolocation-cn')) throw new Error('仍包含重复的 geosite-geolocation-cn');
const adsIndex = route.route.rules.findIndex((rule) => rule.rule_set === 'geosite-category-ads-all');
const cnIndex = route.route.rules.findIndex((rule) => rule.rule_set === 'geosite-cn');
if (adsIndex < 0 || cnIndex < 0 || adsIndex >= cnIndex) throw new Error('广告规则必须位于国内直连规则之前');

const checkDirectory = await mkdtemp(join(tmpdir(), 'network-rules-dist-check-'));
try {
  const checkRoute = structuredClone(route.route);
  for (const ruleSet of checkRoute.rule_set) ruleSet.path = resolve(outputDir, 'sing-box', ruleSet.path);
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

const shadowrocket = await readFile(resolve(outputDir, 'shadowrocket/NetworkRules.sgmodule'), 'utf8');
if (rulesBaseUrl && !shadowrocket.includes(`${rulesBaseUrl}/shadowrocket/NetworkRules.sgmodule`)) throw new Error('Shadowrocket 缺少更新 URL');
if (/^DOMAIN-REGEX,/m.test(shadowrocket)) throw new Error('Shadowrocket 包含不兼容的 DOMAIN-REGEX');
if (/^(DOMAIN-SET|RULE-SET),/m.test(shadowrocket)) throw new Error('Shadowrocket 默认模块不应嵌套远程规则集');
const inlineShadowrocketRules = shadowrocket.split('\n').filter((line) => /^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|IP-CIDR|IP-CIDR6),/.test(line));
if (!inlineShadowrocketRules.length) throw new Error('Shadowrocket 默认模块没有规则');
if (!privateProfile && inlineShadowrocketRules.some((line) => !/,REJECT(?:,no-resolve)?$/.test(line))) {
  throw new Error('Shadowrocket 默认模块必须只包含广告拒绝规则');
}
if (/geosite-cn|geoip-cn/.test(shadowrocket)) throw new Error('Shadowrocket 默认模块不应加载通用国内直连规则');
if (Buffer.byteLength(shadowrocket) > 100000) throw new Error('Shadowrocket 默认模块体积异常');
if (!privateProfile) {
  const shadowrocketConfig = await readFile(resolve(outputDir, 'shadowrocket/NetworkRules.conf'), 'utf8');
  const configAdsIndex = shadowrocketConfig.indexOf('/geosite-category-ads-all-domain.list,REJECT');
  const configCnIndex = shadowrocketConfig.indexOf('/geosite-cn-domain.list,DIRECT');
  const configGeoipIndex = shadowrocketConfig.indexOf('/geoip-cn.list,DIRECT');
  const configFinalIndex = shadowrocketConfig.indexOf('FINAL,PROXY');
  if (configAdsIndex < 0 || configCnIndex < 0 || configGeoipIndex < 0 || configFinalIndex < 0
    || !(configAdsIndex < configCnIndex && configCnIndex < configGeoipIndex && configGeoipIndex < configFinalIndex)) {
    throw new Error('Shadowrocket 主配置路由顺序错误');
  }
  if (/FINAL,DIRECT/.test(shadowrocketConfig) || (shadowrocketConfig.match(/^FINAL,/gm) ?? []).length !== 1) {
    throw new Error('Shadowrocket 主配置必须唯一使用 FINAL,PROXY');
  }
  if (/192\.168\.0\.\d{1,3}(?!\/)|\.(?:internal|local|test)\./i.test(shadowrocketConfig)) {
    throw new Error('Shadowrocket 公开主配置包含私有环境信息');
  }
}
const shadowrocketAds = await readFile(resolve(outputDir, 'shadowrocket/rules/geosite-category-ads-all-domain.list'), 'utf8');
const shadowrocketCn = await readFile(resolve(outputDir, 'shadowrocket/rules/geosite-cn-domain.list'), 'utf8');
const shadowrocketIp = await readFile(resolve(outputDir, 'shadowrocket/rules/geoip-cn.list'), 'utf8');
if (!shadowrocketAds.includes('p3-ad-sign.byteimg.com') || !shadowrocketCn.includes('p3-ad-sign.byteimg.com')) {
  throw new Error('Shadowrocket domain-set 缺少重叠规则哨兵');
}
if (!/^IP-CIDR,.*no-resolve$/m.test(shadowrocketIp) || !/^IP-CIDR6,.*no-resolve$/m.test(shadowrocketIp)) {
  throw new Error('Shadowrocket IP rule-set 格式错误');
}

const stash = await readFile(resolve(outputDir, 'stash/NetworkRules.stoverride'), 'utf8');
if (!stash.includes('behavior: domain')) throw new Error('Stash 未使用 domain provider');
if (rulesBaseUrl && !stash.includes(`${rulesBaseUrl}/stash/rules/`)) throw new Error('Stash provider 缺少远程 URL');
if (/geosite-cn|geoip-cn/.test(stash)) throw new Error('Stash 默认 Override 不应加载通用国内直连规则');
const stashRuleLines = stash.split('\n').filter((line) => line.trimStart().startsWith('- RULE-SET,'));
if (!stashRuleLines.length) throw new Error('Stash 默认 Override 没有规则');
if (!privateProfile && stashRuleLines.some((line) => !line.endsWith(',REJECT'))) {
  throw new Error('Stash 公共默认 Override 必须只包含拒绝规则');
}
const expectedCacheNamespace = targets.generator?.stash_cache_namespace ?? 'network-rules-v2';
if (rulesBaseUrl && !stash.includes(`path: ./rules/${expectedCacheNamespace}/`)) throw new Error('Stash 未使用版本化缓存路径');
const stashRegex = await readFile(resolve(outputDir, 'stash/rules/geosite-category-ads-all-classical.yaml'), 'utf8');
if (stashRegex.split('\n').filter((line) => line.includes('DOMAIN-REGEX,')).length !== 1) {
  throw new Error('Stash 未完整保留标量 DOMAIN-REGEX');
}

const manifest = await readJson(resolve(rootDir, 'vendor/manifest.json'));
const sources = new Map(manifest.sources.map((source) => [source.tag, source]));
for (const key of ['geosite_cn', 'geosite_ads']) {
  const config = upstreams.rule_sets[key];
  const entries = sources.get(config.tag)?.entries ?? 0;
  if (entries < config.minimum_rules || entries > config.maximum_rules) {
    throw new Error(`${config.tag} 数量 ${entries} 超出安全范围 ${config.minimum_rules}-${config.maximum_rules}`);
  }
}
const geoip = upstreams.rule_sets.geoip_cn;
const geoipSource = sources.get(geoip.tag);
if (!Number.isInteger(geoipSource?.ipv4) || !Number.isInteger(geoipSource?.ipv6)
  || geoipSource.ipv4 < geoip.minimum_ipv4 || geoipSource.ipv4 > geoip.maximum_ipv4
  || geoipSource.ipv6 < geoip.minimum_ipv6 || geoipSource.ipv6 > geoip.maximum_ipv6
  || geoipSource.entries !== geoipSource.ipv4 + geoipSource.ipv6) {
  throw new Error(`${geoip.tag} IPv4/IPv6 数量超出安全范围`);
}
console.log(`检查通过：${profile} 配置规则顺序正确、默认模块安全、sing-box 配置有效`);
