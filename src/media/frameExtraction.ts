import { stat } from "node:fs/promises";
import { join } from "node:path";
import { MediaError } from "./errors.js";
import { FfmpegRunner } from "./ffmpeg.js";
import { TempWorkspace } from "./temp.js";
import { formatDuration, VideoInfoService } from "./videoInfo.js";

export type TimestampInput = number | string;
export type ImageFormat = "png" | "jpeg";

export interface FrameOutput {
  imagePath: string;
  timestampSeconds: number;
  timestamp: string;
  format: ImageFormat;
  source: {
    inputPath: string;
    width: number;
    height: number;
    durationSeconds: number;
  };
}

export interface SingleFrameRequest {
  inputPath: string;
  timestamp: TimestampInput;
  format?: ImageFormat;
}

export interface MultiFrameRequest {
  inputPath: string;
  start: TimestampInput;
  end?: TimestampInput;
  duration?: number;
  interval: number;
  maxFrames?: number;
  format?: ImageFormat;
}

export interface SingleFrameResult {
  [key: string]: unknown;
  inputPath: string;
  outputDirectory: string;
  frame: FrameOutput;
}

export interface MultiFrameResult {
  [key: string]: unknown;
  inputPath: string;
  outputDirectory: string;
  startSeconds: number;
  start: string;
  endSeconds: number;
  end: string;
  intervalSeconds: number;
  count: number;
  frames: FrameOutput[];
}

const defaultMaxFrames = 12;
const hardMaxFrames = 50;

export class FrameExtractionService {
  constructor(
    private readonly runner = new FfmpegRunner(),
    private readonly videoInfoService = new VideoInfoService(runner)
  ) {}

  async getFrame(request: SingleFrameRequest): Promise<SingleFrameResult> {
    const info = await this.videoInfoService.getVideoInfo(request.inputPath);
    const timestampSeconds = parseTimestamp(request.timestamp);
    validateTimestamp(timestampSeconds, info.durationSeconds, "timestamp");
    const format = request.format ?? "png";
    const workspace = await TempWorkspace.create("game-video-analysis-frame-");

    try {
      const frame = await this.extractFrame({
        inputPath: info.inputPath,
        outputDirectory: workspace.path,
        timestampSeconds,
        format,
        width: info.width,
        height: info.height,
        durationSeconds: info.durationSeconds
      });

      return {
        inputPath: info.inputPath,
        outputDirectory: workspace.path,
        frame
      };
    } catch (error) {
      await workspace.dispose();
      throw error;
    }
  }

  async getFrames(request: MultiFrameRequest): Promise<MultiFrameResult> {
    const info = await this.videoInfoService.getVideoInfo(request.inputPath);
    const startSeconds = parseTimestamp(request.start);
    const endSeconds =
      request.end !== undefined ? parseTimestamp(request.end) : request.duration !== undefined ? startSeconds + request.duration : undefined;

    if (endSeconds === undefined) {
      throw new MediaError("invalid_time_range", "Either end or duration must be provided for get_frames.");
    }

    validateTimestamp(startSeconds, info.durationSeconds, "start");
    validateTimestamp(endSeconds, info.durationSeconds, "end");

    if (endSeconds < startSeconds) {
      throw new MediaError("invalid_time_range", "End timestamp must be greater than or equal to start timestamp.", {
        startSeconds,
        endSeconds
      });
    }

    const intervalSeconds = finitePositiveNumber(request.interval, "interval");
    const requestedMaxFrames = request.maxFrames ?? defaultMaxFrames;
    const maxFrames = Math.floor(finitePositiveNumber(requestedMaxFrames, "maxFrames"));

    if (maxFrames > hardMaxFrames) {
      throw new MediaError("too_many_frames", `maxFrames must be ${hardMaxFrames} or less.`, {
        maxFrames,
        hardMaxFrames
      });
    }

    const timestamps = frameTimestamps(startSeconds, endSeconds, intervalSeconds, maxFrames);
    const format = request.format ?? "png";
    const workspace = await TempWorkspace.create("game-video-analysis-frames-");

    try {
      const frames: FrameOutput[] = [];
      for (const timestampSeconds of timestamps) {
        frames.push(
          await this.extractFrame({
            inputPath: info.inputPath,
            outputDirectory: workspace.path,
            timestampSeconds,
            format,
            width: info.width,
            height: info.height,
            durationSeconds: info.durationSeconds
          })
        );
      }

      return {
        inputPath: info.inputPath,
        outputDirectory: workspace.path,
        startSeconds,
        start: formatDuration(startSeconds),
        endSeconds,
        end: formatDuration(endSeconds),
        intervalSeconds,
        count: frames.length,
        frames
      };
    } catch (error) {
      await workspace.dispose();
      throw error;
    }
  }

  private async extractFrame(request: {
    inputPath: string;
    outputDirectory: string;
    timestampSeconds: number;
    format: ImageFormat;
    width: number;
    height: number;
    durationSeconds: number;
  }): Promise<FrameOutput> {
    const extension = request.format === "jpeg" ? "jpg" : "png";
    const imagePath = join(request.outputDirectory, `frame-${millisecondsLabel(request.timestampSeconds)}.${extension}`);

    await this.runner.runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      request.timestampSeconds.toFixed(3),
      "-i",
      request.inputPath,
      "-frames:v",
      "1",
      "-an",
      imagePath
    ]);

    const outputStats = await stat(imagePath).catch((cause: unknown) => {
      throw new MediaError("frame_extraction_failed", "ffmpeg did not create the requested frame image.", {
        imagePath,
        cause: cause instanceof Error ? cause.message : String(cause)
      });
    });

    if (!outputStats.isFile() || outputStats.size === 0) {
      throw new MediaError("frame_extraction_failed", "ffmpeg created an empty or invalid frame image.", {
        imagePath,
        size: outputStats.size
      });
    }

    return {
      imagePath,
      timestampSeconds: request.timestampSeconds,
      timestamp: formatDuration(request.timestampSeconds),
      format: request.format,
      source: {
        inputPath: request.inputPath,
        width: request.width,
        height: request.height,
        durationSeconds: request.durationSeconds
      }
    };
  }
}

export function parseTimestamp(value: TimestampInput): number {
  if (typeof value === "number") {
    return finiteNonNegativeNumber(value, "timestamp");
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new MediaError("invalid_timestamp", "Timestamp must not be empty.");
  }

  const numericSeconds = Number(trimmed);
  if (Number.isFinite(numericSeconds)) {
    return finiteNonNegativeNumber(numericSeconds, "timestamp");
  }

  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new MediaError("invalid_timestamp", "Timestamp must be seconds or HH:MM:SS.mmm.");
  }

  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds) || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) {
    throw new MediaError("invalid_timestamp", "Timestamp must be seconds or HH:MM:SS.mmm.", {
      timestamp: value
    });
  }

  return finiteNonNegativeNumber(hours * 3600 + minutes * 60 + seconds, "timestamp");
}

export function frameTimestamps(startSeconds: number, endSeconds: number, intervalSeconds: number, maxFrames: number): number[] {
  const timestamps: number[] = [];
  const epsilon = 0.000_001;

  for (let current = startSeconds; current <= endSeconds + epsilon; current += intervalSeconds) {
    if (timestamps.length >= maxFrames) {
      throw new MediaError("too_many_frames", "Requested frame range exceeds maxFrames.", {
        startSeconds,
        endSeconds,
        intervalSeconds,
        maxFrames
      });
    }

    timestamps.push(roundMilliseconds(Math.min(current, endSeconds)));
  }

  return timestamps;
}

function validateTimestamp(timestampSeconds: number, durationSeconds: number, field: string): void {
  if (timestampSeconds > durationSeconds) {
    throw new MediaError("timestamp_out_of_range", `${field} timestamp is outside the input video duration.`, {
      [field]: timestampSeconds,
      durationSeconds
    });
  }
}

function finiteNonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new MediaError("invalid_timestamp", `${field} must be a finite non-negative number.`, {
      [field]: value
    });
  }

  return roundMilliseconds(value);
}

function finitePositiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new MediaError("invalid_time_range", `${field} must be a finite positive number.`, {
      [field]: value
    });
  }

  return value;
}

function millisecondsLabel(seconds: number): string {
  return Math.round(seconds * 1000).toString().padStart(9, "0");
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
