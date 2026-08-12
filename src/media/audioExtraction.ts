import { stat } from "node:fs/promises";
import { join } from "node:path";
import { MediaError } from "./errors.js";
import { FfmpegRunner } from "./ffmpeg.js";
import { parseTimestamp, type TimestampInput } from "./frameExtraction.js";
import { TempWorkspace } from "./temp.js";
import { formatDuration, VideoInfoService } from "./videoInfo.js";

export type AudioFormat = "wav" | "m4a";

export interface AudioExtractionRequest {
  inputPath: string;
  start: TimestampInput;
  end?: TimestampInput;
  duration?: number;
  format?: AudioFormat;
  maxDurationSeconds?: number;
}

export interface AudioExtractionResult {
  [key: string]: unknown;
  inputPath: string;
  outputDirectory: string;
  audioPath: string;
  format: AudioFormat;
  startSeconds: number;
  start: string;
  endSeconds: number;
  end: string;
  durationSeconds: number;
  duration: string;
  source: {
    inputPath: string;
    durationSeconds: number;
    audio: AudioMetadata;
  };
  output: AudioMetadata & {
    sizeBytes: number;
  };
}

export interface AudioMetadata {
  hasAudio: boolean;
  codec?: string;
  sampleRate?: number;
  channels?: number;
  channelLayout?: string;
}

const defaultMaxAudioDurationSeconds = 60;
const hardMaxAudioDurationSeconds = 300;

export class AudioExtractionService {
  constructor(
    private readonly runner = new FfmpegRunner(),
    private readonly videoInfoService = new VideoInfoService(runner)
  ) {}

  async getAudio(request: AudioExtractionRequest): Promise<AudioExtractionResult> {
    const info = await this.videoInfoService.getVideoInfo(request.inputPath);

    if (!info.audio.hasAudio) {
      throw new MediaError("no_audio_stream", "Input video does not contain an audio stream.", {
        inputPath: info.inputPath
      });
    }

    const startSeconds = parseTimestamp(request.start);
    const endSeconds =
      request.end !== undefined ? parseTimestamp(request.end) : request.duration !== undefined ? startSeconds + request.duration : undefined;

    if (endSeconds === undefined) {
      throw new MediaError("invalid_time_range", "Either end or duration must be provided for get_audio.");
    }

    validateAudioRange(startSeconds, endSeconds, info.durationSeconds);

    const durationSeconds = roundMilliseconds(endSeconds - startSeconds);
    const maxDurationSeconds = request.maxDurationSeconds ?? defaultMaxAudioDurationSeconds;
    validateAudioDuration(durationSeconds, maxDurationSeconds);

    const format = request.format ?? "wav";
    const workspace = await TempWorkspace.create("game-video-analysis-audio-");
    const audioPath = join(workspace.path, `audio-${millisecondsLabel(startSeconds)}-${millisecondsLabel(endSeconds)}.${format}`);

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
        "0:a:0",
        "-vn",
        ...audioCodecArgs(format),
        audioPath
      ]);

      const outputStats = await stat(audioPath).catch((cause: unknown) => {
        throw new MediaError("audio_extraction_failed", "ffmpeg did not create the requested audio file.", {
          audioPath,
          cause: cause instanceof Error ? cause.message : String(cause)
        });
      });

      if (!outputStats.isFile() || outputStats.size === 0) {
        throw new MediaError("audio_extraction_failed", "ffmpeg created an empty or invalid audio file.", {
          audioPath,
          size: outputStats.size
        });
      }

      const outputAudio = await this.probeAudio(audioPath);

      return {
        inputPath: info.inputPath,
        outputDirectory: workspace.path,
        audioPath,
        format,
        startSeconds,
        start: formatDuration(startSeconds),
        endSeconds,
        end: formatDuration(endSeconds),
        durationSeconds,
        duration: formatDuration(durationSeconds),
        source: {
          inputPath: info.inputPath,
          durationSeconds: info.durationSeconds,
          audio: {
            hasAudio: true,
            ...(info.audio.codec ? { codec: info.audio.codec } : {}),
            ...(info.audio.sampleRate !== undefined ? { sampleRate: info.audio.sampleRate } : {}),
            ...(info.audio.channels !== undefined ? { channels: info.audio.channels } : {})
          }
        },
        output: {
          ...outputAudio,
          sizeBytes: outputStats.size
        }
      };
    } catch (error) {
      await workspace.dispose();
      throw error;
    }
  }

  private async probeAudio(inputPath: string): Promise<AudioMetadata> {
    const probe = await this.runner.probeVideo(inputPath);
    const stream = probe.streams.find((candidate) => candidate.codec_type === "audio");

    if (!stream) {
      throw new MediaError("audio_extraction_failed", "Extracted file does not contain an audio stream.", {
        inputPath
      });
    }

    return normalizeAudio(stream);
  }
}

function audioCodecArgs(format: AudioFormat): string[] {
  if (format === "wav") {
    return ["-c:a", "pcm_s16le"];
  }

  return ["-c:a", "aac"];
}

function normalizeAudio(stream: Record<string, unknown>): AudioMetadata {
  const codec = firstString(stream.codec_name, stream.codec_long_name);
  const sampleRate = finiteNumber(stream.sample_rate);
  const channels = finiteNumber(stream.channels);
  const channelLayout = firstString(stream.channel_layout);

  return {
    hasAudio: true,
    ...(codec ? { codec } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(channelLayout ? { channelLayout } : {})
  };
}

function validateAudioRange(startSeconds: number, endSeconds: number, sourceDurationSeconds: number): void {
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
    throw new MediaError("invalid_time_range", "Audio end timestamp must be greater than start timestamp.", {
      startSeconds,
      endSeconds
    });
  }
}

function validateAudioDuration(durationSeconds: number, maxDurationSeconds: number): void {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
    throw new MediaError("invalid_time_range", "maxDurationSeconds must be a finite positive number.", {
      maxDurationSeconds
    });
  }

  if (maxDurationSeconds > hardMaxAudioDurationSeconds) {
    throw new MediaError("invalid_time_range", `maxDurationSeconds must be ${hardMaxAudioDurationSeconds} or less.`, {
      maxDurationSeconds,
      hardMaxAudioDurationSeconds
    });
  }

  if (durationSeconds > maxDurationSeconds) {
    throw new MediaError("invalid_time_range", "Requested audio duration exceeds maxDurationSeconds.", {
      durationSeconds,
      maxDurationSeconds
    });
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function millisecondsLabel(seconds: number): string {
  return Math.round(seconds * 1000).toString().padStart(9, "0");
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
