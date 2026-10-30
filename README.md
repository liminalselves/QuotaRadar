# QuotaRadar

个人 API Key 额度管理台，包含 QQ / Telegram Bot、额度变化记录、定时巡检和提醒。查询类型、供应商和 Key 分开配置，同类站点共用请求实现。

提供源码运行和预构建镜像部署。实际检查结果与未验证项记录在 [NEXT.md](NEXT.md)；额度口径与范围见 [设计说明](docs/design.md)，验收条件见 [实施说明](docs/implementation.md)。

## 环境

- 服务器镜像部署：Docker Engine / Docker Desktop 与 Docker Compose v2，不需要 Node.js、npm 或本地编译。
- 源码开发：Node.js 22.13 或更新版本，附带 npm；需要 QQ 时再使用 Docker。
- 主服务镜像提供 Linux AMD64 / ARM64；固定 SnowLuma v1.10.0 的官方镜像也提供这两个架构，但实际 QQ 功能验收以 [NEXT.md](NEXT.md) 为准。

## 服务器直接部署镜像

首次部署只需 `compose.yaml` 和 `.env`：

```sh
mkdir -p quotaradar
cd quotaradar
curl -fsSL https://raw.githubusercontent.com/liminalselves/QuotaRadar/main/compose.yaml -o compose.yaml
curl -fsSL https://raw.githubusercontent.com/liminalselves/QuotaRadar/main/.env.example -o .env
chmod 600 .env
```

用编辑器将 `.env` 中的 `QR_ADMIN_PASSWORD` 填为自己的长随机密码，然后启动：

```sh
docker compose --profile qq pull
docker compose --profile qq up -d
```

只使用额度管理和 Telegram，不启动 QQ：

```sh
docker compose pull quotaradar
docker compose up -d quotaradar
```

默认访问 `http://127.0.0.1:3210/`；公网使用 HTTPS 反向代理，同时转发 HTTP / WebSocket。不要为了访问 QQ 单独映射驱动端口。

更新镜像仍执行 `pull` 和 `up -d`，保留原 `.env` 和数据卷，不要重复下载覆盖自己的配置。`QUOTARADAR_IMAGE` 默认使用 `ghcr.io/liminalselves/quotaradar:latest`，也可指定分支标签或 `sha-完整提交哈希` 固定版本。若更新涉及 Compose，先核对并合并新配置。

`driver-assets` 是一次性启动资源初始化服务，退出码为 0 属于正常完成；它将镜像中的驱动启动文件导出到命名卷，不要求服务器保留源码。其资源卷可重新生成，备份仍以业务和 QQ 数据卷为准。

### GitHub CI 与镜像权限

[Actions](https://github.com/liminalselves/QuotaRadar/actions) 在每次 push 后先执行 `npm ci` / `npm run check`，通过后构建并发布 AMD64、ARM64 镜像。默认分支发布 `latest`，另外发布分支名、Git 标签和 `sha-完整提交哈希` 标签；PR 只检查，不发布。工作流使用 `GITHUB_TOKEN`，无需手动配置发布用 PAT。

**GHCR 新包默认私有，即使源码仓库公开。** 仓库管理员可在 [组织 Packages 页面](https://github.com/orgs/liminalselves/packages) 打开 `quotaradar` 的 Package settings，将包设为公开，之后服务器可匿名拉取。若保留私有，服务器先执行 `docker login ghcr.io`，使用具备 `read:packages` 的经典 PAT 登录；不要把 PAT 写进 Compose 或提交到仓库。

## 开发运行

下面的源码命令在项目根目录运行。

```sh
npm ci
node scripts/setup.mjs
npm run dev
```

`setup.mjs` 生成 `.env` 和随机管理密码，不覆盖已有文件。用编辑器查看 `.env` 中的 `QR_ADMIN_PASSWORD`，不要把它当作供应商 Key。

打开 [开发管理台](http://127.0.0.1:5173/)。开发服务器将 `/api` 转发给本地 3210 端口的后端。数据保存到项目 `data/`，前端和后端均支持源码变更重启或更新。

本机运行生产前端：

```sh
npm run build
npm start
```

打开 [管理台](http://127.0.0.1:3210/)。`npm start` 和 `npm run dev:server` 会读取根目录 `.env`；`npm run dev` 读取同一文件并同时启动前后端。单独的 `npm run dev:web` 只启动前端。

## 本地从源码构建容器

`compose.yaml` 默认拉取发布镜像；下面的脚本会额外合并 `compose.build.yaml`，构建本地镜像并一起启动 SnowLuma，不需要另写 QQ 驱动部署文件：

```sh
node scripts/stack.mjs up
```

首次运行会自动生成缺失的 `.env`。默认启动 QuotaRadar 和 SnowLuma；仅使用管理台与 Telegram 时：

```sh
node scripts/stack.mjs up --without-qq
```

日常只打开 [QuotaRadar](http://localhost:3210/)。QQ 认证、连接设置、驱动日志和登录桌面统一放在“消息平台 → QQ”，不需要另开 SnowLuma 控制台。

```sh
node scripts/stack.mjs status
node scripts/stack.mjs logs
node scripts/stack.mjs down
```

`down` 实际执行 Compose 的 `stop`，保留容器和数据卷。停止全部后再用 `up --without-qq`，可以切换为不启动 QQ；该参数不会自动停止之前已经运行的 SnowLuma。

`.env` 可以配置管理台端口、绑定地址和 `SNOWLUMA_IMAGE`。默认端口仅绑定本机；修改端口后访问地址相应变化。SnowLuma 镜像固定版本，不追随 `latest`；主服务的 `latest` 来自默认分支 CI。实际验证范围以 `NEXT.md` 为准。

### 首次连接 QQ

1. 用 `.env` 的 `QR_ADMIN_PASSWORD` 登录 QuotaRadar。项目自带的 SnowLuma 与桌面由同一个管理入口接管，不再要求另一组密码。
2. 进入“消息平台 → QQ”。驱动会自动认证；首次使用仍须在站内阅读驱动协议原文并明确确认，不会代为同意。
3. 点击“打开 QQ 登录”，直接在站内桌面扫码。内部 VNC 认证在后端完成，不再弹出桌面密码框。关闭窗口仅断开桌面连接，不退出 QQ。
4. 刷新驱动状态，选择 QQ 账号和 OneBot 入口，点击“自动配置连接”。已有 token 保留，缺失时自动生成并同步。没有 WebSocket 入口时可创建默认 3001 端口入口；已有单向入口而无 Universal 入口时需调整驱动配置。
5. 填写允许使用的 QQ 号、群和通知目标，再启用并保存平台。驱动管理连通、OneBot 连接、QQ 在线是三个不同状态。保存参数不代表在线；未完成热重载会单独提示。
6. 配置生效后可向 Bot 发送 `/status` 或 `/balance`。“发送测试消息”会实际向已保存的目标发消息。

Compose 使用 Docker 内网中的 `http://snowluma:5099/` 和 `http://snowluma:6081/`，这些地址只由后端访问。统一管理模式下，网页不能覆盖驱动地址或内部密码。

本机 Node 接入自行部署的外部驱动时，默认不启用统一管理；可在“高级：驱动地址与重新认证”填写后端可达的 HTTP(S) 根地址并认证，桌面使用该外部部署的密码。`QR_SNOWLUMA_API_URL`、`QR_SNOWLUMA_DESKTOP_URL` 提供默认地址；外部模式更换管理地址会清除保存的密码。它不是连接项目内隐藏端口的方式。

“高级：手动 OneBot 连接”仍可填写地址和 token，供非默认部署使用。自动配置通过管理地址推导 OneBot 主机与端口；若驱动只监听 loopback、使用不同映射端口或独立反向代理，需要手动填写后端实际可达的 `ws://` / `wss://` 地址。

进程加载、状态刷新和按需日志位于高级设置，不负责 QQ 或容器启停。SnowLuma 仍为独立官方容器，不接入 Docker socket；5099、6081、5900、3000、3001 均不映射到宿主机，`QR_DRIVER_BIND_ADDRESS` 不再使用。不要再访问宿主机 6081 或 5099，统一通过 QuotaRadar。若需公网访问，只反向代理 QuotaRadar 的 HTTPS 入口，同时转发 HTTP 与 WebSocket。

固定 v1.10.0 的驱动数据目录为 `/app/snowluma-data`，对应 `qq-gateway-data` 卷；另外两个卷保存 QQ 客户端数据。项目启动包装器只接管认证配置，并预创建缺失的运行配置以避免上游首次启动权限问题；保留已有协议确认、运行设置和 QQ 数据。不需要 `chmod 777`，也不让驱动进程以 root 运行。

### 修改统一管理密码

修改 `.env` 中的 `QR_ADMIN_PASSWORD` 后，镜像部署运行 `docker compose --profile qq up -d`，源码构建运行 `node scripts/stack.mjs up`，使两个服务应用新配置。内部驱动与桌面凭据随之同步轮换，旧 QuotaRadar 登录会话失效；用户仍只需记住新的 QuotaRadar 密码。密码不要放入 URL，不要只重建其中一个服务。认证机制见 [设计说明](docs/design.md#部署)。

## 添加供应商与 Key

1. 在“额度管理”添加供应商，选择查询类型并填写站点 URL。表单提供不含凭据的站点预填。
2. 在供应商下添加 Key，或多行粘贴导入。支持每行一个 Key，或 `别名 | Key`；先预览，再确认，同供应商重复凭据会跳过。
3. 手动刷新单个、所选、整个供应商或全部 Key，打开详情查看快照、变化和查询记录。启用的 Key 也会按巡检设置自动查询。
4. 需要合计时，确认额度范围和独立性后再调整汇总方式。默认不把所有 Key 直接相加。

| 查询类型 | 适用接口 |
| --- | --- |
| `openai-billing` | subscription / usage 两次 GET；用量美分转美元 |
| `newapi-cx` | 站点扩展 `/api/token/cx`；body 传 token |
| `newapi-usage` | 上游 `/api/usage/token/`；Bearer 鉴权 |

高级选项包含请求路径、换算比例、超时和附加请求头。换算比例表示“多少内部单位等于一个显示单位”，修改显示单位名称不会自动换汇。Billing 结果默认标记估算；不要在未核对统计口径时勾选口径确认。详细规则统一见 [数据口径](docs/design.md#数据口径)。

编辑 Key 时凭据留空表示保留原值。替换凭据或修改供应商查询配置后需要重新采样，旧历史保留但不跨版本计算差值。停用保留历史；删除 Key 会同时删除其历史，删除供应商前会显示关联影响。

## Telegram 与 Bot 命令

在“消息平台 → Telegram”填写 Bot token、允许使用者和通知目标，启用后由服务进行 long polling，不需要公网 webhook。若该 Bot 已配置 webhook，先在其原有配置处处理冲突；QuotaRadar 不会擅自删除 webhook。

- 允许使用者和允许的群按数字 ID 填写，每行一个；群命令同时检查发送者和群。
- 通知目标格式为每行 `private:123456` 或 `group:-100123456`。QQ 使用对应的 QQ 号或群号。
- Telegram 私聊前先由用户打开 Bot 并开始会话；群里使用对应 Bot 的命令形式。
- token 保存后不回显，留空保留；要删除 token，使用表单的清除操作。
- “发送测试消息”使用已经保存且启用的配置，会实际向通知目标发消息。

QQ 与 Telegram 共用命令：

```text
/balance [别名或供应商]
/refresh [别名或供应商或 all]
/low
/status
/help
```

QQ 另支持“额度”“刷新额度”。`/balance` 查询已保存的快照，`/refresh` 才发起新查询。未配置 Key 时不会凭空返回额度；名字存在歧义时会给出候选，不猜测目标。Bot 不接收凭据增删命令。

## 巡检与通知

“设置”可调整刷新间隔、默认低额度阈值、连续失败次数、异常重复提醒间隔、历史保留期限和日报时区。日报默认关闭。低额度提醒按一次低额度状态去重，只有新鲜快照确认额度恢复后，再次跌破阈值才会提醒；快照过期、查询失败或查询尚未完成都不算恢复。

失败不会把余额改成零，也不会覆盖上次成功快照。前端仍显示旧结果的时间与失败状态。异常告警按状态变化和重复间隔去重；长消息按段记录发送进度，已确认发送的段不会因后续失败重复发送。消息平台返回限流时会按等待时间重试；发送结果无法确认时不会自动重发，避免平台实际已收到消息却再次播报。没有配置启用的平台与通知目标时，通知记录可能显示跳过，而不是已经发送。

## 备份与恢复

### 加密备份

在“设置”输入至少 10 位备份口令，下载 `.qrb` 文件。备份先压缩，再通过口令加密，包含业务配置、凭据（含外部驱动模式保存的管理密码）、快照和任务记录；**不包含 SnowLuma / QQ 的登录状态，也不包含 `.env` 的管理员密码**。

恢复步骤：

1. 停用 QQ 与 Telegram 两个平台。
2. 选择 `.qrb` 文件，输入原备份口令。
3. 输入“恢复并覆盖”并执行。恢复覆盖当前业务数据，不是合并导入；错误口令不会清空原库。
4. 恢复后平台保持停用，核对配置再主动启用。管理员密码仍来自当前环境。

网页备份文件上限为压缩加密后的 24 MiB。导出和恢复使用相同上限，超限不会导出不可恢复文件；数据更大时使用下述完整目录备份。

### 完整目录备份

先停止相关服务，再复制完整数据目录或数据卷；不要只复制运行中的 SQLite 主文件。Node 运行时保存整个 `data/`；Compose 保存 `radar-data` 卷，QQ 登录状态另需保存三个 QQ 卷。`.env` 单独保管。

`vault.key` 与数据库必须一起保留。已有数据库却缺失该文件时，服务会停止，不会用新密钥替换它。找不到原密钥但有 `.qrb` 时，保留原目录，在全新数据目录或新安装中启动，再通过管理台恢复加密备份；没有原密钥也没有可解密备份时，不能还原原数据库内的凭据。

## 检查命令

```sh
npm test
npm run typecheck
npm run test:integration
npm run build
```

`npm test` 不需要安装第三方依赖，只使用模拟凭据、内存数据库和本地 HTTP 替身。其余检查需要先安装项目依赖。`npm run check` 串行执行完整检查；浏览器交互、真实供应商和真实消息收发不由该命令替代。当前结果见 [NEXT.md](NEXT.md)。

常见启动问题：

- 提示缺少依赖、`tsc` 或 `tsx`：项目依赖尚未安装，不需要安装全局编译器。
- 5173 无法请求 `/api`：检查 3210 端口的后端是否正常启动，以及端口是否被占用。
- QQ WebSocket 已连接但账号不在线：打开站内 QQ 登录桌面检查账号，再刷新状态。
- 统一管理的驱动认证失败：确认两个服务使用同一份 `.env`，并通过统一启动命令重建。外部驱动模式才需要核对单独的驱动密码和管理地址；失败不会退出 QuotaRadar，也不会无限重试。
- 桌面无法连接：检查 SnowLuma 是否运行；反向代理必须转发 `/api/qq/desktop/` 的 HTTP 与 WebSocket。统一模式不需要输入 VNC 密码，内部认证失败会关闭连接，不会回退到默认密码。
