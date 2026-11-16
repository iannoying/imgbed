// Small management page: browse / search / upload / edit descriptions.
// The API token is kept in this browser's localStorage only.
export const UI_HTML = /* html */ `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>imgbed</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e3e3e0; --accent:#f38020; --danger:#d93025; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#151516; --card:#1f1f21; --fg:#ececec; --muted:#9a9aa0; --line:#333336; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; gap:12px; align-items:center; padding:14px 20px; border-bottom:1px solid var(--line); background:var(--card); position:sticky; top:0; z-index:2; flex-wrap:wrap; }
  header h1 { font-size:17px; margin:0 8px 0 0; }
  input, textarea, button { font:inherit; color:inherit; }
  input, textarea { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:7px 10px; }
  button { border:1px solid var(--line); background:var(--card); border-radius:8px; padding:6px 12px; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:var(--danger); }
  #q { flex:1; min-width:180px; }
  main { padding:20px; max-width:1300px; margin:0 auto; }
  #drop { border:2px dashed var(--line); border-radius:12px; padding:16px; margin-bottom:20px; display:grid; gap:10px; }
  #drop.over { border-color:var(--accent); }
  #drop .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  #drop textarea { width:100%; min-height:54px; }
  #grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; display:flex; flex-direction:column; }
  .card .thumb { aspect-ratio: 4/3; background:repeating-conic-gradient(var(--line) 0 25%, transparent 0 50%) 0 0/16px 16px; display:flex; align-items:center; justify-content:center; }
  .card img { max-width:100%; max-height:100%; object-fit:contain; display:block; }
  .card .body { padding:10px 12px; display:grid; gap:6px; flex:1; }
  .desc { white-space:pre-wrap; word-break:break-word; }
  .meta { color:var(--muted); font-size:12px; }
  .tags span { display:inline-block; background:var(--bg); border:1px solid var(--line); border-radius:999px; padding:0 8px; margin:0 4px 4px 0; font-size:12px; cursor:pointer; }
  .actions { display:flex; gap:6px; flex-wrap:wrap; padding:0 12px 12px; }
  .actions button { padding:4px 8px; font-size:12px; }
  #more { display:block; margin:20px auto; }
  #toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:var(--fg); color:var(--bg); padding:8px 16px; border-radius:8px; opacity:0; transition:opacity .2s; pointer-events:none; }
  #toast.show { opacity:1; }
  .hidden { display:none !important; }
</style>
</head>
<body>
<header>
  <h1>imgbed</h1>
  <input id="q" type="search" placeholder="搜索说明 / 标签 / 文件名（空格分隔多个关键词）">
  <span class="meta" id="count"></span>
  <button id="logout">退出</button>
</header>
<main>
  <section id="login" class="hidden" style="max-width:420px;margin:60px auto;display:grid;gap:10px">
    <p>输入 API Token（即 <code>wrangler secret put API_TOKEN</code> 设置的值）。只保存在本浏览器。</p>
    <input id="token" type="password" placeholder="API Token">
    <button class="primary" id="save">进入</button>
  </section>
  <section id="app" class="hidden">
    <div id="drop">
      <div class="row">
        <input id="file" type="file" accept="image/*" multiple>
        <span class="meta">也可以直接拖拽或粘贴（Ctrl/Cmd+V）图片到页面</span>
      </div>
      <textarea id="desc" placeholder="图片说明：这张图展示了什么（便于以后搜索）"></textarea>
      <div class="row">
        <input id="tags" placeholder="标签，逗号分隔" style="flex:1">
        <button class="primary" id="upload">上传</button>
      </div>
    </div>
    <div id="grid"></div>
    <button id="more" class="hidden">加载更多</button>
  </section>
</main>
<div id="toast"></div>
<script>
const $ = (s) => document.querySelector(s);
let token = "";
try { token = localStorage.getItem("imgbed_token") || ""; } catch {}
let offset = 0, total = 0, pending = [];

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1800); }

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + token, "X-Imgbed-Source": "web" } });
  if (res.status === 401) { showLogin(); throw new Error("Token 无效"); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showLogin() { $("#login").classList.remove("hidden"); $("#app").classList.add("hidden"); }
function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); load(true); }

$("#save").onclick = () => { token = $("#token").value.trim(); try { localStorage.setItem("imgbed_token", token); } catch {} showApp(); };
$("#token").onkeydown = (e) => { if (e.key === "Enter") $("#save").click(); };
$("#logout").onclick = () => { token = ""; try { localStorage.removeItem("imgbed_token"); } catch {} showLogin(); };

const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB";
const copy = async (text, label) => { await navigator.clipboard.writeText(text); toast("已复制" + label); };

function card(img) {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = '<a class="thumb" target="_blank" rel="noopener"><img loading="lazy"></a><div class="body"><div class="desc"></div><div class="tags"></div><div class="meta"></div></div><div class="actions"><button data-a="url">URL</button><button data-a="md">Markdown</button><button data-a="edit">编辑</button><button data-a="del" class="danger">删除</button></div>';
  el.querySelector("a").href = img.url;
  const im = el.querySelector("img"); im.src = img.url; im.alt = img.description;
  el.querySelector(".desc").textContent = img.description || "（无说明）";
  const tags = el.querySelector(".tags");
  for (const t of img.tags) { const s = document.createElement("span"); s.textContent = t; s.onclick = () => { $("#q").value = t; load(true); }; tags.appendChild(s); }
  el.querySelector(".meta").textContent = [img.width && img.height ? img.width + "×" + img.height : "", fmtSize(img.size), img.source || "", img.created_at.slice(0, 10), img.id].filter(Boolean).join(" · ");
  el.querySelector(".actions").onclick = async (e) => {
    const a = e.target.dataset.a;
    try {
      if (a === "url") await copy(img.url, " URL");
      if (a === "md") await copy(img.markdown, " Markdown");
      if (a === "edit") {
        const d = prompt("图片说明", img.description); if (d === null) return;
        const t = prompt("标签（逗号分隔）", img.tags.join(", ")); if (t === null) return;
        const updated = await api("/api/images/" + img.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: d, tags: t }) });
        el.replaceWith(card(updated)); toast("已保存");
      }
      if (a === "del") {
        if (!confirm("确定永久删除？引用了这张图的文章会显示破图。")) return;
        await api("/api/images/" + img.id, { method: "DELETE" }); el.remove(); toast("已删除");
      }
    } catch (err) { toast(err.message); }
  };
  return el;
}

async function load(reset) {
  if (reset) { offset = 0; $("#grid").innerHTML = ""; }
  const q = encodeURIComponent($("#q").value.trim());
  try {
    const data = await api("/api/images?limit=40&offset=" + offset + "&q=" + q);
    total = data.total; offset += data.items.length;
    for (const img of data.items) $("#grid").appendChild(card(img));
    $("#count").textContent = total + " 张";
    $("#more").classList.toggle("hidden", offset >= total);
  } catch (err) { toast(err.message); }
}
$("#more").onclick = () => load(false);
let qt; $("#q").oninput = () => { clearTimeout(qt); qt = setTimeout(() => load(true), 300); };

function queue(files) {
  pending = [...files].filter((f) => f.type.startsWith("image/"));
  if (pending.length) toast("已选择 " + pending.length + " 张，填写说明后点上传");
}
$("#file").onchange = (e) => queue(e.target.files);
const drop = $("#drop");
document.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
document.addEventListener("dragleave", () => drop.classList.remove("over"));
document.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); queue(e.dataTransfer.files); });
document.addEventListener("paste", (e) => { if (e.clipboardData.files.length) queue(e.clipboardData.files); });

$("#upload").onclick = async () => {
  if (!pending.length) return toast("先选择图片");
  for (const f of pending) {
    const fd = new FormData();
    fd.append("file", f); fd.append("description", $("#desc").value); fd.append("tags", $("#tags").value);
    try {
      const img = await api("/api/images", { method: "POST", body: fd });
      toast(img.duplicate ? "已存在，返回原图" : "上传成功");
    } catch (err) { toast(err.message); }
  }
  pending = []; $("#file").value = ""; $("#desc").value = ""; $("#tags").value = "";
  load(true);
};

token ? showApp() : showLogin();
</script>
</body>
</html>`;
