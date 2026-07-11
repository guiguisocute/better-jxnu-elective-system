# 实时授课人数服务（test）

`tools/kkap_monitor.py` 读取教务处公开的 `Public_Kkap.aspx`，不需要 CAS、账号或密码。
`tools/kkap_service.py` 在后台每 30 秒抓取一次，去重多时段行后从内存提供只读 JSON：

- `GET /healthz`：最近刷新时间、状态、条数和错误。
- `GET /api/enrollments`：`[课程名, 班级名, 教师, 已选人数]` 紧凑数组。

服务失败时继续提供最后一次成功快照；前端异步刷新，不会阻塞课程浏览。

## VPS 目录

```text
~/apps/jxnu-kkap/
├── kkap_monitor.py
├── kkap_service.py
└── kkap.env
```

`kkap.env` 以 `deploy/kkap.env.example` 为模板。测试阶段 CORS 只允许：

- `https://test.better-jxnu-elective-system.pages.dev`
- 本地 Vite 的 `localhost:5173` / `127.0.0.1:5173`

用户级 systemd 单元安装到 `~/.config/systemd/user/kkap-realtime.service`：

```bash
systemctl --user daemon-reload
systemctl --user enable --now kkap-realtime.service
sudo loginctl enable-linger "$USER"
curl http://127.0.0.1:8787/healthz
```

如果当前账号不能执行 `loginctl enable-linger`，使用仓库内 `run-kkap.sh` 配合用户 crontab：

```bash
@reboot /home/guiguisocute/apps/jxnu-kkap/run-kkap.sh # jxnu-kkap
```

`run-kkap.sh` 使用 `flock` 保证只运行一个实例；首次部署时用 `nohup setsid` 启动同一脚本。

## 域名与反代

Caddy 配置见 `deploy/Caddyfile.getxk`。Debian VPS 首次部署：

```bash
sudo apt-get install -y caddy
sudo install -o root -g root -m 0644 Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo systemctl restart caddy
```

TCP 80/443 用于 HTTP/HTTPS 和自动签发证书，UDP 443 用于 HTTP/3。

在 Cloudflare 为 `jxnu-publish.asia` 新增记录：

```text
Type: A
Name: getxk
IPv4: <VPS 公网 IP>
Proxy: 首次签发证书时 DNS only（灰云）；验证 HTTPS 后可切换 Proxied（橙云）
TTL: Auto
```

等待 DNS 生效后验证：

```bash
curl https://getxk.jxnu-publish.asia/healthz
curl -H 'Origin: https://test.better-jxnu-elective-system.pages.dev' \
  -I https://getxk.jxnu-publish.asia/api/enrollments
```

正式站启用前，再把正式 Pages 域名加入 `KKAP_ALLOWED_ORIGINS`；测试阶段不要加入。

---

## 开课安排 + 实时容量安全增量同步（sync-schedule）

无登录抓 `Public_Kkap.aspx`（开课安排/增班）→ 复用旧 enrichment → 真账号登录 xk 实抓教学班容量
（`tools/crawl_capacity.py`）→ `build_data.py` → 校验 → 仅在有变化时 `git push`（触发 CF Pages 部署）。
VPS 全自动，每小时一次，不再手动「油猴 + 构建 + 提交」/手动跑容量爬虫。

**为什么安全**
- 开课安排 base 是 Public_Kkap 的**当前全量快照**，全替换、不累加陈旧行（根治旧版「无脑加超集」）。
- 教号(UserNum)等 enrichment 从上一份已提交的 `formal_schedule.json` 按 `(课程号,班级号,教师)` **复用**，只有全新教学班才缺（教号走姓名兜底，实测仅个位数差异）。
- 容量爬取失败（登录挂了/网络问题）或可见课程数过少（选课阶段变了导致 `Step` 前缀失配，见 `tools/crawl_capacity.py` 头部注释）时，**丢弃当次容量结果、保留仓库里上一份**，不影响开课安排那部分照常 push。
- 三道闸：开课安排抓取行数 `< --min-rows(6000)` 拒绝输出；`git pull --ff-only` 分叉就放弃（不强推，保你手动改动）；产物 `formal_sections < 7000` 回滚不推。

**一次性部署（VPS）**
```bash
# 1) 仓库已加 Deploy Key(写)，用 SSH remote 克隆到家目录
git clone git@github.com:guiguisocute/better-jxnu-elective-system.git ~/better-jxnu-elective-system
cd ~/better-jxnu-elective-system
git config user.email "vps@jxnu-publish.asia" && git config user.name "jxnu-vps"

# 2) 容量爬取凭据：复制模板到 kkap.env 同目录（仓库外，不随 git 同步），填真账号密码
cp deploy/sync.env.example ~/apps/jxnu-kkap/sync.env
chmod 600 ~/apps/jxnu-kkap/sync.env
vi ~/apps/jxnu-kkap/sync.env   # XK_USERNAME / XK_PASSWORD / XK_STEP

# 3) 装 timer（每小时一次；选课季可调密，也可临时改稀）
mkdir -p ~/.config/systemd/user
cp deploy/kkap-schedule.service deploy/kkap-schedule.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now kkap-schedule.timer

# 4) 手动验证一次
./deploy/sync-schedule.sh
systemctl --user list-timers | grep kkap-schedule
```

**选课阶段变了、容量长期被跳过时**：先用 `python3 tools/crawl_capacity.py --probe 3` 核对 `Default_config.aspx`
回显的当前阶段和实际能拿到数据的 `Step` 前缀，改 `~/apps/jxnu-kkap/sync.env` 里的 `XK_STEP` 即可，不用改代码。

---

## 管理面板（jxnu-admin）

`tools/admin_service.py` 是部署在 VPS 上的运维配置 WebUI（单文件、Python 3.11 标准库、零第三方依赖；
仅 Cloudflare API 部分可选用系统级 requests）。只绑 `127.0.0.1:8790`，**不暴露公网**。

能干什么：总览各服务状态与六个学期旋钮的一致性检查 / 切换当前学期（isCurrent）/
编辑 `data/build_config.json` / 白名单编辑三个 env 文件（kkap / sync / live）/
重启服务、手动触发同步、探测容量阶段 / 改 Cloudflare Pages 环境变量并触发部署 / 看 journalctl 日志。
所有仓库写操作走 `repo_op`（停 kkap-schedule.timer → 等 service 空闲 → flock sync.lock →
`git pull --ff-only` → 改文件 → `build_data.py` + sanity → commit/push → 恢复 timer），与每小时同步互斥。

### 安装（VPS 上，幂等可重跑）

```bash
cd ~/better-jxnu-elective-system && git pull --ff-only
./deploy/install-admin.sh
```

首次运行会生成 `~/apps/jxnu-admin/admin.env`（600 权限）并 **echo 一个随机 ADMIN_PASSWORD——立刻保存**。
之后重跑只更新 `admin_service.py` 与 unit 并重启，不动 admin.env。

### 访问（SSH 隧道）

```bash
ssh -L 8790:127.0.0.1:8790 <VPS别名>   # <VPS别名> = 本地 ~/.ssh/config 里配好的主机别名（含跳板/密钥）
```

保持该连接，然后浏览器打开 `http://127.0.0.1:8790`，用 admin.env 里的 `ADMIN_PASSWORD` 登录。

### admin.env 键说明

| 键 | 说明 |
| --- | --- |
| `ADMIN_BIND` / `ADMIN_PORT` | 监听地址/端口，默认 `127.0.0.1:8790`，别改成公网地址 |
| `ADMIN_PASSWORD` | 登录密码（必填；安装脚本自动生成随机值） |
| `REPO_DIR` | 仓库 clone 位置，repo_op 的 git / build_data.py 在此执行 |
| `KKAP_ENV` / `SYNC_ENV` / `LIVE_ENV` | 三个服务 env 文件路径（面板做白名单键编辑，写回后 chmod 600） |
| `SYNC_LOCK` | 与每小时同步互斥的 flock 锁文件路径 |
| `CF_ACCOUNT_ID` / `CF_API_TOKEN` / `CF_PAGES_PROJECT` | Cloudflare Pages API（可空；不配则 /ai 页只显示指引） |

### Cloudflare API Token 创建指引

dash.cloudflare.com → 右上角 **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**：

- Permissions：`Account / Cloudflare Pages / Edit`
- Account Resources：选自己的账号
- 建好后把 token 填进 `admin.env` 的 `CF_API_TOKEN`，Account ID（dashboard 任意域概览页右侧栏）填 `CF_ACCOUNT_ID`，
  然后 `systemctl --user restart jxnu-admin`。

注意：面板里改 `LIVE_SECRET` 必须 **VPS 侧（live.env）与 Cloudflare 侧（/ai 页）两边同步**，
否则学号实时导入会回落 D1 快照；Cloudflare 环境变量改完需触发新部署（/ai 页有按钮）才生效。
