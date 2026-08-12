import { stat } from "node:fs/promises";
import { join } from "node:path";
import { MediaError } from "./errors.js";
import { FfmpegRunner } from "./ffmpeg.js";
import { ImageFormat, parseTimestamp, TimestampInput } from "./frameExtraction.js";
import { TempWorkspace } from "./temp.js";
import { formatDuration, VideoInfoService } from "./videoInfo.js";

export type CropUnit = "pixel" | "normalized";

export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  unit?: CropUnit;
}

export interface CropRegionRequest {
  inputPath: string;
  timestamp: TimestampInput;
  region: CropRegion;
  scale?: number;
  format?: ImageFormat;
}

export interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NormalizedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropRegionResult {
  [key: string]: unknown;
  inputPath: string;
  outputDirectory: string;
  imagePath: string;
  timestampSeconds: number;
  timestamp: string;
  format: ImageFormat;
  scale: number;
  region: {
    unit: CropUnit;
    pixel: PixelRegion;
    normalized: NormalizedRegion;
  };
  output: {
    width: number;
    height: number;
    sizeBytes: number;
  };
  source: {
    inputPath: string;
    width: number;
    height: number;
    durationSeconds: number;
  };
}

export class CropRegionService {
  constructor(
    private readonly runner = new FfmpegRunner(),
    private readonly videoInfoService = new VideoInfoService(runner)
  ) {}

  async cropRegion(request: CropRegionRequest): Promise<CropRegionResult> {
    const info = await this.videoInfoService.getVideoInfo(request.inputPath);
    const timestampSeconds = parseTimestamp(request.timestamp);
    validateTimestamp(timestampSeconds, info.durationSeconds);
    const sourceDimensions = { width: info.width, height: info.height };
    const pixelRegion = normalizeCropRegion(request.region, sourceDimensions);
    const normalizedRegion = toNormalizedRegion(pixelRegion, sourceDimensions);
    const scale = validateScale(request.scale ?? 1);
    const format = request.format ?? "png";
    const workspace = await TempWorkspace.create("game-video-analysis-crop-");

    try {
      const extension = format === "jpeg" ? "jpg" : "png";
      const imagePath = join(workspace.path, `crop-${millisecondsLabel(timestampSeconds)}.${extension}`);
      const outputWidth = Math.max(1, Math.round(pixelRegion.width * scale));
      const outputHeight = Math.max(1, Math.round(pixelRegion.height * scale));

      await this.runner.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        timestampSeconds.toFixed(3),
        "-i",
        info.inputPath,
        "-frames:v",
        "1",
        "-an",
        "-vf",
        `crop=${pixelRegion.width}:${pixelRegion.height}:${pixelRegion.x}:${pixelRegion.y},scale=${outputWidth}:${outputHeight}:flags=neighbor`,
        imagePath
      ]);

      const outputStats = await stat(imagePath).catch((cause: unknown) => {
        throw new MediaError("crop_extraction_failed", "ffmpeg did not create the requested crop image.", {
          imagePath,
          cause: cause instanceof Error ? cause.message : String(cause)
        });
      });

      if (!outputStats.isFile() || outputStats.size === 0) {
        throw new MediaError("crop_extraction_failed", "ffmpeg created an empty or invalid crop image.", {
          imagePath,
          size: outputStats.size
        });
      }

      return {
        inputPath: info.inputPath,
        outputDirectory: workspace.path,
        imagePath,
        timestampSeconds,
        timestamp: formatDuration(timestampSeconds),
        format,
        scale,
        region: {
          unit: request.region.unit ?? "pixel",
          pixel: pixelRegion,
          normalized: normalizedRegion
        },
        output: {
          width: outputWidth,
          height: outputHeight,
          sizeBytes: outputStats.size
        },
        source: {
          inputPath: info.inputPath,
          width: info.width,
          height: info.height,
          durationSeconds: info.durationSeconds
        }
      };
    } catch (error) {
      await workspace.dispose();
      throw error;
    }
  }
}

export function normalizeCropRegion(region: CropRegion, source: { width: number; height: number }): PixelRegion {
  const unit = region.unit ?? "pixel";

  if (unit === "normalized") {
    validateFiniteRegion(region);
    validateNormalizedRegion(region);

    return validatePixelRegion(
      {
        x: Math.round(region.x * source.width),
        y: Math.round(region.y * source.height),
        width: Math.round(region.width * source.width),
        height: Math.round(region.height * source.height)
      },
      source
    );
  }

  if (unit !== "pixel") {
    throw new MediaError("invalid_crop_region", "Crop region unit must be pixel or normalized.", {
      unit
    });
  }

  validateFiniteRegion(region);
  return validatePixelRegion(
    {
      x: Math.round(region.x),
      y: Math.round(region.y),
      width: Math.round(region.width),
      height: Math.round(region.height)
    },
    source
  );
}

function validateTimestamp(timestampSeconds: number, durationSeconds: number): void {
  if (timestampSeconds > durationSeconds) {
    throw new MediaError("timestamp_out_of_range", "timestamp is outside the input video duration.", {
      timestamp: timestampSeconds,
      durationSeconds
    });
  }
}

function validateScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new MediaError("invalid_crop_region", "scale must be a finite positive number.", {
      scale
    });
  }

  return scale;
}

function validateFiniteRegion(region: CropRegion): void {
  for (const field of ["x", "y", "width", "height"] as const) {
    if (!Number.isFinite(region[field])) {
      throw new MediaError("invalid_crop_region", `Crop region ${field} must be finite.`, {
        [field]: region[field]
      });
    }
  }
}

function validateNormalizedRegion(region: CropRegion): void {
  if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > 1 || region.y + region.height > 1) {
    throw new MediaError("invalid_crop_region", "Normalized crop region must fit within 0..1 source bounds.", {
      region
    });
  }
}

function validatePixelRegion(region: PixelRegion, source: { width: number; height: number }): PixelRegion {
  if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) {
    throw new MediaError("invalid_crop_region", "Crop region coordinates must be non-negative and dimensions must be positive.", {
      region
    });
  }

  if (region.x + region.width > source.width || region.y + region.height > source.height) {
    throw new MediaError("invalid_crop_region", "Crop region must fit within the source video dimensions.", {
      region,
      source
    });
  }

  return region;
}

function toNormalizedRegion(region: PixelRegion, source: { width: number; height: number }): NormalizedRegion {
  return {
    x: roundSix(region.x / source.width),
    y: roundSix(region.y / source.height),
    width: roundSix(region.width / source.width),
    height: roundSix(region.height / source.height)
  };
}

function millisecondsLabel(seconds: number): string {
  return Math.round(seconds * 1000).toString().padStart(9, "0");
}

function roundSix(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
