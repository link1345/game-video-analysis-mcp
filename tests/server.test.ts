import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FfmpegRunner } from "../src/media/ffmpeg.js";
import { createGameVideoAnalysisServer } from "../src/server.js";
import { withTempWorkspace } from "../src/media/temp.js";

describe("MCP server", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  test("starts for an MCP client and exposes foundation capabilities", async () => {
    const server = createGameVideoAnalysisServer();
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    clients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain("game-video-analysis://capabilities");

    const resource = await client.readResource({ uri: "game-video-analysis://capabilities" });
    const content = resource.contents[0];
    expect(content?.mimeType).toBe("application/json");
    expect(content).toHaveProperty("text");
    expect("text" in content! ? content.text : "").toContain("ffmpegExecutionLayer");
    expect("text" in content! ? content.text : "").toContain("get_video_info");
    expect("text" in content! ? content.text : "").toContain("get_frame");

    await server.close();
  });

  test("exposes get_video_info as a structured MCP tool", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "tool-sample.mp4");
      const runner = new FfmpegRunner();
      await runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=200x120:rate=25",
        "-t",
        "1",
        "-pix_fmt",
        "yuv420p",
        videoPath
      ]);

      const server = createGameVideoAnalysisServer();
      const client = new Client({ name: "test-client", version: "0.1.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      clients.push(client);

      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("get_video_info");

      const result = await client.callTool({
        name: "get_video_info",
        arguments: { inputPath: videoPath }
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        inputPath: videoPath,
        width: 200,
        height: 120,
        videoCodec: "h264",
        audio: {
          hasAudio: false
        }
      });

      await server.close();
    });
  });

  test("exposes frame extraction tools with structured output", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "frame-tool.mp4");
      const runner = new FfmpegRunner();
      await runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=200x120:rate=25",
        "-t",
        "1",
        "-pix_fmt",
        "yuv420p",
        videoPath
      ]);

      const server = createGameVideoAnalysisServer();
      const client = new Client({ name: "test-client", version: "0.1.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      clients.push(client);

      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(toolNames).toContain("get_frame");
      expect(toolNames).toContain("get_frames");

      const result = await client.callTool({
        name: "get_frame",
        arguments: { inputPath: videoPath, timestamp: "00:00:00.250" }
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        inputPath: videoPath,
        frame: {
          timestampSeconds: 0.25,
          timestamp: "00:00:00.250",
          format: "png",
          source: {
            inputPath: videoPath,
            width: 200,
            height: 120
          }
        }
      });

      const structuredContent = result.structuredContent as { outputDirectory?: string; frame?: { imagePath?: string } } | undefined;
      const outputDirectory = structuredContent?.outputDirectory;
      const imagePath = structuredContent?.frame?.imagePath;
      expect(typeof outputDirectory).toBe("string");
      expect(typeof imagePath).toBe("string");
      expect(existsSync(imagePath as string)).toBe(true);

      await rm(outputDirectory as string, { recursive: true, force: true });
      await server.close();
    });
  });
});
