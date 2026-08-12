import { stat } from "node:fs/promises";
import { join } from "node:path";
import { MediaError } from "./errors.js";
import { FfmpegRunner } from "./ffmpeg.js";
import { parseTimestamp, type TimestampInput } from "./frameExtraction.js";
import { TempWorkspace } from "./temp.js";
import { formatDuration, VideoInfoService } from "./videoInfo.js";

export interface ClipRequest {
  inputPath: string;
  start: TimestampInput;
  end?: TimestampInput;
  duration?: number;
  maxDurationSeconds?: number;
}

export interface ClipResult {
  [key: string]: unknown;
  inputPath: string;
  outputDirectory: string;
  clipPath: string;
  format: "mp4";
  startSeconds: number;
  start: string;
  endSeconds: number;
  end: string;
  durationSeconds: number;
  duration: string;
  source: {
    inputPath: string;
    width: number;
    height: number;
    durationSeconds: number;
    audio: {
      hasAudio: boolean;
      codec?: string;
      sampleRate?: number;
      channels?: number;
    };
  };
  output: {
    hasAudio: boolean;
    sizeBytes: number;
  };
}

const defaultMaxClipDurationSeconds = 30;
const hardMaxClipDurationSeconds = 120;

export class ClipExtractionService {
  constructor(
    private readonly runner = new FfmpegRunner(),
    private readonly videoInfoService = new VideoInfoService(runner)
  ) {}

  async getClip(request: ClipRequest): Promise<ClipResult> {
    const info = await this.videoInfoService.getVideoInfo(request.inputPath);
    const startSeconds = parseTimestamp(request.start);
    const endSeconds =
      request.end !== undefined ? parseTimestamp(request.end) : request.duration !== undefined ? startSeconds + request.duration : undefined;

    if (endSeconds === undefined) {
      throw new MediaError("invalid_time_range", "Either end or duration must be provided for get_clip.");
    }

    validateClipRange(startSeconds, endSeconds, info.durationSeconds);

    const durationSeconds = roundMilliseconds(endSeconds - startSeconds);
    const maxDurationSeconds = request.maxDurationSeconds ?? defaultMaxClipDurationSeconds;
    validateClipDuration(durationSeconds, maxDurationSeconds);

    const workspace = await TempWorkspace.create("game-video-analysis-clip-");
    const clipPath = join(workspace.path, `clip-${millisecondsLabel(startSeconds)}-${millisecondsLabel(endSeconds)}.mp4`);

    try {
      await this.runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        info.inputPath,
        "-ss",
        startSeconds.toFixed(3),
        "-t",
        durationSeconds.toFixed(3),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        clipPath
      ]);

      const outputStats = await stat(clipPath).catch((cause: unknown) => {
        throw new MediaError("clip_extraction_failed", "ffmpeg did not create the requested clip.", {
          clipPath,
          cause: cause instanceof Error ? cause.message : String(cause)
        });
      });

      if (!outputStats.isFile() || outputStats.size === 0) {
        throw new MediaError("clip_extraction_failed", "ffmpeg created an empty or invalid clip.", {
          clipPath,
          size: outputStats.size
        });
      }

      const outputInfo = await this.videoInfoService.getVideoInfo(clipPath);

      return {
        inputPath: info.inputPath,
        outputDirectory: workspace.path,
        clipPath,
        format: "mp4",
        startSeconds,
        start: formatDuration(startSeconds),
        endSeconds,
        end: formatDuration(endSeconds),
        durationSeconds,
        duration: formatDuration(durationSeconds),
        source: {
          inputPath: info.inputPath,
          width: info.width,
          height: info.height,
          durationSeconds: info.durationSeconds,
          audio: info.audio
        },
        output: {
          hasAudio: outputInfo.audio.hasAudio,
          sizeBytes: outputStats.size
        }
      };
    } catch (error) {
      await workspace.dispose();
      throw error;
    }
  }
}

function validateClipRange(startSeconds: number, endSeconds: number, sourceDurationSeconds: number): void {
  if (startSeconds > sourceDurationSeconds) {
    throw new MediaError("timestamp_out_of_range", "start timestamp is outside the input video duration.", {
      start: startSeconds,
      durationSeconds: sourceDurationSeconds
    });
  }

  if (endSeconds > sourceDurationSeconds) {
    throw new MediaError("timestamp_out_of_range", "end timestamp is outside the input video duration.", {
      end: endSeconds,
      durationSeconds: sourceDurationSeconds
    });
  }

  if (endSeconds <= startSeconds) {
    throw new MediaError("invalid_time_range", "Clip end timestamp must be greater than start timestamp.", {
      startSeconds,
      endSeconds
    });
  }
}

function validateClipDuration(durationSeconds: number, maxDurationSeconds: number): void {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
    throw new MediaError("invalid_time_range", "maxDurationSeconds must be a finite positive number.", {
      maxDurationSeconds
    });
  }

  if (maxDurationSeconds > hardMaxClipDurationSeconds) {
    throw new MediaError("invalid_time_range", `maxDurationSeconds must be ${hardMaxClipDurationSeconds} or less.`, {
      maxDurationSeconds,
      hardMaxClipDurationSeconds
    });
  }

  if (durationSeconds > maxDurationSeconds) {
    throw new MediaError("invalid_time_range", "Requested clip duration exceeds maxDurationSeconds.", {
      durationSeconds,
      maxDurationSeconds
    });
  }
}

function millisecondsLabel(seconds: number): string {
  return Math.round(seconds * 1000).toString().padStart(9, "0");
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
