import {
  type Env,
  HttpError,
  baseUrl,
  createImage,
  decodeBase64,
  deleteImage,
  fetchRemoteImage,
  filenameFromUrl,
  getImage,
  listImages,
  updateImage,
} from "./images";
import { handleMcp } from "./mcp";
import { UI_HTML } from "./ui";

// Public image paths look like /2026/11/AbCdEf123456.png
const IMAGE_PATH = /^\/(\d{4}\/\d{2}\/[0-9A-Za-z]{6,32}\.[a-z0-9]{2,5})$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      const m = path.match(IMAGE_PATH);
      if (m && (request.method === "GET" || request.method === "HEAD")) {
        return await serveImage(request, env, ctx, m[1]);
      }
      if (path === "/" && request.method === "GET") {
        return new Response(UI_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      if (path === "/health") return Response.json({ ok: true });
      if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n");

      if (path === "/mcp" || path.startsWith("/api/")) {
        if (!env.API_TOKEN) throw new HttpError(500, "API_TOKEN secret is not configured");
        if (!(await authorized(request, env))) {
          return Response.json(
            { error: "unauthorized" },
            { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="imgbed"' } },
          );
        }
        const base = baseUrl(env, request);
        if (path === "/mcp") return await handleMcp(request, env, base);
        return await handleApi(request, env, ctx, base, url);
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      console.error(err);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "") || request.headers.get("X-API-Key") || "";
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(env.API_TOKEN);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

async function serveImage(request: Request, env: Env, ctx: ExecutionContext, key: string) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });

  if (request.method === "GET") {
    const hit = await cache.match(request);
    if (hit) return hit;
  }

  const obj =
    request.method === "HEAD" ? await env.BUCKET.head(key) : await env.BUCKET.get(key);
  if (!obj) return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Length", String(obj.size));
  if (headers.get("Content-Type") === "image/svg+xml") {
    // SVG can carry scripts; never let it run on this origin.
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  }

  if (request.headers.get("If-None-Match") === obj.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  if (!("body" in obj)) return new Response(null, { headers });

  const response = new Response((obj as R2ObjectBody).body, { headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  base: string,
  url: URL,
): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  const qs = url.searchParams;
  const source = request.headers.get("X-Imgbed-Source") || qs.get("source");

  if (path === "/api/images" && method === "GET") {
    return Response.json(
      await listImages(env, base, {
        q: qs.get("q"),
        tag: qs.get("tag"),
        limit: Number(qs.get("limit")) || null,
        offset: Number(qs.get("offset")) || null,
      }),
    );
  }

  if (path === "/api/images" && method === "POST") {
    const ct = (request.headers.get("Content-Type") || "").toLowerCase();
    let result;

    if (ct.startsWith("multipart/form-data")) {
      // curl -F file=@a.png -F description=... -F tags=a,b
      const form = await request.formData();
      const file = form.get("file");
      const remote = form.get("url");
      if (!(file instanceof File) && typeof remote !== "string") {
        throw new HttpError(400, "multipart upload needs a `file` (or `url`) field");
      }
      const bytes =
        file instanceof File
          ? new Uint8Array(await file.arrayBuffer())
          : await fetchRemoteImage(env, remote as string);
      result = await createImage(env, base, {
        bytes,
        filename: str(form.get("filename")) ?? (file instanceof File ? file.name : filenameFromUrl(remote as string)),
        description: str(form.get("description")),
        tags: str(form.get("tags")),
        source: str(form.get("source")) ?? source ?? "api",
        sourceUrl: file instanceof File ? null : (remote as string),
      });
    } else if (ct.startsWith("application/json")) {
      // {"url": "..."} or {"data_base64": "..."}, plus description/tags/filename
      const body = (await request.json().catch(() => null)) as any;
      if (!body || typeof body !== "object") throw new HttpError(400, "invalid JSON body");
      if (!body.url === !body.data_base64) throw new HttpError(400, "provide exactly one of url or data_base64");
      const bytes = body.url ? await fetchRemoteImage(env, body.url) : decodeBase64(body.data_base64);
      result = await createImage(env, base, {
        bytes,
        filename: body.filename ?? (body.url ? filenameFromUrl(body.url) : null),
        description: body.description,
        tags: body.tags,
        source: body.source ?? source ?? "api",
        sourceUrl: body.url ?? null,
      });
    } else {
      // Raw bytes: curl --data-binary @a.png "…/api/images?description=…&tags=a,b"
      const bytes = new Uint8Array(await request.arrayBuffer());
      result = await createImage(env, base, {
        bytes,
        filename: qs.get("filename") ?? headerText(request, "X-Filename"),
        description: qs.get("description") ?? headerText(request, "X-Description"),
        tags: qs.get("tags") ?? headerText(request, "X-Tags"),
        source: source ?? "api",
      });
    }
    return Response.json({ ...result.image, duplicate: result.duplicate }, { status: result.duplicate ? 200 : 201 });
  }

  const m = path.match(/^\/api\/images\/([0-9A-Za-z]+)$/);
  if (m) {
    const id = m[1];
    if (method === "GET") return Response.json(await getImage(env, base, id));
    if (method === "PATCH" || method === "PUT") {
      const body = (await request.json().catch(() => null)) as any;
      if (!body || typeof body !== "object") throw new HttpError(400, "invalid JSON body");
      return Response.json(await updateImage(env, base, id, body));
    }
    if (method === "DELETE") {
      const deleted = await deleteImage(env, id);
      ctx.waitUntil(caches.default.delete(`${base}/${deleted.key}`).catch(() => false));
      return Response.json({ deleted });
    }
    throw new HttpError(405, "method not allowed");
  }

  throw new HttpError(404, "not found");
}

function str(v: string | File | null): string | null {
  return typeof v === "string" ? v : null;
}

// Non-ASCII header values must be percent-encoded by the client.
function headerText(request: Request, name: string): string | null {
  const v = request.headers.get(name);
  if (v == null) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
