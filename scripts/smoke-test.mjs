#!/usr/bin/env node
// End-to-end smoke test against a running instance.
//   npx wrangler d1 migrations apply imgbed --local && npx wrangler dev   (in another terminal)
//   IMGBED_URL=http://localhost:8787 IMGBED_TOKEN=dev-token-change-me npm test
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

const BASE = (process.env.IMGBED_URL || "http://localhost:8787").replace(/\/+$/, "");
const TOKEN = process.env.IMGBED_TOKEN || "dev-token-change-me";
const auth = { Authorization: `Bearer ${TOKEN}` };

// Build a valid PNG of the given size with a random pixel so every run is unique.
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function req(path, init = {}) {
  const res = await fetch(BASE + path, init);
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json() : await res.arrayBuffer();
  return { res, body };
}

let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);
const created = [];

try {
  // auth
  let r = await req("/api/images");
  assert.equal(r.res.status, 401);
  ok("API rejects missing token");

  // raw upload with Chinese description in query string
  const a = png(32, 24);
  const tag = `smoke${Date.now()}`;
  r = await req(`/api/images?description=${encodeURIComponent("测试图：一张随机噪点图")}&tags=${tag},测试&filename=a.png`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/octet-stream" },
    body: a,
  });
  assert.equal(r.res.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.width, 32);
  assert.equal(r.body.height, 24);
  assert.equal(r.body.content_type, "image/png");
  assert.deepEqual(r.body.tags, [tag, "测试"]);
  assert.match(r.body.url, /\/\d{4}\/\d{2}\/[0-9A-Za-z]{12}\.png$/);
  created.push(r.body.id);
  const first = r.body;
  ok(`raw upload → ${first.url}`);

  // public fetch, no auth
  r = await req(new URL(first.url).pathname);
  assert.equal(r.res.status, 200);
  assert.equal(r.res.headers.get("content-type"), "image/png");
  assert.equal(Buffer.compare(Buffer.from(r.body), a), 0);
  ok("public URL serves identical bytes without token");

  // dedupe
  const fd = new FormData();
  fd.append("file", new Blob([a]), "again.png");
  fd.append("tags", "额外");
  r = await req("/api/images", { method: "POST", headers: auth, body: fd });
  assert.equal(r.res.status, 200);
  assert.equal(r.body.duplicate, true);
  assert.equal(r.body.id, first.id);
  assert.ok(r.body.tags.includes("额外"));
  ok("identical bytes are deduplicated (tags merged)");

  // multipart upload
  const b = png(10, 10);
  const fd2 = new FormData();
  fd2.append("file", new Blob([b]), "b.png");
  fd2.append("description", "公众号封面草稿 第二张");
  fd2.append("tags", `${tag}，封面`);
  r = await req("/api/images", { method: "POST", headers: auth, body: fd2 });
  assert.equal(r.res.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.tags, [tag, "封面"]);
  created.push(r.body.id);
  ok("multipart upload (Chinese comma in tags)");

  // reject non-image
  r = await req("/api/images", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/octet-stream" },
    body: "hello world, not an image",
  });
  assert.equal(r.res.status, 415);
  ok("non-image rejected");

  // search: Chinese keyword, multiple terms, tag filter
  r = await req(`/api/images?q=${encodeURIComponent("噪点")}`, { headers: auth });
  assert.ok(r.body.items.some((i) => i.id === first.id));
  r = await req(`/api/images?q=${encodeURIComponent("封面 第二张")}&tag=${tag}`, { headers: auth });
  assert.equal(r.body.total, 1);
  r = await req(`/api/images?tag=${tag}`, { headers: auth });
  assert.equal(r.body.total, 2);
  r = await req(`/api/images?q=${encodeURIComponent("100%_")}`, { headers: auth });
  assert.equal(r.res.status, 200);
  ok("search by Chinese keywords / tag works, LIKE wildcards escaped");

  // update
  r = await req(`/api/images/${first.id}`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ description: "改过的说明", tags: [tag] }),
  });
  assert.equal(r.body.description, "改过的说明");
  assert.deepEqual(r.body.tags, [tag]);
  assert.equal(r.body.url, first.url);
  ok("update description/tags keeps URL");

  // MCP
  const mcp = (body) =>
    req("/mcp", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
  r = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  assert.equal(r.body.result.serverInfo.name, "imgbed");
  assert.equal(r.body.result.protocolVersion, "2025-06-18");
  r = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(r.res.status, 202);
  r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    r.body.result.tools.map((t) => t.name).sort(),
    ["delete_image", "get_image", "search_images", "update_image", "upload_image"],
  );
  const c = png(5, 7);
  r = await mcp({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "upload_image", arguments: { data_base64: "data:image/png;base64," + c.toString("base64"), description: "MCP 上传的小图", tags: [tag] } },
  });
  assert.equal(r.body.result.isError, false, JSON.stringify(r.body));
  assert.equal(r.body.result.structuredContent.width, 5);
  created.push(r.body.result.structuredContent.id);
  r = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_images", arguments: { query: "MCP", tag } } });
  assert.equal(r.body.result.structuredContent.total, 1);
  r = await mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_image", arguments: { id: "nope" } } });
  assert.equal(r.body.result.isError, true);
  ok("MCP initialize / tools/list / upload_image / search_images / error path");

  // delete
  for (const id of created.splice(0)) {
    r = await req(`/api/images/${id}`, { method: "DELETE", headers: auth });
    assert.equal(r.res.status, 200);
  }
  r = await req(new URL(first.url).pathname + "?nocache=1");
  assert.equal(r.res.status, 404);
  ok("delete removes record and file");

  console.log(`\nAll ${step} checks passed against ${BASE}`);
} finally {
  for (const id of created) await fetch(`${BASE}/api/images/${id}`, { method: "DELETE", headers: auth });
}
