# VPS Go 后端部署与管理

VPS 后端已经收敛为一个 Go 二进制 `jxnu-backend`。它同时负责：

- `127.0.0.1:8787`：公开实时人数、公开运行配置和健康检查；
- `127.0.0.1:8788`：Cloudflare Pages Function 调用的学号实时课表；
- `127.0.0.1:8790`：只允许通过 SSH 隧道访问的中文管理面板；
- `jxnu-backend sync`：每小时抓开课安排与容量、执行安全闸、运行 `build_data.py`、提交并推送。

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

## 面板里的四个日常选项

“日常设置”页只展示业务语义，不再要求维护者理解 env 键名：

| 面板选项 | 实际作用 | 生效方式 |
| --- | --- | --- |
| 网站默认打开哪个阶段 | 新会话默认显示预选 / 正选 / 补退选；用户主动切换后仍尊重用户选择 | 立即生效 |
| 实时人数显示在哪个学期 | 同时决定后端快照的 `semester` 和前端在哪个学期开启轮询 | 立即刷新并生效 |
| 每小时把新数据写入哪个学期 | 决定同步任务写入 `data/semesters/<学期>/raw/` 的目录 | 下一轮同步生效 |
| 查学号时使用哪一学期的实时课表 | 自动跟随教务，或后端真实切换到指定教务学期；指定后不计入更晚的预建学期 | 清缓存后立即生效 |

学号学期既能从下拉列表选，也能直接输入将来新增的值，例如 `27-28第1学期`。后端会校验该学期是否真实出现在教务下拉框；不存在时返回明确错误，Cloudflare Function 会照旧回落 D1 快照。

“高级设置”折叠了刷新频率、容量开关/阶段、礼貌延迟、异常数据安全闸和 CORS 白名单。学校关闭选课期间保持“容量抓取”关闭；开选后再开启。关闭只跳过无法验证的联网探测，不会删除或覆盖上一份容量数据。

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
├── last_sync.json     # 最近一次同步状态
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

手动同步优先点面板“任务 → 立即同步一次”，也可以运行：

```bash
systemctl --user start jxnu-sync.service
```

同步仍有三道闸：公开开课行数、构建后教学班数、容量可见课程数。容量阶段不对或教务登录失败时只保留旧容量，不阻止公开开课安排更新；仓库非干净或 `git pull --ff-only` 失败时直接停止，绝不强推。

## HTTP 契约

| 路径 | 端口 | 说明 |
| --- | --- | --- |
| `GET /healthz` | 8787 | 实时人数状态；无首份快照时 503 |
| `GET /api/enrollments` | 8787 | 与旧前端兼容的紧凑人数数组，支持 ETag/gzip/CORS |
| `GET /api/config` | 8787 | 无敏感运行配置；前端读取失败时回落静态 `app_config.json` |
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
