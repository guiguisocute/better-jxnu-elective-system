# VPS Go 后端部署与管理

VPS 后端已经收敛为一个 Go 二进制 `jxnu-backend`。它同时负责：

- `127.0.0.1:8787`：公开实时人数、公开运行配置和健康检查；
- `127.0.0.1:8788`：Cloudflare Pages Function 调用的学号实时课表；
- `127.0.0.1:8790`：只允许通过 SSH 隧道访问的中文管理面板；
- `jxnu-backend sync --scheduled`：timer 每 15 分钟检查一次面板配置；到达实际间隔后只运行“默认展示阶段”对应的采集管线，再执行安全闸、构建、提交和推送。
- `jxnu-backend build`：不访问教务采集页面，只使用仓库现有 raw 执行构建、校验和发布，保留油猴/手工采集兼容能力。

常驻层不再运行 `kkap_service.py`、`live_service.py` 或 `admin_service.py`。Python 只保留为构建期数据流水线；`build_data.py` 的字段优先级和幂等规则不在这次迁移中改变。

## 进入管理面板

在自己的电脑上运行，并保持这个终端窗口打开：

```bash
ssh -L 8790:127.0.0.1:8790 29HK
```

浏览器打开：

```text
http://127.0.0.1:8790
```

输入安装时生成或从旧面板迁移的管理密码。忘记密码时，在 VPS 上查看：

```bash
grep '^ADMIN_PASSWORD=' ~/apps/jxnu-backend/backend.env
```

面板只监听 VPS 回环地址，公网域名无法打开它；即使 Caddy 配错，也没有管理路由暴露在 8787/8788 上。

## 面板里的阶段化日常选项

“日常设置”页只展示业务语义，不再要求维护者理解 env 键名：

| 面板选项 | 实际作用 | 生效方式 |
| --- | --- | --- |
| 网站默认打开哪个阶段 | 新会话默认显示预选 / 正选与补退选共用入口；用户主动切换后仍尊重用户选择 | 立即生效 |
| 预选目标学期 | 只对应 `preselect_catalog.json`；选择预选为默认阶段后不轮询 KKAP 人数、不探测容量 | 下一轮构建生效 |
| 正选/补退选目标学期 | 两个时段共用 `formal_schedule.json`、KKAP 实时人数与 `formal_capacity.json` | 立即切换人数目标；下一轮同步写 raw |
| 查学号时使用哪一学期的实时课表 | 自动跟随教务，或后端真实切换到指定教务学期；指定后不计入更晚的预建学期 | 清缓存后立即生效 |

学号学期既能从下拉列表选，也能直接输入将来新增的值，例如 `27-28第1学期`。后端会校验该学期是否真实出现在教务下拉框；不存在时返回明确错误，Cloudflare Function 会照旧回落 D1 快照。

“高级设置”只有一套正选/补退选容量配置。两阶段共用课表与 `formal_capacity.json`；进入补退选时只需把容量嗅探完整 URL 改成当时页面的真实地址。URL 必须保留 `{courseId}` 占位符，且后端限制为 `https://xk.jxnu.edu.cn`，避免面板配置变成任意网络请求入口。预选没有容量配置。

“自动构建”页提供完整调度设置：总开关、实际构建间隔、正选/补退选共用 KKAP 守候、连续结构稳定次数、CAS 缺失学分补全和限速。timer 只在预选与正选/补退选两条管线之间切换。

KKAP 不再使用页面默认学期。每次先读取 `ddlSterm`，按仓库目标选择明确的教务学期，并逐行验证结果链接中的 `xq`。例如目标为 `2027-03` 时，只接受 `26-27第2学期 / 2027/3/1 0:00:00`；该选项尚未出现时状态为“待命”，不会创建或覆盖 `2027-03` raw。首次出现后默认要求课表结构连续两次一致再自动发布，授课人数和页面序号变化不计入结构变化。面板手动“联网采集并构建”可跳过连续次数，但不会跳过学期和数量安全闸。

预选侧当前仍保留手工 `preselect_catalog.json` 输入：选课系统关闭期间没有可验证的 Step1 页面，后端不会用 KKAP、往期 catalog 或猜测接口伪造预选全集。选择预选为默认阶段后，构建器只认预选目标目录，并把该目录设为唯一 `meta.isCurrent`；将来 CAS 采集器验证后仍写同一文件。

面板另有“仅构建现有 raw”，对应 `jxnu-backend build`。它按当前入口选择 `preselect_catalog.json` 或共用的 `formal_schedule.json`，并跳过课程详情与容量联网采集。

课程详情补全链路为 `CourseSetting.aspx → CourseInfor.aspx`，复用同一个已验证应用级 Cookie 的 CAS 会话。结果落在 `data/semesters/<sem>/raw/course_details.json`，只补 training plan / catalog 的空值，绝不覆盖它们已有的非零学分。这里没有课程号白名单：后端先按课程号聚合 KKAP 全量结果，只有当该课程所有行都没有可解析的正学分时，才自动加入 CAS 补齐队列；有效缓存未过期时不重复访问，失败则保留旧值。学校的 `CourseInfor.aspx` 可能只给课程号、名称和学分而没有内容简介；这种情况下缓存会如实保留空简介，不能把学校未提供的文本伪造为“已同步”。

“日志”页只读展示 `jxnu-backend.service`、`jxnu-sync.service`、`jxnu-sync.timer`，来源、时间范围和行数全部使用后端白名单，不接受任意 unit 或 shell 参数。

“AI 配置”页直接管理 Cloudflare Pages production 的“AI 帮我选”设置：

| 分组 | 可配置项 |
| --- | --- |
| 服务商连接 | OpenAI-compatible API 根 URL、模型名称、只写不回显的 API Key |
| 模型行为 | 可编辑业务系统提示词；候选白名单、JSON 契约和“专业任选 = 任意选修”等固定规则由接口强制追加 |
| 生成参数 | temperature、最大输出 token、上游超时 |
| 预算 | 单用户每日次数、全站每日调用次数、全站每日 token 熔断 |

保存按钮会先 PATCH Pages 项目的 production 环境变量，再创建一次 production 部署；只有部署完成后新配置才会生效。现有 `AI_API_KEY` 始终按 `secret_text` 处理，页面、结果页和日志都不会回显。面板使用的 `CF_API_TOKEN` 需要 `Account / Cloudflare Pages / Edit` 权限；VPS 尚未配置时，“AI 配置”页会先显示一次性 Cloudflare 连接表单，验证成功后以 `0600` 权限写入 `backend.env` 并立即解锁完整配置。

## 本地构建与首次部署

VPS 不需要安装 Go。在开发机仓库根目录交叉编译：

```bash
mkdir -p dist
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -C backend -trimpath -ldflags="-s -w" -o ../dist/jxnu-backend ./cmd/jxnu-backend
scp dist/jxnu-backend 29HK:/tmp/jxnu-backend
```

然后登录 VPS：

```bash
cd ~/better-jxnu-elective-system
git pull --ff-only
./deploy/install-backend.sh /tmp/jxnu-backend
```

安装脚本会：

1. 复制二进制、配置模板和三个 user-systemd 单元；
2. 首次安装时从旧 `jxnu-live` / `jxnu-kkap` / `jxnu-admin` env 安全迁移凭据；
3. 停止占用旧端口的 Python 服务并启动 Go 服务；
4. 检查 8787、8788、8790；任一失败会自动恢复旧服务；
5. 新服务健康后禁用旧 Python 单元，但保留原文件以便人工回滚。

如果 VPS 已安装合适版本的 Go，也可以直接运行 `./deploy/install-backend.sh`，脚本会在 VPS 构建。

## 升级

重复执行同一流程即可。`backend.env` 与 `config.json` 不会被覆盖：

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -C backend -trimpath -ldflags="-s -w" -o ../dist/jxnu-backend ./cmd/jxnu-backend
scp dist/jxnu-backend 29HK:/tmp/jxnu-backend
ssh 29HK 'cd ~/better-jxnu-elective-system && git pull --ff-only && ./deploy/install-backend.sh /tmp/jxnu-backend'
```

## 配置文件

```text
~/apps/jxnu-backend/
├── jxnu-backend       # 单个静态二进制
├── backend.env        # 密码/密钥/账号，chmod 600
├── config.json        # 面板维护的普通业务设置，chmod 600
├── last_sync.json     # 最近一次同步状态（含详情缓存数量）
├── acquisition_watch.json # KKAP 等采集器的连续稳定计数，chmod 600
└── sync.lock          # 管理面板与 timer 的跨进程互斥锁
```

- `backend.env` 模板：[`backend.env.example`](backend.env.example)
- `config.json` 模板：[`backend.config.example.json`](backend.config.example.json)

普通设置不要再写进 env。面板保存 `config.json` 时使用临时文件 + `fsync` + 原子替换，三个服务会热读取或在下一次任务开始时读取，无需重启。

修改账号、密码或密钥后才需要重启：

```bash
chmod 600 ~/apps/jxnu-backend/backend.env
systemctl --user restart jxnu-backend.service
```

`LIVE_SECRET` 仍须与 Cloudflare Pages 的同名 secret 一致。

## 服务、日志与手动操作

```bash
systemctl --user status jxnu-backend.service
systemctl --user status jxnu-sync.timer
systemctl --user list-timers jxnu-sync.timer
journalctl --user -u jxnu-backend.service -n 100 --no-pager
journalctl --user -u jxnu-sync.service -n 100 --no-pager
```

手动联网同步优先点面板“自动构建 → 立即联网采集并构建”，也可以运行：

```bash
systemctl --user start jxnu-sync.service
```

只构建已经手工放入/提交的 raw：

```bash
~/apps/jxnu-backend/jxnu-backend build
```

只读探测某个 KKAP 目标学期，不写 raw、不构建、不改 Git：

```bash
~/apps/jxnu-backend/jxnu-backend probe-kkap 2027-03
```

目标尚未开放时命令正常返回 `state=waiting`，同时列出学校当前开放的教务学期；已开放时返回 `state=available` 和通过逐行学期校验的行数。

同步仍有三道闸：公开开课行数、构建后教学班数、容量可见课程数。容量阶段不对或教务登录失败时只保留旧容量，不阻止公开开课安排更新；仓库非干净或 `git pull --ff-only` 失败时直接停止，绝不强推。

## HTTP 契约

| 路径 | 端口 | 说明 |
| --- | --- | --- |
| `GET /healthz` | 8787 | 实时人数状态；无首份快照时 503 |
| `GET /api/enrollments` | 8787 | 与旧前端兼容的紧凑人数数组，支持 ETag/gzip/CORS |
| `GET /api/config` | 8787 | 无敏感运行配置；包含采集目标的仓库学期及映射后的教务学期；前端读取失败时回落静态 `app_config.json` |
| `GET /healthz` | 8788 | 学号服务、登录、缓存、学期状态 |
| `GET /student-record?sid=` | 8788 | 需 `X-Live-Secret`；响应形状与旧服务/D1 完全兼容 |
| 管理面板 | 8790 | 登录、CSRF、8 小时内存会话，仅回环 |

## Caddy

现有 [`Caddyfile.getxk`](Caddyfile.getxk) 不需要改路径：

- `/live/*` 反代到 `127.0.0.1:8788`；
- 其他公开请求反代到 `127.0.0.1:8787`。

验证：

```bash
curl https://getxk.jxnu-publish.asia/healthz
curl https://getxk.jxnu-publish.asia/api/config
curl -H 'Origin: https://test.better-jxnu-elective-system.pages.dev' \
  -I https://getxk.jxnu-publish.asia/api/enrollments
```

Go HTTP 层只记录结构化服务事件，不再把公网扫描的每个 404/501 写入 journal。

## 回滚到旧 Python 服务

仅在新服务无法启动且安装脚本未自动恢复时使用：

```bash
systemctl --user disable --now jxnu-backend.service jxnu-sync.timer
systemctl --user enable --now kkap-realtime.service jxnu-live.service jxnu-admin.service kkap-schedule.timer
```

旧服务目录和旧 user unit 在确认新后端稳定前不要删除。
