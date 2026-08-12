import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { MediaError } from "../src/media/errors.js";
import { FfmpegRunner } from "../src/media/ffmpeg.js";
import { FrameExtractionService, frameTimestamps, parseTimestamp } from "../src/media/frameExtraction.js";
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

describe("frame extraction service", () => {
  test("extracts a single PNG frame with timestamp and source metadata", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "frames.mp4");
      const runner = new FfmpegRunner();
      const service = new FrameExtractionService(runner);

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

      const result = await service.getFrame({ inputPath: videoPath, timestamp: "00:00:00.500" });

      expect(result.inputPath).toBe(videoPath);
      expect(result.frame.timestampSeconds).toBe(0.5);
      expect(result.frame.timestamp).toBe("00:00:00.500");
      expect(result.frame.format).toBe("png");
      expect(result.frame.source).toMatchObject({
        inputPath: videoPath,
        width: 320,
        height: 180
      });
      expect(existsSync(result.frame.imagePath)).toBe(true);

      await rm(result.outputDirectory, { recursive: true, force: true });
    });
  });

  test("extracts multiple frames at a fixed interval", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "sequence.mp4");
      const runner = new FfmpegRunner();
      const service = new FrameExtractionService(runner);

      await runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=160x120:rate=24",
        "-t",
        "1",
        "-pix_fmt",
        "yuv420p",
        videoPath
      ]);

      const result = await service.getFrames({
        inputPath: videoPath,
        start: 0,
        end: "00:00:00.750",
        interval: 0.25,
        maxFrames: 4
      });

      expect(result.count).toBe(4);
      expect(result.frames.map((frame) => frame.timestampSeconds)).toEqual([0, 0.25, 0.5, 0.75]);
      expect(result.frames.every((frame) => existsSync(frame.imagePath))).toBe(true);
      expect(result.frames.every((frame) => frame.source.width === 160 && frame.source.height === 120)).toBe(true);

      await rm(result.outputDirectory, { recursive: true, force: true });
    });
  });

  test("rejects out-of-range timestamps and excessive frame counts", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "short.mp4");
      const runner = new FfmpegRunner();
      const service = new FrameExtractionService(runner);

      await runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=160x90:rate=24",
        "-t",
        "1",
        "-pix_fmt",
        "yuv420p",
        videoPath
      ]);

      await expect(service.getFrame({ inputPath: videoPath, timestamp: 2 })).rejects.toMatchObject({
        code: "timestamp_out_of_range"
      });

      await expect(service.getFrames({ inputPath: videoPath, start: 0, duration: 1, interval: 0.1, maxFrames: 3 })).rejects.toMatchObject({
        code: "too_many_frames"
      });
    });
  });

  test("parses second and clock timestamps and guards max frame expansion", () => {
    expect(parseTimestamp("1.25")).toBe(1.25);
    expect(parseTimestamp("01:02:03.250")).toBe(3723.25);
    expect(frameTimestamps(0, 0.5, 0.25, 3)).toEqual([0, 0.25, 0.5]);
    expect(() => frameTimestamps(0, 1, 0.25, 3)).toThrow(MediaError);
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
