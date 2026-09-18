# sing-box

路由片段二选一，不要把两份 rules 数组叠加：

- `route.local.fragment.json` / `route.remote.fragment.json`：保持原有行为。国内域名直连；国内 IP 规则只匹配已有的目标 IP。仅传域名、且主配置未提前解析时，未收录域名继续走主配置的默认出口。
- `route.resolve.local.fragment.json` / `route.resolve.remote.fragment.json`：在国内 IP 规则前使用主配置的 DNS 路由解析目标，补上未收录国内域名的 IP 分流。sing-box 1.13.4 解析失败会断开请求，不能自动继续走代理；需要可靠的 DNS。

保留原有主配置的 final、DNS 服务器和入站。将所选片段的规则放在主配置兜底规则之前，规则集定义合并到 route.rule_set；有明确代理例外时，应放在通用国内直连规则前面。按需合并 dns.fragment.json，其中引用的 dns-direct 必须已在主配置定义。单独合并 DNS 片段不会替仅传域名的代理请求预先解析 IP。

规则引用使用本地路径时，同时复制 rules 目录；远程版本需要能访问其下载地址。
