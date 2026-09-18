# Stash

选择一个覆写文件启用：

- `NetworkRules.stoverride`：广告拦截，国内分流由主配置负责。
- `NetworkRules-ChinaDirect.stoverride`：广告拦截、国内域名和国内 IP 直连；其余流量沿用主配置的最终策略。国内 IP 规则会在需要时触发 DNS 解析。

两个文件二选一。Stash 会把覆写的规则插到主配置规则前面；如果主配置已有必须优先代理的特殊域名，应先核对顺序。节点、DNS 和最终策略继续由主配置维护。
