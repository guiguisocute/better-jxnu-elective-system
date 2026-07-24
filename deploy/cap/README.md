# Cap 自托管人机验证

Cap Standalone 与 Valkey 通过 Docker Compose 运行，只把 `127.0.0.1:3000` 暴露给宿主机。公网由 Caddy 的 `/cap/*` 反向代理进入，Cap 控制台本身建议通过 SSH 隧道访问：

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

镜像与浏览器组件版本已固定：

- Cap Standalone `3.1.8`
- `@cap.js/widget` `0.1.56`（前端打包）
- `@cap.js/wasm` `0.0.7`（由本机 `/cap/assets/cap_wasm_bg.wasm` 提供）

Cap 的站点密钥和 Site Secret 在 Cap 控制台创建；随后到 Go 后端面板「评价管理 → 人机验证」选择 Cap，填写：

- API 根地址：`https://getxk.jxnu-publish.asia/cap`
- Site Key / Site Secret：Cap 控制台生成的值
- WASM 地址：可留空（前端自动推导 `/cap/assets/cap_wasm_bg.wasm`）
- 分别勾选「保护评价提交」和/或「保护学号查询」

Turnstile 凭据不会因切换到 Cap 而删除，两者由 `captcha_provider` 保证互斥。

## 健康检查

```bash
docker-compose ps
docker-compose logs --tail=100 cap
curl -I https://getxk.jxnu-publish.asia/cap/assets/cap_wasm_bg.wasm
curl -X POST https://getxk.jxnu-publish.asia/cap/<site-key>/challenge
```

服务端验证契约：

```http
POST https://getxk.jxnu-publish.asia/cap/<site-key>/siteverify
Content-Type: application/json

{"secret":"<site-secret>","response":"<widget-token>"}
```
