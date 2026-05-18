# Multi-channel OpenAI-compatible Router Worker

一个轻量 Cloudflare Worker，用 KV 保存多个 OpenAI-compatible 渠道配置和轮询游标。Worker 对外暴露 `/v1/*`，按请求里的 `model` 筛选可用渠道，轮询转发；遇到 401、403、429、5xx 等可重试状态会自动切到下一个渠道。

它适合独立成一个小 repo/worker，作为 newapi 前面或旁边的边缘聚合层。

## 渠道配置

KV key:

- `router:channels`: 渠道数组
- `router:cursor:<model>`: 每个模型的轮询游标
- `router:cursor:default`: 没有模型信息时的默认游标

渠道对象:

```json
{
  "id": "nvidia-1",
  "name": "NVIDIA",
  "baseUrl": "https://integrate.api.nvidia.com/v1",
  "apiKey": "nvapi-xxx",
  "enabled": true,
  "models": ["meta/llama-3.1-70b-instruct"]
}
```

`models` 为空或不填表示这个渠道接受所有模型。

## 初始化

```powershell
npm install
npx wrangler kv namespace create CHANNEL_STORE
```

把命令返回的 namespace id 填进 `wrangler.jsonc` 的 `kv_namespaces[0].id`。

设置管理 token:

```powershell
npx wrangler secret put ADMIN_TOKEN
```

设置后台账号密码:

```powershell
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ADMIN_SESSION_SECRET
```

`ADMIN_TOKEN` 仍然可用于脚本调用管理 API；浏览器后台使用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录，登录后通过 HttpOnly Cookie 访问管理接口。

如果希望 `/v1/*` 调用也需要鉴权，再设置:

```powershell
npx wrangler secret put PROXY_API_KEY
```

## 写入渠道池

```powershell
curl -X PUT "https://你的-worker.workers.dev/admin/channels" `
  -H "Authorization: Bearer <ADMIN_TOKEN>" `
  -H "Content-Type: application/json" `
  --data "{\"channels\":[{\"id\":\"nvidia\",\"baseUrl\":\"https://integrate.api.nvidia.com/v1\",\"apiKey\":\"nvapi-xxx\",\"models\":[\"meta/llama-3.1-70b-instruct\"]},{\"id\":\"openai\",\"baseUrl\":\"https://api.openai.com/v1\",\"apiKey\":\"sk-xxx\",\"models\":[\"gpt-4.1-mini\"]}]}"
```

查看渠道池:

```powershell
curl "https://你的-worker.workers.dev/admin/channels" `
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

## OpenAI-compatible 调用

```powershell
curl "https://你的-worker.workers.dev/v1/chat/completions" `
  -H "Authorization: Bearer <PROXY_API_KEY>" `
  -H "Content-Type: application/json" `
  --data "{\"model\":\"meta/llama-3.1-70b-instruct\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}"
```

如果未设置 `PROXY_API_KEY`，`/v1/*` 不会校验调用方 token，只负责换成渠道自己的 `apiKey` 转发。

根路径 `/` 会跳转到 `/admin`，只影响浏览器打开首页。OpenAI-compatible API 不走 `/admin`:

- 客户端会自动拼 `/v1` 时，base URL 填你的 Worker 域名，例如 `https://你的域名`
- 客户端不会自动拼 `/v1` 时，base URL 填你的 Worker 域名加 `/v1`，例如 `https://你的域名/v1`

## 后台管理页面

部署后打开:

```text
https://你的-worker.workers.dev/admin
```

页面会要求输入 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。后台页面支持:

- 查看和编辑完整渠道 JSON
- 保存渠道池到 KV
- 查看渠道数量、启用数量
- 查看每个模型的轮询游标
- 执行 `/health` 检查
- 检测每个渠道是否可用

后台页面读取完整 `apiKey` 会调用 `/admin/channels/raw`，这个接口同样需要 `ADMIN_TOKEN`。
渠道可用性检测会调用 `/admin/channels/check`，Worker 会依次请求每个渠道的 OpenAI-compatible `/models`，并返回 HTTP 状态、耗时和错误信息。

## 本地运行

```powershell
npm run dev
```

## 部署

```powershell
npm run deploy
```

## GitHub Actions 部署

仓库已包含 `.github/workflows/deploy.yml`。推送到 `main` 或手动运行 workflow 时会执行:

```text
npm ci
npm run check
npm run build
npx wrangler deploy
```

需要在 GitHub 仓库里添加 Secret:

- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare 账户 ID。
- `CLOUDFLARE_API_TOKEN`: Cloudflare API Token，需要有部署 Workers 的权限。
- `CLOUDFLARE_KV_NAMESPACE_ID`: `CHANNEL_STORE` 的 KV namespace id。

Worker 默认名称是 `apioai`。如果要改名，可以在 GitHub 仓库的 Variables 或 Secrets 里添加:

- `WORKER_NAME`: 自定义 Worker 名称，例如 `newapi-router`。

第一次部署前仍然要先创建 KV namespace:

```powershell
npx wrangler kv namespace create CHANNEL_STORE
```

如果使用 GitHub Actions 部署，不需要把真实 KV id 提交到仓库，workflow 会用 `CLOUDFLARE_KV_NAMESPACE_ID` 自动替换 `wrangler.jsonc` 里的占位符。

生产环境 secrets 也要写入 Cloudflare Workers，而不是 GitHub Actions:

```powershell
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ADMIN_SESSION_SECRET
npx wrangler secret put PROXY_API_KEY
```

## 注意

KV 的读写不是强一致原子递增，所以高并发下轮询游标可能出现轻微重复。若要做严格均匀分配、渠道熔断、冷却时间、权重调度或失败统计，建议把运行态迁到 Durable Object；KV 继续保存渠道配置即可。
