# QuotaRadar 首版边界

单人额度管理台与 QQ/TG Bot。不转发模型请求，不做多用户计费，不实现 QQ 协议。一个 TypeScript 后端、一份 SQLite 数据库、React 前端。

## 数据口径

- 查询类型描述请求/响应协议；供应商保存 URL 与参数；Key 继承供应商参数。
- 内置 `openai-billing`、站点扩展 `newapi-cx`、上游 `newapi-usage`。CX 不代表所有 new-api 站点。
- billing 默认窗口 90 天，默认标记估算。只有用户确认该窗口与总额口径一致时标记准确。
- 金额为十进制字符串，运算精度 12 位小数并四舍五入；图表可转换为近似数字用于显示，统计不使用浮点。
- 不同单位不相加。仅明确独立额度或指定共享余额组的准确有限额度参与汇总。共享组取最新一份，不重复计数。
- 无限额度独立显示；缺失字段为空；查询失败保留旧快照。余额增加不视为负消费。
- 快照绑定凭据版本与供应商配置版本，口径变化后的曲线分段，不跨段计算差值。历史在首次采样时开始。

## 闭环

供应商/Key 增删改、批量预览导入、手动与定时刷新、快照与任务历史、低额度和失败提醒、日报、QQ/TG 共用命令、备份恢复。

前端提供概览、额度管理、消息平台和设置四个入口。Bot 默认查询快照，刷新命令触发同一刷新队列。群消息既检查群也检查发送者。

## 部署

Linux Docker Compose 为主要交付。主服务由 GitHub CI 检查后构建 AMD64 / ARM64 镜像并发布到 GHCR，`compose.yaml` 用于直接拉镜像，源码构建通过 `compose.build.yaml` 覆盖。一次性资源初始化服务从主服务镜像导出驱动启动文件，供 SnowLuma 只读挂载，服务器无需源码目录。镜像标签和拉取权限的操作说明见 README。

SnowLuma 为可选的独立官方服务，固定 v1.10.0，不复制其原生插件、不维护修改版驱动；业务、QQ 数据卷与可再生的启动资源卷分开。

日常只有 QuotaRadar 一个前端。消息平台内切换 QQ / Telegram；协议原文确认、账号/进程、OneBot 同步和日志使用原生组件。协议仍须用户明确确认，保存连接参数不会启用 Bot，也不代表账号在线。

项目自带 Compose 只保留 QuotaRadar 认证边界。由管理员密码经用途隔离的 HMAC 派生内部驱动和桌面凭据，而不是让三个服务复用同一个明文密码。驱动启动包装器按固定 v1.10.0 的 `webui.json` 格式写入 scrypt 哈希，不修改协议确认或 QQ 登录数据；管理会话只保留在后端内存，与 OneBot token 分开。网页不能改写受管驱动地址或密码。本机接外部驱动是独立部署方式，仍支持手动认证。

传统 VNC 只能使用 8 字节密码，所以内部使用单独派生的 8 字节凭据，不降低管理员密码长度。后端代理完成 RFB 3.8 的 VNC challenge-response，浏览器通过 QuotaRadar 管理会话进入桌面，不接收内部密码，也不将密码放入 URL。该浏览器侧免二次认证只存在于已通过管理员鉴权的 WebSocket，认证失败即关闭，不回退。驱动原始管理、桌面与 OneBot 端口均不映射到宿主机。管理员密码变化会轮换内部凭据并使旧网页登录会话失效；操作步骤见 README。

没有公开二维码接口时，继续通过本站 HTTP/WS 代理在按需弹窗中展示官方 noVNC 桌面；关闭即断开桌面连接。主服务和驱动仍为两个进程/容器，不接 Docker socket，不提供容器启停或伪造 QQ 重启功能。升级 SnowLuma 前必须重新核对认证存储格式与桌面握手协议，不能仅更换镜像标签。

Windows 可运行主服务开发；Windows 原生 QQ 托管不在本版。

## 验证边界

模拟 Key 和本地 HTTP/WS 替身用于测试。真实供应商、真实 Telegram/QQ 及下载/启动第三方镜像需另行授权，不以模拟成功代替真实联调。

## 一手参考

- https://snowluma.github.io/zh/docs/guide/deploy/docker
- https://snowluma.github.io/zh/docs/guide/configuration
- https://snowluma.github.io/zh/docs/api
- 固定版本管理协议：[server.ts](https://github.com/SnowLuma/SnowLuma/blob/v1.10.0/packages/core/src/webui/server.ts)、[auth.ts](https://github.com/SnowLuma/SnowLuma/blob/v1.10.0/packages/core/src/webui/auth.ts)、[consent.ts](https://github.com/SnowLuma/SnowLuma/blob/v1.10.0/packages/core/src/webui/consent.ts)、[types.ts](https://github.com/SnowLuma/SnowLuma/blob/v1.10.0/packages/webui/src/types.ts)。适配以该标签为准，不套用 main 的新版认证接口。
- https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE
- https://github.com/QuantumNous/new-api/blob/main/controller/token.go
- https://core.telegram.org/bots/api
