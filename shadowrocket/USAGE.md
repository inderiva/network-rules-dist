# Shadowrocket

`NetworkRules.conf` 是国内直连、其余代理的主配置；`NetworkRules.sgmodule` 只是广告模块，不能替代主配置。

使用主配置时，把全局路由设为“配置”。国内 IP 清单允许为未收录域名解析 IP；局域网和私有 IP 例外仍使用 no-resolve。公开主配置的最终代理规则带 dns-failed，使本地解析失败的域名仍可交给代理。原生行为需要在 Shadowrocket 中复核。
