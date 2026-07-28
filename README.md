# network-rules-dist

公开、可直接订阅的 Shadowrocket、Stash 和 sing-box 规则产物。仓库只包含公共规则，不包含个人或公司内部域名、地址与覆盖配置。

## 直接使用

### Shadowrocket

模块地址：

```text
https://raw.githubusercontent.com/inderiva/network-rules-dist/main/shadowrocket/NetworkRules.sgmodule
```

模块添加以下顺序的规则，不包含 `FINAL`，因此不会覆盖现有配置的最终策略：

1. 抖音等国内服务优先直连
2. 广告拒绝
3. 国内域名直连
4. 国内 IP 直连

Shadowrocket 输出不写入 `DOMAIN-REGEX`，无法安全转换的规则数量会显示在模块顶部；Stash 和 sing-box 产物完整保留。

### Stash

Override 地址：

```text
https://raw.githubusercontent.com/inderiva/network-rules-dist/main/stash/NetworkRules.stoverride
```

Override 使用远程 domain、ipcidr 和少量 classical provider，规则会合并到现有规则数组前面。provider 每天检查更新。

### sing-box

- 远程规则片段：`sing-box/route.remote.fragment.json`
- 本地规则片段：`sing-box/route.local.fragment.json`
- DNS 片段：`sing-box/dns.fragment.json`
- JSON/SRS：`sing-box/rules/`

远程片段中的规则集会直接从本仓库下载并每天更新。将需要的 `route`/`dns` 字段合并到现有配置；默认名称为：

- 代理 outbound：`auto`
- 直连 outbound：`direct`
- 国内 DNS：`dns-direct`
- 远程 DNS：`dns-remote`

如果名称不同，修改 `src/targets.json` 后重新生成。

## 数据和顺序

公共数据来源：

- SagerNet `geosite-category-ads-all`
- SagerNet `geosite-cn`
- gaoyifan `china-operator-ip`

广告规则始终位于国内直连规则之前，防止同时出现在两个集合中的广告域名被提前直连。没有重复加载与 `geosite-cn` 几乎相同的 `geosite-geolocation-cn`。

## 自动更新

GitHub Actions 每天北京时间约 04:20 同步一次上游，执行完整构建和测试。只有上游内容实际变化时才提交，不会因为时间戳产生空更新。

手动生成：

```bash
npm run sync
npm run build
npm run check
npm test
```

首次构建会下载官方 sing-box 1.13.4 Linux 二进制并校验固定 SHA-256。所有生成结果均可由提交在仓库中的 `vendor` 数据复现。
