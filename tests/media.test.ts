import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { MediaError } from "../src/media/errors.js";
import { FfmpegRunner } from "../src/media/ffmpeg.js";
import { validateInputVideoPath } from "../src/media/paths.js";
import { withTempWorkspace } from "../src/media/temp.js";
import { createExecutable, createFixtureVideo } from "./fixtures.js";

describe("input path validation", () => {
  test("rejects missing files with an LLM-readable error code", async () => {
    await expect(validateInputVideoPath("/not/a/video.mp4")).rejects.toMatchObject({
      code: "invalid_input_path"
    });
  });

  test("rejects directories", async () => {
    await withTempWorkspace(async (workspace) => {
      const dir = join(workspace.path, "video-dir");
      await mkdir(dir);

      await expect(validateInputVideoPath(dir)).rejects.toMatchObject({
        code: "invalid_input_path"
      });
    });
  });
});

describe("ffmpeg runner", () => {
  test("uses installed ffmpeg to generate a test video and installed ffprobe to inspect it", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "sample.mp4");
      const runner = new FfmpegRunner();

      await runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x180:rate=30",
        "-t",
        "1",
        "-pix_fmt",
        "yuv420p",
        videoPath
      ]);

      const result = await runner.probeVideo(videoPath);

      expect(result.inputPath).toBe(videoPath);
      expect(Number(result.format.duration)).toBeGreaterThan(0);
      expect(result.streams[0]?.codec_type).toBe("video");
      expect(result.streams[0]?.width).toBe(320);
      expect(result.streams[0]?.height).toBe(180);
    });
  });

  test("reports missing ffprobe without leaking raw process failures", async () => {
    const runner = new FfmpegRunner({ ffprobePath: "/missing/ffprobe" });

    await expect(runner.runFfprobe(["-version"])).rejects.toMatchObject({
      code: "binary_not_found"
    });
  });

  test("reports missing ffmpeg with the same structured error shape", async () => {
    const runner = new FfmpegRunner({ ffmpegPath: "/missing/ffmpeg" });

    await expect(runner.getFfmpegPath()).rejects.toMatchObject({
      code: "binary_not_found"
    });
  });

  test("reports unsupported files when ffprobe cannot parse media", async () => {
    await withTempWorkspace(async (workspace) => {
      const ffprobePath = await createExecutable(workspace.path, "ffprobe", `console.error("Invalid data found"); process.exit(1);`);
      const videoPath = await createFixtureVideo(workspace.path, "broken.dat");
      const runner = new FfmpegRunner({ ffprobePath });

      await expect(runner.probeVideo(videoPath)).rejects.toBeInstanceOf(MediaError);
      await expect(runner.probeVideo(videoPath)).rejects.toMatchObject({
        code: "process_failed"
      });
    });
  });
});

describe("temporary workspace", () => {
  test("cleans up managed temporary files after work completes", async () => {
    let workspacePath = "";

    await withTempWorkspace(async (workspace) => {
      workspacePath = workspace.path;
      await createFixtureVideo(workspace.path);
      expect(existsSync(workspacePath)).toBe(true);
    });

    expect(existsSync(workspacePath)).toBe(false);
  });
});
