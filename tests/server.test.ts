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
    expect("text" in content! ? content.text : "").toContain("get_clip");
    expect("text" in content! ? content.text : "").toContain("get_audio");
    expect("text" in content! ? content.text : "").toContain("crop_region");

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

  test("exposes get_clip with structured output", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "clip-tool.mp4");
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
        "2",
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
      expect(tools.tools.map((tool) => tool.name)).toContain("get_clip");

      const result = await client.callTool({
        name: "get_clip",
        arguments: { inputPath: videoPath, start: "00:00:00.250", duration: 0.5 }
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        inputPath: videoPath,
        format: "mp4",
        startSeconds: 0.25,
        endSeconds: 0.75,
        durationSeconds: 0.5,
        source: {
          inputPath: videoPath,
          width: 200,
          height: 120
        },
        output: {
          hasAudio: false
        }
      });

      const structuredContent = result.structuredContent as { outputDirectory?: string; clipPath?: string } | undefined;
      const outputDirectory = structuredContent?.outputDirectory;
      const clipPath = structuredContent?.clipPath;
      expect(typeof outputDirectory).toBe("string");
      expect(typeof clipPath).toBe("string");
      expect(existsSync(clipPath as string)).toBe(true);

      await rm(outputDirectory as string, { recursive: true, force: true });
      await server.close();
    });
  });

  test("exposes get_audio with structured output", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "audio-tool.mp4");
      const runner = new FfmpegRunner();
      await runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=200x120:rate=25",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "2",
        "-ac",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-shortest",
        videoPath
      ]);

      const server = createGameVideoAnalysisServer();
      const client = new Client({ name: "test-client", version: "0.1.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      clients.push(client);

      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("get_audio");

      const result = await client.callTool({
        name: "get_audio",
        arguments: { inputPath: videoPath, start: "00:00:00.250", duration: 0.5 }
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        inputPath: videoPath,
        format: "wav",
        startSeconds: 0.25,
        endSeconds: 0.75,
        durationSeconds: 0.5,
        source: {
          inputPath: videoPath,
          audio: {
            hasAudio: true,
            channels: 2
          }
        },
        output: {
          hasAudio: true,
          codec: "pcm_s16le",
          channels: 2
        }
      });

      const structuredContent = result.structuredContent as { outputDirectory?: string; audioPath?: string } | undefined;
      const outputDirectory = structuredContent?.outputDirectory;
      const audioPath = structuredContent?.audioPath;
      expect(typeof outputDirectory).toBe("string");
      expect(typeof audioPath).toBe("string");
      expect(existsSync(audioPath as string)).toBe(true);

      await rm(outputDirectory as string, { recursive: true, force: true });
      await server.close();
    });
  });

  test("exposes crop_region with structured output", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "crop-tool.mp4");
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
      expect(tools.tools.map((tool) => tool.name)).toContain("crop_region");

      const result = await client.callTool({
        name: "crop_region",
        arguments: {
          inputPath: videoPath,
          timestamp: "00:00:00.250",
          region: { x: 0.1, y: 0.25, width: 0.5, height: 0.5, unit: "normalized" },
          scale: 2
        }
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        inputPath: videoPath,
        timestampSeconds: 0.25,
        format: "png",
        scale: 2,
        region: {
          unit: "normalized",
          pixel: {
            x: 20,
            y: 30,
            width: 100,
            height: 60
          }
        },
        output: {
          width: 200,
          height: 120
        },
        source: {
          inputPath: videoPath,
          width: 200,
          height: 120
        }
      });

      const structuredContent = result.structuredContent as { outputDirectory?: string; imagePath?: string } | undefined;
      const outputDirectory = structuredContent?.outputDirectory;
      const imagePath = structuredContent?.imagePath;
      expect(typeof outputDirectory).toBe("string");
      expect(typeof imagePath).toBe("string");
      expect(existsSync(imagePath as string)).toBe(true);

      await rm(outputDirectory as string, { recursive: true, force: true });
      await server.close();
    });
  });
});
