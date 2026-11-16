// Minimal stateless MCP server (Streamable HTTP transport, JSON responses).
// Agents connect with: POST /mcp  +  Authorization: Bearer <API_TOKEN>

import {
  type Env,
  HttpError,
  createImage,
  decodeBase64,
  deleteImage,
  fetchRemoteImage,
  filenameFromUrl,
  getImage,
  listImages,
  updateImage,
} from "./images";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `imgbed is a personal image host. Every image gets a permanent public URL that can be
embedded in WeChat articles, Notion, Obsidian, Markdown, etc.
- Always write a concise but specific description of what the image shows (in the user's language) and a few tags,
  so the image can be found again later via search_images.
- Before uploading something that may already exist, search_images first; identical bytes are deduplicated anyway.
- Use the returned "markdown" field to embed the image.
- To upload a LOCAL file, prefer the imgbed CLI / HTTP API (curl) instead of base64 through this tool.`;

const TOOLS = [
  {
    name: "upload_image",
    description:
      "Upload an image and record what it shows. Provide exactly one of `url` (the server downloads it) or " +
      "`data_base64` (raw or data: URI, best for small images). Returns the permanent public URL and a Markdown snippet. " +
      "Identical images are deduplicated and the existing record is returned.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL of an image to fetch and store" },
        data_base64: { type: "string", description: "Base64 image bytes (optionally a data: URI)" },
        description: {
          type: "string",
          description: "What the image shows / why it exists. Searchable. Be specific.",
        },
        tags: { type: "array", items: { type: "string" }, description: "Short keywords, e.g. project or article name" },
        filename: { type: "string", description: "Optional original file name" },
      },
      required: ["description"],
    },
  },
  {
    name: "search_images",
    description:
      "Search stored images by keywords (matched against description, tags, filename; all keywords must match) " +
      "and/or an exact tag. Empty query lists the newest images.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tag: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
    },
  },
  {
    name: "get_image",
    description: "Get one image's metadata (URL, markdown, description, tags, size, dimensions) by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "update_image",
    description: "Change an image's description, tags (replaces the whole list) or filename. The URL never changes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        filename: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_image",
    description:
      "Permanently delete an image. Any article that embeds its URL will show a broken image. Only do this when the user asks.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { destructiveHint: true },
  },
];

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const rpcResult = (id: JsonRpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

async function callTool(env: Env, base: string, name: string, args: any, source: string) {
  args = args || {};
  switch (name) {
    case "upload_image": {
      const hasUrl = typeof args.url === "string" && args.url;
      const hasData = typeof args.data_base64 === "string" && args.data_base64;
      if (!hasUrl === !hasData) throw new HttpError(400, "provide exactly one of url or data_base64");
      const bytes = hasUrl ? await fetchRemoteImage(env, args.url) : decodeBase64(args.data_base64);
      const { image, duplicate } = await createImage(env, base, {
        bytes,
        filename: args.filename ?? (hasUrl ? filenameFromUrl(args.url) : null),
        description: args.description,
        tags: args.tags,
        source,
        sourceUrl: hasUrl ? args.url : null,
      });
      return { ...image, duplicate };
    }
    case "search_images":
      return listImages(env, base, { q: args.query, tag: args.tag, limit: args.limit, offset: args.offset });
    case "get_image":
      return getImage(env, base, String(args.id ?? ""));
    case "update_image":
      return updateImage(env, base, String(args.id ?? ""), args);
    case "delete_image":
      return { deleted: await deleteImage(env, String(args.id ?? "")) };
    default:
      throw new HttpError(404, `unknown tool: ${name}`);
  }
}

async function handleMessage(env: Env, base: string, msg: JsonRpcRequest, source: string) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "imgbed", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      try {
        const out = await callTool(env, base, params?.name, params?.arguments, source);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
          isError: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return rpcResult(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export async function handleMcp(request: Request, env: Env, base: string): Promise<Response> {
  if (request.method === "GET") {
    // We don't offer a server->client SSE stream.
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, DELETE" } });
  }
  if (request.method === "DELETE") return new Response(null, { status: 204 }); // stateless: nothing to end
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "parse error"), { status: 400 });
  }

  const clientName = request.headers.get("x-imgbed-source") || "mcp";
  const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[];
  const responses = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
      responses.push(rpcError(null, -32600, "invalid request"));
      continue;
    }
    if (msg.id === undefined) continue; // notification (e.g. notifications/initialized)
    responses.push(await handleMessage(env, base, msg, clientName));
  }

  if (!responses.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
