import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  countRuleEntries,
  execFileAsync,
  fetchBuffer,
  readJson,
  readJsonIfPresent,
  rootDir,
  sha256,
  uniqueSorted,
  writeJson
} from './lib.mjs';
import { ensureSingBox } from './sing-box.mjs';

function cidrLines(buffer) {
  return uniqueSorted(buffer.toString('utf8').split(/\r?\n/).map((line) => line.replace(/#.*/, '')));
}

function validateCidrs(values, family) {
  const invalid = values.find((value) => !value.includes('/') || (family === 4 ? value.includes(':') : !value.includes(':')));
  if (invalid) throw new Error(`无效 IPv${family} CIDR：${invalid}`);
}

const upstreams = await readJson(resolve(rootDir, 'src/upstreams.json'));
const singBox = await ensureSingBox();
const temporary = await mkdtemp(join(tmpdir(), 'network-rules-dist-sync-'));
const vendorDir = resolve(rootDir, 'vendor/source');
const manifestPath = resolve(rootDir, 'vendor/manifest.json');

try {
  const sourceRecords = [];
  for (const key of ['geosite_cn', 'geosite_ads']) {
    const config = upstreams.rule_sets[key];
    const srs = await fetchBuffer(config.url);
    const srsPath = join(temporary, `${config.tag}.srs`);
    const jsonPath = join(temporary, `${config.tag}.json`);
    await writeFile(srsPath, srs);
    await execFileAsync(singBox, ['rule-set', 'decompile', '--output', jsonPath, srsPath]);
    const source = await readJson(jsonPath);
    const entries = countRuleEntries(source);
    if (entries < config.minimum_rules) {
      throw new Error(`${config.tag} 只有 ${entries} 条，低于安全阈值 ${config.minimum_rules}`);
    }
    await writeJson(resolve(vendorDir, `${config.tag}.json`), source);
    sourceRecords.push({ tag: config.tag, url: config.url, sha256: sha256(srs), entries });
  }

  const geoip = upstreams.rule_sets.geoip_cn;
  const [ipv4Buffer, ipv6Buffer] = await Promise.all([
    fetchBuffer(geoip.ipv4_url),
    fetchBuffer(geoip.ipv6_url)
  ]);
  const ipv4 = cidrLines(ipv4Buffer);
  const ipv6 = cidrLines(ipv6Buffer);
  validateCidrs(ipv4, 4);
  validateCidrs(ipv6, 6);
  if (ipv4.length < geoip.minimum_ipv4 || ipv6.length < geoip.minimum_ipv6) {
    throw new Error(`中国 IP 数量异常：IPv4=${ipv4.length}, IPv6=${ipv6.length}`);
  }
  if (!ipv4.includes(geoip.sentinel)) throw new Error(`中国 IP 缺少哨兵网段 ${geoip.sentinel}`);
  const geoipSource = { version: 3, rules: [{ ip_cidr: [...ipv4, ...ipv6] }] };
  const geoipJson = resolve(vendorDir, `${geoip.tag}.json`);
  await writeJson(geoipJson, geoipSource);
  await execFileAsync(singBox, ['rule-set', 'compile', '--output', join(temporary, `${geoip.tag}.srs`), geoipJson]);
  sourceRecords.push({
    tag: geoip.tag,
    urls: [geoip.ipv4_url, geoip.ipv6_url],
    sha256: sha256(Buffer.concat([ipv4Buffer, ipv6Buffer])),
    entries: ipv4.length + ipv6.length,
    ipv4: ipv4.length,
    ipv6: ipv6.length
  });

  const previous = await readJsonIfPresent(manifestPath);
  const stableManifest = { sing_box_version: upstreams.sing_box.version, sources: sourceRecords };
  const unchanged = previous && JSON.stringify({
    sing_box_version: previous.sing_box_version,
    sources: previous.sources
  }) === JSON.stringify(stableManifest);
  await writeJson(manifestPath, {
    updated_at: unchanged ? previous.updated_at : new Date().toISOString(),
    ...stableManifest
  });
  console.log(`已同步 ${sourceRecords.map((item) => `${item.tag}=${item.entries}`).join(', ')}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
