import { sniffImage } from "./sniff";

export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  API_TOKEN: string;
  PUBLIC_BASE_URL?: string;
  MAX_UPLOAD_MB?: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface ImageRow {
  id: string;
  key: string;
  filename: string | null;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  sha256: string;
  description: string;
  tags: string;
  source: string | null;
  source_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImageDTO {
  id: string;
  url: string;
  markdown: string;
  key: string;
  filename: string | null;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  description: string;
  tags: string[];
  source: string | null;
  source_url: string | null;
  sha256: string;
  created_at: string;
  updated_at: string;
}

export interface CreateInput {
  bytes: Uint8Array;
  filename?: string | null;
  description?: string | null;
  tags?: string[] | string | null;
  source?: string | null;
  sourceUrl?: string | null;
}

export interface UpdateInput {
  description?: string | null;
  tags?: string[] | string | null;
  filename?: string | null;
}

export interface ListInput {
  q?: string | null;
  tag?: string | null;
  limit?: number | null;
  offset?: number | null;
}

// ---------- helpers ----------

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function newId(len = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 62];
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeTags(tags: string[] | string | null | undefined): string[] {
  if (tags == null) return [];
  const list = Array.isArray(tags) ? tags : tags.split(/[,，、]/);
  const seen = new Set<string>();
  for (const t of list) {
    const v = String(t).replace(/[,，、]/g, " ").trim();
    if (v) seen.add(v);
  }
  return [...seen].slice(0, 30);
}

const encodeTags = (tags: string[]) => (tags.length ? `,${tags.join(",")},` : "");
const decodeTags = (s: string) => s.split(",").filter(Boolean);

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

function cleanText(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  return String(s).trim().slice(0, max);
}

export function baseUrl(env: Env, request: Request): string {
  const configured = (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return configured || new URL(request.url).origin;
}

function toDTO(row: ImageRow, base: string): ImageDTO {
  const url = `${base}/${row.key}`;
  const alt = (row.description || row.filename || row.id).replace(/[\[\]\n\r]/g, " ").slice(0, 120);
  return {
    id: row.id,
    url,
    markdown: `![${alt}](${url})`,
    key: row.key,
    filename: row.filename,
    content_type: row.content_type,
    size: row.size,
    width: row.width,
    height: row.height,
    description: row.description,
    tags: decodeTags(row.tags),
    source: row.source,
    source_url: row.source_url,
    sha256: row.sha256,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------- operations ----------

export async function createImage(
  env: Env,
  base: string,
  input: CreateInput,
): Promise<{ image: ImageDTO; duplicate: boolean }> {
  const maxBytes = Number(env.MAX_UPLOAD_MB || "20") * 1024 * 1024;
  const { bytes } = input;
  if (!bytes.length) throw new HttpError(400, "empty file");
  if (bytes.length > maxBytes) {
    throw new HttpError(413, `file too large (max ${env.MAX_UPLOAD_MB || 20} MB)`);
  }

  const info = sniffImage(bytes);
  if (!info) throw new HttpError(415, "not a supported image (png/jpeg/gif/webp/avif/svg/bmp/ico)");

  const hash = await sha256Hex(bytes);
  const description = cleanText(input.description, 4000) ?? "";
  const tags = normalizeTags(input.tags);

  // Dedupe: same bytes -> return the existing record (fill in missing metadata).
  const existing = await env.DB.prepare("SELECT * FROM images WHERE sha256 = ?")
    .bind(hash)
    .first<ImageRow>();
  if (existing) {
    const patch: UpdateInput = {};
    if (!existing.description && description) patch.description = description;
    if (tags.length) {
      const merged = normalizeTags([...decodeTags(existing.tags), ...tags]);
      if (merged.length !== decodeTags(existing.tags).length) patch.tags = merged;
    }
    const image = Object.keys(patch).length
      ? await updateImage(env, base, existing.id, patch)
      : toDTO(existing, base);
    return { image, duplicate: true };
  }

  const id = newId();
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const key = `${yyyy}/${mm}/${id}.${info.ext}`;
  const iso = now.toISOString();

  await env.BUCKET.put(key, bytes, {
    httpMetadata: {
      contentType: info.contentType,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: { id },
    sha256: hash,
  });

  const row: ImageRow = {
    id,
    key,
    filename: cleanText(input.filename, 255),
    content_type: info.contentType,
    size: bytes.length,
    width: info.width,
    height: info.height,
    sha256: hash,
    description,
    tags: encodeTags(tags),
    source: cleanText(input.source, 100),
    source_url: cleanText(input.sourceUrl, 2000),
    created_at: iso,
    updated_at: iso,
  };

  try {
    await env.DB.prepare(
      `INSERT INTO images (id, key, filename, content_type, size, width, height, sha256,
         description, tags, source, source_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id, row.key, row.filename, row.content_type, row.size, row.width, row.height,
        row.sha256, row.description, row.tags, row.source, row.source_url,
        row.created_at, row.updated_at,
      )
      .run();
  } catch (err) {
    // Don't leave an orphan object behind (e.g. a concurrent upload of the same bytes won).
    await env.BUCKET.delete(key);
    const winner = await env.DB.prepare("SELECT * FROM images WHERE sha256 = ?")
      .bind(hash)
      .first<ImageRow>();
    if (winner) return { image: toDTO(winner, base), duplicate: true };
    throw err;
  }

  return { image: toDTO(row, base), duplicate: false };
}

export async function getImage(env: Env, base: string, id: string): Promise<ImageDTO> {
  const row = await env.DB.prepare("SELECT * FROM images WHERE id = ?").bind(id).first<ImageRow>();
  if (!row) throw new HttpError(404, `image ${id} not found`);
  return toDTO(row, base);
}

export async function updateImage(
  env: Env,
  base: string,
  id: string,
  input: UpdateInput,
): Promise<ImageDTO> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (input.description != null) {
    sets.push("description = ?");
    args.push(cleanText(input.description, 4000));
  }
  if (input.tags != null) {
    sets.push("tags = ?");
    args.push(encodeTags(normalizeTags(input.tags)));
  }
  if (input.filename != null) {
    sets.push("filename = ?");
    args.push(cleanText(input.filename, 255));
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    args.push(new Date().toISOString());
    const res = await env.DB.prepare(`UPDATE images SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...args, id)
      .run();
    if (!res.meta.changes) throw new HttpError(404, `image ${id} not found`);
  }
  return getImage(env, base, id);
}

export async function deleteImage(env: Env, id: string): Promise<{ id: string; key: string }> {
  const row = await env.DB.prepare("SELECT id, key FROM images WHERE id = ?")
    .bind(id)
    .first<{ id: string; key: string }>();
  if (!row) throw new HttpError(404, `image ${id} not found`);
  await env.BUCKET.delete(row.key);
  await env.DB.prepare("DELETE FROM images WHERE id = ?").bind(id).run();
  return row;
}

export async function listImages(
  env: Env,
  base: string,
  input: ListInput,
): Promise<{ total: number; limit: number; offset: number; items: ImageDTO[] }> {
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
  const offset = Math.max(Number(input.offset) || 0, 0);
  const where: string[] = [];
  const args: unknown[] = [];

  // Every whitespace-separated keyword must match description, filename or tags.
  // LIKE (not FTS5) on purpose: SQLite's FTS tokenizers don't segment Chinese.
  const terms = (input.q || "").trim().split(/\s+/).filter(Boolean).slice(0, 10);
  for (const term of terms) {
    const p = `%${escapeLike(term)}%`;
    where.push(
      "(description LIKE ? ESCAPE '\\' OR filename LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR id = ?)",
    );
    args.push(p, p, p, term);
  }
  for (const tag of normalizeTags(input.tag)) {
    where.push("tags LIKE ? ESCAPE '\\'");
    args.push(`%,${escapeLike(tag)},%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [count, rows] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM images ${whereSql}`).bind(...args),
    env.DB.prepare(
      `SELECT * FROM images ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).bind(...args, limit, offset),
  ]);
  const total = (count.results[0] as { n: number } | undefined)?.n ?? 0;
  return {
    total,
    limit,
    offset,
    items: (rows.results as unknown as ImageRow[]).map((r) => toDTO(r, base)),
  };
}

// ---------- byte sources ----------

export async function fetchRemoteImage(env: Env, url: string): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "invalid url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(400, "url must be http(s)");
  }
  const maxBytes = Number(env.MAX_UPLOAD_MB || "20") * 1024 * 1024;
  const res = await fetch(parsed.toString(), {
    headers: { "User-Agent": "imgbed/0.1 (+image fetch)", Accept: "image/*,*/*;q=0.5" },
    redirect: "follow",
  });
  if (!res.ok) throw new HttpError(502, `fetching url failed: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > maxBytes) throw new HttpError(413, "remote file too large");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new HttpError(413, "remote file too large");
  return buf;
}

export function decodeBase64(data: string): Uint8Array {
  const clean = data.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
  let bin: string;
  try {
    bin = atob(clean);
  } catch {
    throw new HttpError(400, "invalid base64 data");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function filenameFromUrl(url: string): string | null {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}
