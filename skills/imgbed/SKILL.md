---
name: imgbed
description: Upload images to the user's personal image host (imgbed on Cloudflare) and get permanent public URLs / Markdown for WeChat articles, Notion, Obsidian, blogs. Use whenever an image needs a public link, when writing articles that contain images, or when looking for an image uploaded earlier ("那张架构图", "上次的封面").
---

# imgbed — personal image host

Images are stored on Cloudflare R2; each one has a permanent public URL plus a searchable
description and tags (stored in D1). Uploading the same bytes twice returns the existing image.

## Config

`IMGBED_URL` and `IMGBED_TOKEN` must be set (or `~/.config/imgbed/config.json` with `{"url","token"}`).
Set `IMGBED_SOURCE` to your agent name (e.g. `claude-code`) so uploads are attributed.

## Upload

Always write a description of **what the image actually shows** (in the user's language, 1–3 sentences,
including any visible text, chart type, subject) and 1–5 tags (project / article / topic).
The description is the only way to find the image again.

```bash
# local file (CLI ships in this repo: scripts/imgbed.mjs; or `npm i -g` the repo to get `imgbed`)
imgbed upload ./diagram.png -d "R2 + Worker + D1 的图床架构图，箭头表示上传和访问流程" -t imgbed,架构图 --md

# remote image: the server downloads it
imgbed upload https://example.com/a.png -d "..." -t ...

# without the CLI
curl -sS -H "Authorization: Bearer $IMGBED_TOKEN" -F file=@./diagram.png \
  -F description="..." -F tags="a,b" "$IMGBED_URL/api/images"
```

The JSON response contains `url`, `markdown`, `id`, `width`, `height`, `duplicate`.
Use `markdown` (or `url`) directly in the article.

## Find / reuse

```bash
imgbed search 架构图 封面          # all keywords must match description/tags/filename
imgbed search -t 公众号 -n 50       # by exact tag
imgbed get <id> --md
```

Search before uploading generated images you may have made before.

## Edit / delete

```bash
imgbed update <id> -d "better description" -t tag1,tag2   # URL never changes
imgbed delete <id>   # breaks every article embedding it — only when the user asks
```

## MCP alternative

`POST $IMGBED_URL/mcp` (Bearer token) exposes `upload_image` (url or base64), `search_images`,
`get_image`, `update_image`, `delete_image`. For local files prefer the CLI/curl over base64.
