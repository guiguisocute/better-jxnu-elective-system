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
loginctl enable-linger "$USER"
curl http://127.0.0.1:8787/healthz
```

如果当前账号不能执行 `loginctl enable-linger`，使用仓库内 `run-kkap.sh` 配合用户 crontab：

```bash
@reboot /home/guiguisocute/apps/jxnu-kkap/run-kkap.sh # jxnu-kkap
```

`run-kkap.sh` 使用 `flock` 保证只运行一个实例；首次部署时用 `nohup setsid` 启动同一脚本。

## 域名与反代

Caddy 配置见 `deploy/Caddyfile.getxk`。需要开放 VPS 的 TCP 80/443。

在 Cloudflare 为 `jxnu-publish.asia` 新增记录：

```text
Type: A
Name: getxk
IPv4: 38.76.188.214
Proxy: Proxied（橙云）
TTL: Auto
```

等待 DNS 生效后验证：

```bash
curl https://getxk.jxnu-publish.asia/healthz
curl -H 'Origin: https://test.better-jxnu-elective-system.pages.dev' \
  -I https://getxk.jxnu-publish.asia/api/enrollments
```

正式站启用前，再把正式 Pages 域名加入 `KKAP_ALLOWED_ORIGINS`；测试阶段不要加入。
