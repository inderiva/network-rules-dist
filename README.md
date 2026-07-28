# network-rules-dist

公开、可直接订阅的 Shadowrocket、Stash 和 sing-box 规则产物。仓库仅发布公开上游生成的数据，不包含私有覆盖配置。

## 直接使用

### Shadowrocket

只需要安装一个模块：

```text
https://raw.githubusercontent.com/inderiva/network-rules-dist/main/shadowrocket/NetworkRules.sgmodule
```

默认模块是自包含的广告拒绝模块，只添加 `REJECT` 规则，不包含国内直连、国内 IP、`FINAL`、DNS 或代理策略，也不再嵌套下载其他远程规则集，因此不会抢在现有配置前面改变分流。Shadowrocket 不兼容的 `DOMAIN-REGEX` 会安全省略；Stash 和 sing-box 产物仍完整保留。

`shadowrocket/rules/` 继续提供独立 `DOMAIN-SET`/`RULE-SET` 数据文件，供需要自己编排完整主配置的用户使用，但默认模块不会自动加载它们。

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

远程片段中的规则集会直接从本仓库下载并每天更新。fragment 只包含规则集和对应规则，不设置 `final`、DNS 最终服务器、地址策略、私有网络路由或网卡探测，不会替换这些整机策略。

将需要的 `route`/`dns` 字段合并到现有配置；默认只引用以下名称：

- 直连 outbound：`direct`
- 国内 DNS：`dns-direct`

如果名称不同，修改 `src/targets.json` 后重新生成。

## 数据和顺序

公共数据来源：

- [SagerNet/sing-geosite](https://github.com/SagerNet/sing-geosite) 的 `geosite-category-ads-all` 和 `geosite-cn`
- [gaoyifan/china-operator-ip](https://github.com/gaoyifan/china-operator-ip) 的中国 IPv4/IPv6 数据

广告规则始终位于国内直连规则之前，防止同时出现在两个集合中的广告域名被提前直连。没有重复加载与 `geosite-cn` 几乎相同的 `geosite-geolocation-cn`。

## 自动更新

GitHub Actions 每天北京时间约 04:20 同步一次上游，执行完整构建和测试。只有上游内容实际变化时才提交，不会因为时间戳产生空更新。

同步器会拒绝未审核字段、全网 CIDR、广告集合中的顶级后缀、超出绝对数量范围或相对上次突变超过 25% 的更新。异常更新需要人工复核，不会自动发布。

手动生成：

```bash
npm run sync
npm run build
npm run check
npm test
```

首次构建会下载官方 sing-box 1.13.4 Linux 二进制并校验固定 SHA-256。所有生成结果均可由提交在仓库中的 `vendor` 数据复现。

许可证和上游归属见 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`。
