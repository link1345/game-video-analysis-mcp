import { MediaError } from "./errors.js";
import { FfmpegRunner } from "./ffmpeg.js";

export interface VideoInfo {
  [key: string]: unknown;
  inputPath: string;
  durationSeconds: number;
  duration: string;
  width: number;
  height: number;
  frameRate: {
    raw: string;
    fps: number;
  };
  videoCodec: string;
  audio: {
    hasAudio: boolean;
    codec?: string;
    sampleRate?: number;
    channels?: number;
  };
  streams: {
    video: number;
    audio: number;
  };
}

export class VideoInfoService {
  constructor(private readonly runner = new FfmpegRunner()) {}

  async getVideoInfo(inputPath: string): Promise<VideoInfo> {
    const probe = await this.runner.probeVideo(inputPath);
    const videoStreams = probe.streams.filter((stream) => stream.codec_type === "video");
    const audioStreams = probe.streams.filter((stream) => stream.codec_type === "audio");
    const videoStream = videoStreams[0];

    if (!videoStream) {
      throw new MediaError("unsupported_input", "Input file does not contain a video stream.", {
        inputPath: probe.inputPath
      });
    }

    const durationSeconds = firstFiniteNumber(videoStream.duration, probe.format.duration);
    const width = finiteNumber(videoStream.width);
    const height = finiteNumber(videoStream.height);
    const frameRateRaw = firstString(videoStream.avg_frame_rate, videoStream.r_frame_rate);
    const fps = parseFrameRate(frameRateRaw);
    const videoCodec = firstString(videoStream.codec_name, videoStream.codec_long_name);
    const audioStream = audioStreams[0];

    if (durationSeconds === undefined) {
      throw new MediaError("unsupported_input", "Could not determine video duration.", {
        inputPath: probe.inputPath
      });
    }

    if (width === undefined || height === undefined) {
      throw new MediaError("unsupported_input", "Could not determine video resolution.", {
        inputPath: probe.inputPath
      });
    }

    if (frameRateRaw === undefined || fps === undefined) {
      throw new MediaError("unsupported_input", "Could not determine video frame rate.", {
        inputPath: probe.inputPath
      });
    }

    if (videoCodec === undefined) {
      throw new MediaError("unsupported_input", "Could not determine video codec.", {
        inputPath: probe.inputPath
      });
    }

    return {
      inputPath: probe.inputPath,
      durationSeconds,
      duration: formatDuration(durationSeconds),
      width,
      height,
      frameRate: {
        raw: frameRateRaw,
        fps
      },
      videoCodec,
      audio: normalizeAudio(audioStream),
      streams: {
        video: videoStreams.length,
        audio: audioStreams.length
      }
    };
  }
}

export function parseFrameRate(value: string | undefined): number | undefined {
  if (!value || value === "0/0") {
    return undefined;
  }

  const [numerator, denominator] = value.split("/").map(Number);
  if (denominator !== undefined && Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
    return numerator / denominator;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function formatDuration(durationSeconds: number): string {
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  const seconds = durationSeconds % 60;
  const wholeSeconds = Math.floor(seconds);
  const milliseconds = Math.round((seconds - wholeSeconds) * 1000);

  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${wholeSeconds
    .toString()
    .padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
}

function normalizeAudio(stream: Record<string, unknown> | undefined): VideoInfo["audio"] {
  if (!stream) {
    return { hasAudio: false };
  }

  const codec = firstString(stream.codec_name, stream.codec_long_name);
  const sampleRate = finiteNumber(stream.sample_rate);
  const channels = finiteNumber(stream.channels);

  return {
    hasAudio: true,
    ...(codec ? { codec } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(channels !== undefined ? { channels } : {})
  };
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}
