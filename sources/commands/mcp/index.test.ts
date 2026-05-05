import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyClient } from "@/client";
import type { CommandContext } from "@/commands/types";
import { saveToken } from "@/secureStore";
import { callMcpTool } from "./index";

type BunServer = ReturnType<typeof Bun.serve>;

describe("mcp command", () => {
  const originalConfigDir = process.env["BEE_CONFIG_DIR"];
  const originalForceFileStore = process.env["BEE_FORCE_FILE_STORE"];
  const activeServers: BunServer[] = [];
  let tempDir = "";

  afterEach(() => {
    for (const server of activeServers.splice(0, activeServers.length)) {
      server.stop(true);
    }
    if (originalConfigDir === undefined) {
      delete process.env["BEE_CONFIG_DIR"];
    } else {
      process.env["BEE_CONFIG_DIR"] = originalConfigDir;
    }
    if (originalForceFileStore === undefined) {
      delete process.env["BEE_FORCE_FILE_STORE"];
    } else {
      process.env["BEE_FORCE_FILE_STORE"] = originalForceFileStore;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("calls Bee API tools without exposing credentials to tool arguments", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bee-cli-mcp-"));
    process.env["BEE_CONFIG_DIR"] = tempDir;
    process.env["BEE_FORCE_FILE_STORE"] = "1";
    await saveToken("prod", "mcp-test-token");

    const seen = {
      authorization: null as string | null,
    };
    let seenPath = "";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        seen.authorization = request.headers.get("authorization");
        const url = new URL(request.url);
        seenPath = `${url.pathname}${url.search}`;
        return Response.json({ id: 1, first_name: "Mcp", last_name: "User" });
      },
    });
    activeServers.push(upstream);

    const baseUrl = `http://127.0.0.1:${upstream.port}`;
    const context: CommandContext = {
      env: "prod",
      client: {
        env: "prod",
        baseUrl,
        isProxy: false,
        fetch: (path, init) => fetch(new URL(path, baseUrl), init),
      },
    };

    const result = await callMcpTool(context, "bee_profile");

    expect(result).toEqual({ id: 1, first_name: "Mcp", last_name: "User" });
    expect(seenPath).toBe("/v1/me");
    expect(seen.authorization).toBe("Bearer mcp-test-token");
  });

  it("uses existing unix socket proxy client without injecting credentials", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bee-cli-mcp-socket-"));
    const socketPath = join(tempDir, "proxy.sock");
    const seen = {
      authorization: null as string | null,
      path: "",
    };

    const upstream = Bun.serve({
      unix: socketPath,
      fetch: (request) => {
        seen.authorization = request.headers.get("authorization");
        const url = new URL(request.url);
        seen.path = `${url.pathname}${url.search}`;
        return Response.json({ facts: [], next_cursor: null });
      },
    });
    activeServers.push(upstream);

    const context: CommandContext = {
      env: "prod",
      client: createProxyClient("prod", { address: socketPath }),
    };

    const result = await callMcpTool(context, "bee_list_facts", {
      limit: 2,
      unconfirmed: true,
    });

    expect(result).toEqual({ facts: [], next_cursor: null });
    expect(seen.path).toBe("/v1/facts?limit=2&confirmed=false");
    expect(seen.authorization).toBeNull();
  });

  it("validates tool arguments before calling upstream", async () => {
    const context: CommandContext = {
      env: "prod",
      client: {
        env: "prod",
        baseUrl: "http://127.0.0.1",
        isProxy: true,
        fetch: () => {
          throw new Error("should not call upstream");
        },
      },
    };

    await expect(callMcpTool(context, "bee_get_fact", { id: "1" })).rejects.toThrow(
      "id must be a positive integer."
    );
  });
});
