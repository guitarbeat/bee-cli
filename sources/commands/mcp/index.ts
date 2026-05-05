import type { Command, CommandContext } from "@/commands/types";
import { requestClientJson } from "@/client/clientApi";
import { PACKAGE_NAME, VERSION } from "@/version";

const USAGE = "bee mcp";
const PROTOCOL_VERSION = "2024-11-05";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };
type JsonRpcId = string | number | null;

type McpTool = {
  name: string;
  description: string;
  inputSchema: JsonObject;
  call: (context: CommandContext, args: Record<string, unknown>) => Promise<unknown>;
};

export const mcpCommand: Command = {
  name: "mcp",
  description: "Start a stdio MCP server for tokenless Bee access by local agents.",
  usage: USAGE,
  run: async (args, context) => {
    if (args.length > 0) {
      throw new Error(`Unexpected arguments: ${args.join(" ")}`);
    }
    await startMcpServer(context);
  },
};

export async function callMcpTool(
  context: CommandContext,
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const tool = toolIndex.get(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.call(context, args);
}

export async function startMcpServer(context: CommandContext): Promise<void> {
  await new Promise<void>((resolve) => {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    process.stdin.on("data", (chunk: Buffer | string) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer = Buffer.concat([buffer, data]);
      buffer = drainMessages(context, buffer);
    });
    process.stdin.on("end", () => {
      resolve();
    });
    process.stdin.resume();
  });
}

function drainMessages(
  context: CommandContext,
  input: Buffer<ArrayBufferLike>
): Buffer<ArrayBufferLike> {
  let buffer = input;

  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return buffer;
    }

    const headers = buffer.subarray(0, headerEnd).toString("ascii");
    const contentLength = parseContentLength(headers);
    if (contentLength === null) {
      process.stderr.write("Invalid MCP message: missing Content-Length header\n");
      return Buffer.alloc(0);
    }

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) {
      return buffer;
    }

    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);

    let message: unknown;
    try {
      message = JSON.parse(body) as unknown;
    } catch {
      writeJsonRpcResponse(null, undefined, {
        code: -32700,
        message: "Parse error",
      });
      continue;
    }

    void handleJsonRpcMessage(context, message);
  }
}

function parseContentLength(headers: string): number | null {
  for (const line of headers.split("\r\n")) {
    const [name, ...rest] = line.split(":");
    if (name?.toLowerCase() !== "content-length") {
      continue;
    }
    const value = rest.join(":").trim();
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

async function handleJsonRpcMessage(
  context: CommandContext,
  message: unknown
): Promise<void> {
  if (!isObject(message)) {
    writeJsonRpcResponse(null, undefined, {
      code: -32600,
      message: "Invalid Request",
    });
    return;
  }

  const id = normalizeId(message["id"]);
  const hasId = "id" in message;
  const method = message["method"];
  if (typeof method !== "string") {
    if (hasId) {
      writeJsonRpcResponse(id, undefined, {
        code: -32600,
        message: "Invalid Request",
      });
    }
    return;
  }

  try {
    const result = await handleMcpMethod(context, method, message["params"]);
    if (hasId) {
      writeJsonRpcResponse(id, result);
    }
  } catch (error) {
    if (hasId) {
      writeJsonRpcResponse(id, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : "Tool call failed",
      });
    }
  }
}

async function handleMcpMethod(
  context: CommandContext,
  method: string,
  params: unknown
): Promise<JsonValue> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: PACKAGE_NAME,
          version: VERSION,
        },
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    case "tools/call":
      return await handleToolCall(context, params);
    case "notifications/initialized":
      return {};
    default:
      throw new Error(`Unsupported MCP method: ${method}`);
  }
}

async function handleToolCall(
  context: CommandContext,
  params: unknown
): Promise<JsonObject> {
  if (!isObject(params) || typeof params["name"] !== "string") {
    throw new Error("tools/call requires a tool name.");
  }

  const args = isObject(params["arguments"]) ? params["arguments"] : {};
  const result = await callMcpTool(context, params["name"], args);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

function writeJsonRpcResponse(
  id: JsonRpcId,
  result?: JsonValue,
  error?: { code: number; message: string }
): void {
  const payload = error
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result: result ?? null };
  const body = JSON.stringify(payload);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

const emptySchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

const listSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1 },
    cursor: { type: "string" },
  },
};

const idSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "integer", minimum: 1 },
  },
};

const tools: McpTool[] = [
  {
    name: "bee_profile",
    description: "Fetch the authenticated Bee developer profile.",
    inputSchema: emptySchema,
    call: (context) => getJson(context, "/v1/me"),
  },
  {
    name: "bee_today",
    description: "Fetch today's Bee brief, including calendar and email context.",
    inputSchema: emptySchema,
    call: (context) => getJson(context, "/v1/todayBrief"),
  },
  {
    name: "bee_changed",
    description: "Fetch recently changed Bee entity ids, optionally from a cursor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: { type: "string" },
      },
    },
    call: (context, args) => {
      const params = new URLSearchParams();
      const cursor = optionalString(args, "cursor");
      if (cursor) {
        params.set("cursor", cursor);
      }
      return getJson(context, withQuery("/v1/changes", params));
    },
  },
  {
    name: "bee_search_conversations",
    description: "Search Bee conversations by text or neural search.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1 },
        since: { type: "number" },
        until: { type: "number" },
        neural: { type: "boolean" },
      },
    },
    call: (context, args) => {
      const body: Record<string, JsonValue> = {
        query: requiredString(args, "query"),
      };
      const limit = optionalPositiveInteger(args, "limit");
      if (limit !== undefined) {
        body["limit"] = limit;
      }
      const since = optionalNumber(args, "since");
      if (since !== undefined) {
        body["since"] = since;
      }
      const until = optionalNumber(args, "until");
      if (until !== undefined) {
        body["until"] = until;
      }
      const path = optionalBoolean(args, "neural")
        ? "/v1/search/conversations/neural"
        : "/v1/search/conversations";
      return requestClientJson(context, path, { method: "POST", json: body });
    },
  },
  {
    name: "bee_list_facts",
    description: "List confirmed Bee facts, or unconfirmed facts when requested.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1 },
        cursor: { type: "string" },
        unconfirmed: { type: "boolean" },
      },
    },
    call: (context, args) => {
      const params = listParams(args);
      params.set("confirmed", optionalBoolean(args, "unconfirmed") ? "false" : "true");
      return getJson(context, withQuery("/v1/facts", params));
    },
  },
  {
    name: "bee_get_fact",
    description: "Fetch a Bee fact by id.",
    inputSchema: idSchema,
    call: (context, args) => getJson(context, `/v1/facts/${requiredPositiveInteger(args, "id")}`),
  },
  {
    name: "bee_list_todos",
    description: "List Bee todos.",
    inputSchema: listSchema,
    call: (context, args) => getJson(context, withQuery("/v1/todos", listParams(args))),
  },
  {
    name: "bee_get_todo",
    description: "Fetch a Bee todo by id.",
    inputSchema: idSchema,
    call: (context, args) => getJson(context, `/v1/todos/${requiredPositiveInteger(args, "id")}`),
  },
  {
    name: "bee_list_conversations",
    description: "List Bee conversations.",
    inputSchema: listSchema,
    call: (context, args) => getJson(context, withQuery("/v1/conversations", listParams(args))),
  },
  {
    name: "bee_get_conversation",
    description: "Fetch a Bee conversation transcript by id.",
    inputSchema: idSchema,
    call: (context, args) =>
      getJson(context, `/v1/conversations/${requiredPositiveInteger(args, "id")}`),
  },
  {
    name: "bee_list_daily",
    description: "List Bee daily summaries.",
    inputSchema: listSchema,
    call: (context, args) => getJson(context, withQuery("/v1/daily", listParams(args))),
  },
  {
    name: "bee_get_daily",
    description: "Fetch a Bee daily summary by id.",
    inputSchema: idSchema,
    call: (context, args) => getJson(context, `/v1/daily/${requiredPositiveInteger(args, "id")}`),
  },
  {
    name: "bee_list_journals",
    description: "List Bee journals.",
    inputSchema: listSchema,
    call: (context, args) => getJson(context, withQuery("/v1/journals", listParams(args))),
  },
  {
    name: "bee_get_journal",
    description: "Fetch a Bee journal by id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1 },
      },
    },
    call: (context, args) => getJson(context, `/v1/journals/${encodeURIComponent(requiredString(args, "id"))}`),
  },
];

const toolIndex = new Map(tools.map((tool) => [tool.name, tool]));

function getJson(context: CommandContext, path: string): Promise<unknown> {
  return requestClientJson(context, path, { method: "GET" });
}

function listParams(args: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  const limit = optionalPositiveInteger(args, "limit");
  if (limit !== undefined) {
    params.set("limit", String(limit));
  }
  const cursor = optionalString(args, "cursor");
  if (cursor !== undefined) {
    params.set("cursor", cursor);
  }
  return params;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  name: string
): string | undefined {
  const value = args[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function requiredPositiveInteger(args: Record<string, unknown>, name: string): number {
  const value = optionalPositiveInteger(args, name);
  if (value === undefined) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function optionalPositiveInteger(
  args: Record<string, unknown>,
  name: string
): number | undefined {
  const value = args[name];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function optionalNumber(
  args: Record<string, unknown>,
  name: string
): number | undefined {
  const value = args[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function normalizeId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
