import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AudioExtractionService } from "../src/media/audioExtraction.js";
import { ClipExtractionService } from "../src/media/clipExtraction.js";
import { CropRegionService, normalizeCropRegion } from "../src/media/cropRegion.js";
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

describe("crop region service", () => {
  test("extracts and upscales a pixel crop from a non-16:9 video", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "crop-source.mp4");
      const runner = new FfmpegRunner();
      const service = new CropRegionService(runner);

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

      const result = await service.cropRegion({
        inputPath: videoPath,
        timestamp: "00:00:00.500",
        region: { x: 20, y: 10, width: 40, height: 30 },
        scale: 2
      });

      expect(result.inputPath).toBe(videoPath);
      expect(result.imagePath.endsWith(".png")).toBe(true);
      expect(result.timestampSeconds).toBe(0.5);
      expect(result.region).toMatchObject({
        unit: "pixel",
        pixel: { x: 20, y: 10, width: 40, height: 30 },
        normalized: { x: 0.125, y: 0.083333, width: 0.25, height: 0.25 }
      });
      expect(result.output).toMatchObject({
        width: 80,
        height: 60
      });
      expect(result.output.sizeBytes).toBeGreaterThan(0);
      expect(result.source).toMatchObject({
        inputPath: videoPath,
        width: 160,
        height: 120
      });
      expect(existsSync(result.imagePath)).toBe(true);

      await rm(result.outputDirectory, { recursive: true, force: true });
    });
  });

  test("accepts normalized coordinates and returns reconstructable pixel metadata", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "normalized-crop.mp4");
      const runner = new FfmpegRunner();
      const service = new CropRegionService(runner);

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

      const result = await service.cropRegion({
        inputPath: videoPath,
        timestamp: 0.25,
        region: { x: 0.1, y: 0.25, width: 0.5, height: 0.25, unit: "normalized" },
        scale: 1.5,
        format: "jpeg"
      });

      expect(result.imagePath.endsWith(".jpg")).toBe(true);
      expect(result.format).toBe("jpeg");
      expect(result.scale).toBe(1.5);
      expect(result.region).toMatchObject({
        unit: "normalized",
        pixel: { x: 20, y: 30, width: 100, height: 30 },
        normalized: { x: 0.1, y: 0.25, width: 0.5, height: 0.25 }
      });
      expect(result.output).toMatchObject({
        width: 150,
        height: 45
      });

      await rm(result.outputDirectory, { recursive: true, force: true });
    });
  });

  test("rejects out-of-bounds crop regions and invalid scale", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "bad-crop.mp4");
      const runner = new FfmpegRunner();
      const service = new CropRegionService(runner);

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

      await expect(service.cropRegion({ inputPath: videoPath, timestamp: 0, region: { x: 150, y: 0, width: 20, height: 20 } })).rejects.toMatchObject({
        code: "invalid_crop_region"
      });

      await expect(
        service.cropRegion({
          inputPath: videoPath,
          timestamp: 0,
          region: { x: 0.8, y: 0, width: 0.3, height: 0.2, unit: "normalized" }
        })
      ).rejects.toMatchObject({
        code: "invalid_crop_region"
      });

      await expect(service.cropRegion({ inputPath: videoPath, timestamp: 0, region: { x: 0, y: 0, width: 20, height: 20 }, scale: 0 })).rejects.toMatchObject({
        code: "invalid_crop_region"
      });
    });
  });

  test("normalizes pixel and normalized regions deterministically", () => {
    expect(normalizeCropRegion({ x: 10.2, y: 5.6, width: 20.4, height: 10.4 }, { width: 100, height: 50 })).toEqual({
      x: 10,
      y: 6,
      width: 20,
      height: 10
    });
    expect(normalizeCropRegion({ x: 0.25, y: 0.2, width: 0.5, height: 0.4, unit: "normalized" }, { width: 200, height: 100 })).toEqual({
      x: 50,
      y: 20,
      width: 100,
      height: 40
    });
  });
});

describe("clip extraction service", () => {
  test("extracts a bounded MP4 clip with source timing metadata", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "clip-source.mp4");
      const runner = new FfmpegRunner();
      const service = new ClipExtractionService(runner);
      const infoService = new VideoInfoService(runner);

      await runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x180:rate=30",
        "-t",
        "2",
        "-pix_fmt",
        "yuv420p",
        videoPath
      ]);

      const result = await service.getClip({
        inputPath: videoPath,
        start: "00:00:00.500",
        duration: 0.75
      });

      expect(result.inputPath).toBe(videoPath);
      expect(result.clipPath.endsWith(".mp4")).toBe(true);
      expect(result.startSeconds).toBe(0.5);
      expect(result.endSeconds).toBe(1.25);
      expect(result.durationSeconds).toBe(0.75);
      expect(result.source).toMatchObject({
        inputPath: videoPath,
        width: 320,
        height: 180,
        audio: {
          hasAudio: false
        }
      });
      expect(result.output.hasAudio).toBe(false);
      expect(result.output.sizeBytes).toBeGreaterThan(0);
      expect(existsSync(result.clipPath)).toBe(true);

      const outputInfo = await infoService.getVideoInfo(result.clipPath);
      expect(outputInfo.durationSeconds).toBeGreaterThan(0.6);
      expect(outputInfo.durationSeconds).toBeLessThan(1);
      expect(outputInfo.width).toBe(320);
      expect(outputInfo.height).toBe(180);

      await rm(result.outputDirectory, { recursive: true, force: true });
    });
  });

  test("preserves audio when the source video has an audio track", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "clip-with-audio.mp4");
      const runner = new FfmpegRunner();
      const service = new ClipExtractionService(runner);
      const infoService = new VideoInfoService(runner);

      await runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=160x120:rate=24",
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

      const result = await service.getClip({
        inputPath: videoPath,
        start: 0.25,
        end: 1,
        maxDurationSeconds: 2
      });

      expect(result.source.audio).toMatchObject({
        hasAudio: true,
        channels: 2
      });
      expect(result.output.hasAudio).toBe(true);

      const outputInfo = await infoService.getVideoInfo(result.clipPath);
      expect(outputInfo.audio.hasAudio).toBe(true);
      expect(outputInfo.audio.channels).toBe(2);

      await rm(result.outputDirectory, { recursive: true, force: true });
    });
  });

  test("rejects out-of-range, reversed, and over-limit clips", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "short-clip.mp4");
      const runner = new FfmpegRunner();
      const service = new ClipExtractionService(runner);

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

      await expect(service.getClip({ inputPath: videoPath, start: 0, end: 2 })).rejects.toMatchObject({
        code: "timestamp_out_of_range"
      });

      await expect(service.getClip({ inputPath: videoPath, start: 0.8, end: 0.2 })).rejects.toMatchObject({
        code: "invalid_time_range"
      });

      await expect(service.getClip({ inputPath: videoPath, start: 0, duration: 0.75, maxDurationSeconds: 0.5 })).rejects.toMatchObject({
        code: "invalid_time_range"
      });
    });
  });
});

describe("audio extraction service", () => {
  test("extracts a bounded WAV segment and preserves stereo channels", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "audio-source.mp4");
      const runner = new FfmpegRunner();
      const service = new AudioExtractionService(runner);

      await runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=160x120:rate=24",
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

      const result = await service.getAudio({
        inputPath: videoPath,
        start: "00:00:00.250",
        duration: 0.75
      });

      expect(result.inputPath).toBe(videoPath);
      expect(result.audioPath.endsWith(".wav")).toBe(true);
      expect(result.startSeconds).toBe(0.25);
      expect(result.endSeconds).toBe(1);
      expect(result.durationSeconds).toBe(0.75);
      expect(result.source.audio).toMatchObject({
        hasAudio: true,
        sampleRate: 48000,
        channels: 2
      });
      expect(result.output).toMatchObject({
        hasAudio: true,
        codec: "pcm_s16le",
        sampleRate: 48000,
        channels: 2
      });
      expect(result.output.sizeBytes).toBeGreaterThan(0);
      expect(existsSync(result.audioPath)).toBe(true);

      await rm(result.outputDirectory, { recursive: true, force: true });
    });
  });

  test("rejects videos without audio", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "silent.mp4");
      const runner = new FfmpegRunner();
      const service = new AudioExtractionService(runner);

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

      await expect(service.getAudio({ inputPath: videoPath, start: 0, duration: 0.5 })).rejects.toMatchObject({
        code: "no_audio_stream"
      });
    });
  });

  test("rejects out-of-range, reversed, and over-limit audio requests", async () => {
    await withTempWorkspace(async (workspace) => {
      const videoPath = join(workspace.path, "short-audio.mp4");
      const runner = new FfmpegRunner();
      const service = new AudioExtractionService(runner);

      await runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=160x120:rate=24",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100",
        "-t",
        "1",
        "-ac",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-shortest",
        videoPath
      ]);

      await expect(service.getAudio({ inputPath: videoPath, start: 0, end: 2 })).rejects.toMatchObject({
        code: "timestamp_out_of_range"
      });

      await expect(service.getAudio({ inputPath: videoPath, start: 0.8, end: 0.2 })).rejects.toMatchObject({
        code: "invalid_time_range"
      });

      await expect(service.getAudio({ inputPath: videoPath, start: 0, duration: 0.75, maxDurationSeconds: 0.5 })).rejects.toMatchObject({
        code: "invalid_time_range"
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
