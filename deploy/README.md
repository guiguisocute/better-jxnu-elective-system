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
IPv4: 38.76.188.214
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

## 开课安排安全增量同步（方案A · sync-schedule）

无登录抓 `Public_Kkap.aspx` → 复用旧 enrichment → `build_data.py` → 校验 → 仅在有变化时 `git push`（触发 CF Pages 部署）。VPS 全自动，不再手动「油猴 + 构建 + 提交」。

**为什么安全**
- base 是 Public_Kkap 的**当前全量快照**，全替换、不累加陈旧行（根治旧版「无脑加超集」）。
- 教号(UserNum)等 enrichment 从上一份已提交的 `formal_schedule.json` 按 `(课程号,班级号,教师)` **复用**，只有全新教学班才缺（教号走姓名兜底，实测仅个位数差异）。
- 三道闸：抓取行数 `< --min-rows(6000)` 拒绝输出；`git pull --ff-only` 分叉就放弃（不强推，保你手动改动）；产物 `formal_sections < 7000` 回滚不推。

**一次性部署（VPS）**
```bash
# 1) 仓库已加 Deploy Key(写)，用 SSH remote 克隆到家目录
git clone git@github.com:guiguisocute/better-jxnu-elective-system.git ~/better-jxnu-elective-system
cd ~/better-jxnu-elective-system
git config user.email "vps@jxnu-publish.asia" && git config user.name "jxnu-vps"

# 2) 装 timer（每 2 小时一次；选课季可改 OnUnitActiveSec）
mkdir -p ~/.config/systemd/user
cp deploy/kkap-schedule.service deploy/kkap-schedule.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now kkap-schedule.timer

# 3) 手动验证一次
./deploy/sync-schedule.sh
systemctl --user list-timers | grep kkap-schedule
```

**真容量到位后**：`build_data.py` 顶部 `TRUST_OPENCLASS_CAPACITY=False` 改回（或换成真容量源），重建即恢复容量显示。
