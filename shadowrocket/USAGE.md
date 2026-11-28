# Shadowrocket

`NetworkRules.conf` 是国内直连、其余代理的主配置；`NetworkRules.sgmodule` 只是广告模块，不能替代主配置。

使用主配置时，把全局路由设为“配置”。国内域名与直接访问的国内 IP（通过 `GEOIP,CN,DIRECT,no-resolve`）直连，其余域名走代理；LinkedIn 及其媒体域名明确走代理。主配置不加载会触发本地预解析的国内 IP 清单，`no-resolve` 仅匹配裸 IP 请求，不会让未收录域名在本地预解析；局域网和私有 IP 例外仍直连。

直连域名使用阿里 DoH，失败时尝试腾讯 DoH，不配置明文 DNS 或系统 DNS 回退。最终代理规则保留 dns-failed，使本地解析失败的域名仍可交给代理。更新手机配置后需在 Shadowrocket 日志中复核实际 DNS 与分流行为。
