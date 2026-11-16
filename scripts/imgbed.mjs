#!/usr/bin/env node
// imgbed CLI — zero dependencies, Node 18+.
// Config: IMGBED_URL (e.g. https://img.example.com) and IMGBED_TOKEN, or ~/.config/imgbed/config.json
//
//   imgbed upload <file|url> -d "说明" [-t tag1,tag2] [--md|--url]
//   imgbed search [关键词...] [-t tag] [-n 20] [--offset 0]
//   imgbed get <id>
//   imgbed update <id> [-d "新说明"] [-t tag1,tag2]
//   imgbed delete <id>

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { homedir } from "node:os";

const USAGE = `用法:
  imgbed upload <文件路径|URL> -d "图片说明" [-t 标签1,标签2] [--md | --url]
  imgbed search [关键词 ...] [-t 标签] [-n 数量] [--offset N]
  imgbed get <id>
  imgbed update <id> [-d "新说明"] [-t 标签1,标签2]
  imgbed delete <id>

环境变量: IMGBED_URL, IMGBED_TOKEN（或 ~/.config/imgbed/config.json: {"url": "...", "token": "..."}）
可选: IMGBED_SOURCE 标记上传来源（默认 cli）
输出均为 JSON；--md 只输出 Markdown，--url 只输出链接。`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) die(`缺少 ${a} 的值`);
      return argv[++i];
    };
    if (a === "-d" || a === "--description") out.description = next();
    else if (a === "-t" || a === "--tags" || a === "--tag") out.tags = next();
    else if (a === "-n" || a === "--limit") out.limit = next();
    else if (a === "--offset") out.offset = next();
    else if (a === "--filename") out.filename = next();
    else if (a === "--md") out.md = true;
    else if (a === "--url") out.urlOnly = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else out._.push(a);
  }
  return out;
}

function die(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

async function config() {
  let file = {};
  try {
    file = JSON.parse(await readFile(`${homedir()}/.config/imgbed/config.json`, "utf8"));
  } catch {}
  const url = (process.env.IMGBED_URL || file.url || "").replace(/\/+$/, "");
  const token = process.env.IMGBED_TOKEN || file.token || "";
  if (!url || !token) die("请设置 IMGBED_URL 和 IMGBED_TOKEN（或 ~/.config/imgbed/config.json）");
  return { url, token, source: process.env.IMGBED_SOURCE || file.source || "cli" };
}

async function call(cfg, path, init = {}) {
  const res = await fetch(cfg.url + path, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.token}`, "X-Imgbed-Source": cfg.source, ...(init.headers || {}) },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  if (!res.ok) die(`HTTP ${res.status}: ${data.error || text}`);
  return data;
}

const print = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + "\n");

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!cmd || args.help || cmd === "help") return console.log(USAGE);
  const cfg = await config();

  switch (cmd) {
    case "upload":
    case "up": {
      const target = args._[0];
      if (!target) die("upload 需要文件路径或 URL");
      if (!args.description) process.stderr.write("提示: 建议用 -d 写上图片说明，方便以后搜索\n");
      let img;
      if (/^https?:\/\//i.test(target)) {
        img = await call(cfg, "/api/images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: target,
            description: args.description,
            tags: args.tags,
            filename: args.filename,
            source: cfg.source,
          }),
        });
      } else {
        const bytes = await readFile(target).catch((e) => die(`读取文件失败: ${e.message}`));
        const fd = new FormData();
        fd.append("file", new Blob([bytes]), args.filename || basename(target));
        if (args.description) fd.append("description", args.description);
        if (args.tags) fd.append("tags", args.tags);
        img = await call(cfg, "/api/images", { method: "POST", body: fd });
      }
      if (args.md) return console.log(img.markdown);
      if (args.urlOnly) return console.log(img.url);
      return print(img);
    }
    case "search":
    case "ls":
    case "list": {
      const qs = new URLSearchParams();
      if (args._.length) qs.set("q", args._.join(" "));
      if (args.tags) qs.set("tag", args.tags);
      if (args.limit) qs.set("limit", args.limit);
      if (args.offset) qs.set("offset", args.offset);
      return print(await call(cfg, `/api/images?${qs}`));
    }
    case "get": {
      if (!args._[0]) die("get 需要 id");
      const img = await call(cfg, `/api/images/${encodeURIComponent(args._[0])}`);
      if (args.md) return console.log(img.markdown);
      if (args.urlOnly) return console.log(img.url);
      return print(img);
    }
    case "update":
    case "edit": {
      if (!args._[0]) die("update 需要 id");
      const body = {};
      if (args.description != null) body.description = args.description;
      if (args.tags != null) body.tags = args.tags;
      if (args.filename != null) body.filename = args.filename;
      return print(
        await call(cfg, `/api/images/${encodeURIComponent(args._[0])}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    }
    case "delete":
    case "rm": {
      if (!args._[0]) die("delete 需要 id");
      return print(await call(cfg, `/api/images/${encodeURIComponent(args._[0])}`, { method: "DELETE" }));
    }
    default:
      die(`未知命令: ${cmd}\n\n${USAGE}`);
  }
}

main().catch((e) => die(e?.message || String(e)));
