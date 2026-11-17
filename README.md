# imgbed — 给 Agent 用的 Cloudflare 图床

把图片存在 **Cloudflare R2**，图片说明/标签存在 **D1**，用一个 **Worker** 对外提供：

- 永久公开链接：`https://img.你的域名/2026/11/AbCdEf123456.png`，公众号、Notion、Obsidian、博客可同时引用
- 每张图都有**说明 + 标签**，可以按中文关键词搜回来（"上次那张架构图"）
- 给 agent 的三种接入方式：**CLI**、**HTTP API（curl）**、**MCP**（Claude Code / Claude Desktop 等直接调用）
- 相同图片自动去重（按 SHA-256），重复上传返回原链接
- 一个简单的网页管理界面（浏览 / 搜索 / 拖拽上传 / 改说明 / 删除）

## 当前部署

| 项 | 值 |
|---|---|
| 地址 | https://img.duetread.com （管理页面、API、MCP 都在这个域名下） |
| Worker | `imgbed`，自定义域名 `img.duetread.com` |
| R2 存储桶 | `imgbed` |
| D1 数据库 | `imgbed`（`database_id` 已写在 `wrangler.jsonc`） |
| 访问 Token | Worker Secret `API_TOKEN`，本人另行保存，不在仓库里 |

日常维护：

```bash
npm run deploy                        # 改了代码后重新部署
npm run db:migrate:remote             # 新增了 migrations/ 里的 SQL 后执行
npx wrangler secret put API_TOKEN     # 换访问 Token（旧的立即失效，记得同步更新各 agent 的配置）
npx wrangler tail                     # 实时查看线上日志

# 对线上跑端到端测试（会上传几张测试图，结束后自动删除）
IMGBED_URL=https://img.duetread.com IMGBED_TOKEN=<token> npm test
```

> 如果你是 fork 这个仓库自己部署，需要把 `wrangler.jsonc` 里的 `database_id`、`PUBLIC_BASE_URL`、`routes` 换成你自己的，按下面"部署"一节从头做。

## 架构

```
agent / CLI / 网页 ──(Bearer Token)──▶ Worker ──▶ R2  (图片文件)
                                        │     └─▶ D1  (说明、标签、尺寸、来源…)
公众号 / Notion / Obsidian ──(公开 GET)──▶ Worker ──▶ 边缘缓存 ──▶ R2
```

## 费用：基本是 0 元

| 服务 | 免费额度 | 个人图床的实际用量 |
|---|---|---|
| R2 存储 | 每月 10 GB | 1 万张 500 KB 的图 ≈ 5 GB |
| R2 写操作 (Class A) | 每月 100 万次 | 每次上传 1 次 |
| R2 读操作 (Class B) | 每月 1000 万次 | 有边缘缓存，实际更少 |
| R2 流量 (egress) | **完全免费，不限量** | — |
| Workers | 每天 10 万次请求 | 每次图片访问/API 调用算 1 次 |
| D1 | 5 GB，每天 500 万行读 / 10 万行写 | 远远用不完 |

注意：

- **开通 R2 需要绑定支付方式**（信用卡或 PayPal）。这只是开通条件，免费额度内不会扣费；超出后才按量计费（存储约 $0.015/GB/月）。
- Workers 用免费计划即可，不需要 $5/月 的付费计划。免费计划每次请求 CPU 时间上限 10ms，图片上传用的是原生哈希，正常大小的图片（几 MB 以内）没问题。
- 可以在 Cloudflare 后台设置账单提醒，安心一些。

## 部署（约 10 分钟）

前置：一个 Cloudflare 账号；本地有 Node.js 18+。**强烈建议**有一个托管在 Cloudflare 的域名（原因见下文"各平台注意事项"）。

```bash
git clone <本仓库> imgbed && cd imgbed
npm install
npx wrangler login
```

不方便用浏览器登录（比如在 CI 或云端 agent 里部署）时，改用 API Token：在 Cloudflare 后台 → My Profile → API Tokens 用 **"Edit Cloudflare Workers"** 模板创建，并确认包含以下权限，然后设置环境变量 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`：

- 账号级：Workers Scripts: Edit、Workers R2 Storage: Edit、D1: Edit、Account Settings: Read
- 域名级（你的域名）：Workers Routes: Edit、Zone: Read；要用 API 管理 DNS 记录的话再加 DNS: Edit

1. 在 Cloudflare 后台 → R2 → 开通 R2（绑定支付方式），然后创建存储桶和数据库：

   ```bash
   npx wrangler r2 bucket create imgbed
   npx wrangler d1 create imgbed
   ```

2. 把 `d1 create` 输出的 `database_id` 填进 `wrangler.jsonc`（替换掉现有的值）。

3. 初始化数据库表：

   ```bash
   npm run db:migrate:remote
   ```

4. 设置 API Token（自己生成一个长随机串，agent 和网页都用它）：

   ```bash
   openssl rand -hex 32          # 生成一个，复制下来
   npx wrangler secret put API_TOKEN
   ```

5. 绑定自定义域名：把 `wrangler.jsonc` 里 `routes` 的 `pattern` 和 `PUBLIC_BASE_URL` 改成你的域名（如 `img.example.com` / `https://img.example.com`）。该子域名不能已有 DNS 记录，部署时 Cloudflare 会自动创建记录和证书。

6. 部署：

   ```bash
   npm run deploy
   ```

打开 `https://img.example.com/`，输入 Token，就能看到管理页面。

### 本地开发 / 测试

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                                   # http://localhost:8787
npm test                                      # 另开一个终端，端到端冒烟测试
```

## 让 agent 使用

### 方式一：CLI（最推荐，能直接传本地文件）

```bash
npm install -g .        # 在仓库目录执行，得到 imgbed 命令；或直接 node scripts/imgbed.mjs
export IMGBED_URL=https://img.example.com
export IMGBED_TOKEN=你的token
export IMGBED_SOURCE=claude-code   # 可选，记录是谁传的
```

也可以写到 `~/.config/imgbed/config.json`：`{"url": "https://img.example.com", "token": "..."}`

```bash
imgbed upload ./cover.png -d "文章封面：深蓝背景上的白色标题‘自建图床’" -t 公众号,封面 --md
imgbed upload https://example.com/a.png -d "..."      # 让服务器去抓远程图片
imgbed search 封面 图床                                # 多个关键词同时匹配
imgbed search -t 公众号
imgbed update <id> -d "新的说明" -t a,b
imgbed delete <id>
```

所有命令输出 JSON（含 `url`、`markdown`、`id`、`width`、`height`…），`--md` / `--url` 只输出一行，方便 agent 直接用。

**Claude Code 用户**：把 `skills/imgbed/` 复制到 `~/.claude/skills/imgbed/`，agent 就知道什么时候、怎么用图床，以及要写什么样的说明。其他 agent 可以把 `skills/imgbed/SKILL.md` 的内容放进它们的系统提示 / AGENTS.md。

### 方式二：MCP

适合不能执行命令的客户端（如 Claude Desktop、网页版）。

```bash
claude mcp add --transport http imgbed https://img.example.com/mcp \
  --header "Authorization: Bearer 你的token"
```

提供的工具：`upload_image`（传 `url` 或 `data_base64`）、`search_images`、`get_image`、`update_image`、`delete_image`。
本地大文件走 MCP 需要 base64，会占用很多上下文，能用 CLI 就用 CLI。

### 方式三：HTTP API

所有 `/api/*` 和 `/mcp` 都需要 `Authorization: Bearer <token>`（或 `X-API-Key`）。图片链接本身是公开的。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/images` | 上传。三种格式任选：`multipart/form-data`（`file`/`url`、`description`、`tags`、`filename`）；`application/json`（`url` 或 `data_base64`，加 `description`、`tags`）；原始二进制 + 查询参数 `?description=&tags=&filename=` |
| `GET` | `/api/images?q=&tag=&limit=&offset=` | 搜索 / 列表（按时间倒序，`q` 空格分隔多个关键词） |
| `GET` | `/api/images/:id` | 单张图片信息 |
| `PATCH` | `/api/images/:id` | 修改 `description` / `tags` / `filename`，链接不变 |
| `DELETE` | `/api/images/:id` | 删除（文件和记录一起删） |
| `POST` | `/mcp` | MCP（Streamable HTTP，无状态） |
| `GET` | `/<yyyy>/<mm>/<id>.<ext>` | 公开图片地址，带一年的不可变缓存 |

```bash
curl -H "Authorization: Bearer $IMGBED_TOKEN" \
  -F file=@cover.png -F description="文章封面" -F tags="公众号,封面" \
  https://img.example.com/api/images
```

返回示例：

```json
{
  "id": "GiXUMxPb8xpk",
  "url": "https://img.example.com/2026/11/GiXUMxPb8xpk.png",
  "markdown": "![文章封面](https://img.example.com/2026/11/GiXUMxPb8xpk.png)",
  "content_type": "image/png", "size": 6903, "width": 400, "height": 300,
  "description": "文章封面", "tags": ["公众号", "封面"],
  "source": "claude-code", "duplicate": false,
  "created_at": "2026-11-16T13:45:00.000Z"
}
```

支持格式：PNG、JPEG、GIF、WebP、AVIF、SVG、BMP、ICO（按文件内容识别，不信任扩展名）。默认单张上限 20 MB（`MAX_UPLOAD_MB`）。

## 各平台注意事项

- **微信公众号**：在公众号编辑器里粘贴外链图片时，微信会把图片**转存到它自己的服务器**（mmbiz.qpic.cn），发出去的文章不再依赖图床。所以图床只要在你编辑时能被微信访问到就行。
- **国内访问**：`*.workers.dev` 默认域名在国内经常打不开，`r2.dev` 也有限速且不建议生产使用，**请绑定自定义域名**。Cloudflare 在国内速度一般但基本可用。
- **Notion**：用 `/image` → Embed link 粘贴图片链接即可，Notion 引用的是外链，图床要一直在线。
- **Obsidian**：直接用返回的 `markdown`，`![说明](链接)`。
- **删除要谨慎**：除公众号外，其他地方引用的都是实时链接，删掉就破图。

## 安全

- Token 只存在 Worker Secret 和你的 agent 配置里；网页端只存在当前浏览器的 localStorage。
- 图片路径带 12 位随机 ID，无法枚举；`robots.txt` 禁止收录。
- SVG 以严格的 CSP + sandbox 返回，避免脚本在图床域名下执行。
- 换 Token：`npx wrangler secret put API_TOKEN` 重新设置即可，旧 Token 立即失效。

## 目录

```
src/index.ts        路由、鉴权、公开图片访问（边缘缓存）
src/images.ts       上传/去重/搜索/修改/删除
src/sniff.ts        按文件头识别图片格式和尺寸
src/mcp.ts          MCP 服务端
src/ui.ts           管理网页
migrations/         D1 表结构
scripts/imgbed.mjs  CLI（零依赖）
scripts/smoke-test.mjs  端到端测试
skills/imgbed/      给 agent 的使用说明（Claude Code Skill）
```
