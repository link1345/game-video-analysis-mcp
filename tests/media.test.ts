import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { MediaError } from "../src/media/errors.js";
import { FfmpegRunner } from "../src/media/ffmpeg.js";
import { validateInputVideoPath } from "../src/media/paths.js";
import { withTempWorkspace } from "../src/media/temp.js";
import { formatDuration, parseFrameRate, VideoInfoService } from "../src/media/videoInfo.js";
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

describe("video info service", () => {
  test("normalizes duration, resolution, fps, and no-audio metadata", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "no-audio.mp4");
      const runner = new FfmpegRunner();
      const service = new VideoInfoService(runner);

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

      const info = await service.getVideoInfo(videoPath);

      expect(info.inputPath).toBe(videoPath);
      expect(info.durationSeconds).toBeGreaterThanOrEqual(1);
      expect(info.duration).toStartWith("00:00:01");
      expect(info.width).toBe(320);
      expect(info.height).toBe(180);
      expect(info.frameRate.raw).toBe("30/1");
      expect(info.frameRate.fps).toBe(30);
      expect(info.videoCodec).toBe("h264");
      expect(info.audio.hasAudio).toBe(false);
      expect(info.streams.video).toBe(1);
      expect(info.streams.audio).toBe(0);
    });
  });

  test("detects audio stream codec, sample rate, and stereo channels", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "with-audio.mp4");
      const runner = new FfmpegRunner();
      const service = new VideoInfoService(runner);

      await runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=160x90:rate=24",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "1",
        "-ac",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-shortest",
        videoPath
      ]);

      const info = await service.getVideoInfo(videoPath);

      expect(info.width).toBe(160);
      expect(info.height).toBe(90);
      expect(info.frameRate.fps).toBe(24);
      expect(info.audio.hasAudio).toBe(true);
      expect(info.audio.codec).toBe("aac");
      expect(info.audio.sampleRate).toBe(48000);
      expect(info.audio.channels).toBe(2);
      expect(info.streams.audio).toBe(1);
    });
  });

  test("rejects unsupported files without exposing ffprobe JSON", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = await createFixtureVideo(workspace.path, "not-media.dat");
      const service = new VideoInfoService();

      await expect(service.getVideoInfo(videoPath)).rejects.toBeInstanceOf(MediaError);
      await expect(service.getVideoInfo(videoPath)).rejects.toMatchObject({
        code: "process_failed"
      });
    });
  });

  test("parses fractional fps and formats human-readable duration", () => {
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("0/0")).toBeUndefined();
    expect(formatDuration(3661.25)).toBe("01:01:01.250");
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
