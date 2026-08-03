# Cap 自托管人机验证

Cap Standalone 与 Valkey 通过 Docker Compose 运行，只把 `127.0.0.1:3000` 暴露给宿主机。Caddy 仅公开 WASM 文件及 `challenge`、`redeem`、`siteverify` 三个按站点划分的 API；其他 `/cap/*` 一律返回 404。Cap 控制台只能通过 SSH 隧道访问：

```bash
ssh -L 3000:127.0.0.1:3000 29HK
```

然后打开 `http://127.0.0.1:3000`。

## 安装 / 升级

```bash
cd ~/better-jxnu-elective-system/deploy/cap
cp .env.example .env
openssl rand -base64 48 | tr -d '\n'   # 写入 CAP_ADMIN_KEY，至少 32 字符
chmod 600 .env
docker-compose pull
docker-compose up -d
```

容器镜像同时固定版本标签和多架构清单 digest，升级时应先用 `docker buildx imagetools inspect <image:tag>` 核对新 digest，再修改 Compose：

- Cap Standalone `3.1.8`
- `@cap.js/widget` `0.1.56`（前端打包）
- `@cap.js/wasm` `0.0.7`（由本机 `/cap/assets/cap_wasm_bg.wasm` 提供）

Cap 的站点密钥和 Site Secret 在 Cap 控制台创建；随后到 Go 后端面板「评价管理 → 人机验证」选择 Cap，填写：

- API 根地址：`https://getxk.betterjxnu.cn/cap`
- Site Key / Site Secret：Cap 控制台生成的值
- WASM 地址：可留空（前端自动推导 `/cap/assets/cap_wasm_bg.wasm`）
- 分别勾选「保护评价提交」「保护举报提交」和/或「保护学号查询」

Turnstile 凭据不会因切换到 Cap 而删除，两者由 `captcha_provider` 保证互斥。

## 健康检查

```bash
docker-compose ps
docker-compose logs --tail=100 cap
curl -I https://getxk.betterjxnu.cn/cap/assets/cap_wasm_bg.wasm
curl -X POST https://getxk.betterjxnu.cn/cap/<site-key>/challenge
```

服务端验证契约：

```http
POST https://getxk.betterjxnu.cn/cap/<site-key>/siteverify
Content-Type: application/json

{"secret":"<site-secret>","response":"<widget-token>"}
```
