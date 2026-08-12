import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AudioExtractionService } from "./media/audioExtraction.js";
import { ClipExtractionService } from "./media/clipExtraction.js";
import { CropRegionService } from "./media/cropRegion.js";
import { MediaError } from "./media/errors.js";
import { FrameExtractionService } from "./media/frameExtraction.js";
import { VideoInfoService } from "./media/videoInfo.js";

export function createGameVideoAnalysisServer(): McpServer {
  const server = new McpServer({
    name: "game-video-analysis-mcp",
    version: "0.1.0"
  });
  const videoInfoService = new VideoInfoService();
  const frameExtractionService = new FrameExtractionService();
  const clipExtractionService = new ClipExtractionService();
  const audioExtractionService = new AudioExtractionService();
  const cropRegionService = new CropRegionService();

  server.registerResource(
    "server-capabilities",
    "game-video-analysis://capabilities",
    {
      title: "Game Video Analysis MCP capabilities",
      description: "Foundation capabilities available before video extraction tools are added.",
      mimeType: "application/json"
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              server: "game-video-analysis-mcp",
              scope: "generic_video_observation",
              foundation: {
                mcpServer: true,
                ffmpegExecutionLayer: true,
                inputPathValidation: true,
                managedTemporaryFiles: true,
                videoInfo: true
              },
              tools: ["get_video_info", "get_frame", "get_frames", "get_clip", "get_audio", "crop_region"],
              excluded: ["apex_specific_analysis", "ocr", "audio_event_classification", "coaching"]
            },
            null,
            2
          )
        }
      ]
    })
  );

  server.registerTool(
    "get_video_info",
    {
      title: "Get video info",
      description: "Inspect a local video with ffprobe and return normalized metadata.",
      inputSchema: {
        inputPath: z.string().min(1).describe("Local path to the video file to inspect.")
      },
      outputSchema: {
        inputPath: z.string(),
        durationSeconds: z.number(),
        duration: z.string(),
        width: z.number(),
        height: z.number(),
        frameRate: z.object({
          raw: z.string(),
          fps: z.number()
        }),
        videoCodec: z.string(),
        audio: z.object({
          hasAudio: z.boolean(),
          codec: z.string().optional(),
          sampleRate: z.number().optional(),
          channels: z.number().optional()
        }),
        streams: z.object({
          video: z.number(),
          audio: z.number()
        })
      }
    },
    async ({ inputPath }) => {
      try {
        const structuredContent = await videoInfoService.getVideoInfo(inputPath);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(structuredContent, null, 2)
            }
          ],
          structuredContent
        };
      } catch (error) {
        const payload =
          error instanceof MediaError
            ? error.toJSON()
            : {
                code: "unexpected_error",
                message: error instanceof Error ? error.message : String(error),
                details: {}
              };

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2)
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "get_frame",
    {
      title: "Get frame",
      description: "Extract one image frame from a local video at a requested timestamp.",
      inputSchema: {
        inputPath: z.string().min(1).describe("Local path to the video file to inspect."),
        timestamp: z.union([z.number(), z.string()]).describe("Timestamp in seconds or HH:MM:SS.mmm form."),
        format: z.enum(["png", "jpeg"]).optional().describe("Output image format. Defaults to png.")
      },
      outputSchema: {
        inputPath: z.string(),
        outputDirectory: z.string(),
        frame: frameOutputSchema()
      }
    },
    async (request) => toToolResponse(() => frameExtractionService.getFrame(request))
  );

  server.registerTool(
    "get_frames",
    {
      title: "Get frames",
      description: "Extract multiple image frames from a local video at a fixed interval.",
      inputSchema: {
        inputPath: z.string().min(1).describe("Local path to the video file to inspect."),
        start: z.union([z.number(), z.string()]).describe("Start timestamp in seconds or HH:MM:SS.mmm form."),
        end: z.union([z.number(), z.string()]).optional().describe("End timestamp in seconds or HH:MM:SS.mmm form."),
        duration: z.number().positive().optional().describe("Duration in seconds when end is omitted."),
        interval: z.number().positive().describe("Frame interval in seconds."),
        maxFrames: z.number().int().positive().optional().describe("Maximum number of frames to extract. Defaults to 12."),
        format: z.enum(["png", "jpeg"]).optional().describe("Output image format. Defaults to png.")
      },
      outputSchema: {
        inputPath: z.string(),
        outputDirectory: z.string(),
        startSeconds: z.number(),
        start: z.string(),
        endSeconds: z.number(),
        end: z.string(),
        intervalSeconds: z.number(),
        count: z.number(),
        frames: z.array(frameOutputSchema())
      }
    },
    async (request) => toToolResponse(() => frameExtractionService.getFrames(request))
  );

  server.registerTool(
    "get_clip",
    {
      title: "Get clip",
      description: "Extract a short MP4 clip from a local video between requested timestamps.",
      inputSchema: {
        inputPath: z.string().min(1).describe("Local path to the video file to inspect."),
        start: z.union([z.number(), z.string()]).describe("Start timestamp in seconds or HH:MM:SS.mmm form."),
        end: z.union([z.number(), z.string()]).optional().describe("End timestamp in seconds or HH:MM:SS.mmm form."),
        duration: z.number().positive().optional().describe("Duration in seconds when end is omitted."),
        maxDurationSeconds: z.number().positive().optional().describe("Maximum allowed output duration. Defaults to 30 seconds.")
      },
      outputSchema: {
        inputPath: z.string(),
        outputDirectory: z.string(),
        clipPath: z.string(),
        format: z.literal("mp4"),
        startSeconds: z.number(),
        start: z.string(),
        endSeconds: z.number(),
        end: z.string(),
        durationSeconds: z.number(),
        duration: z.string(),
        source: z.object({
          inputPath: z.string(),
          width: z.number(),
          height: z.number(),
          durationSeconds: z.number(),
          audio: audioSchema()
        }),
        output: z.object({
          hasAudio: z.boolean(),
          sizeBytes: z.number()
        })
      }
    },
    async (request) => toToolResponse(() => clipExtractionService.getClip(request))
  );

  server.registerTool(
    "get_audio",
    {
      title: "Get audio",
      description: "Extract an audio segment from a local video while preserving channel configuration.",
      inputSchema: {
        inputPath: z.string().min(1).describe("Local path to the video file to inspect."),
        start: z.union([z.number(), z.string()]).describe("Start timestamp in seconds or HH:MM:SS.mmm form."),
        end: z.union([z.number(), z.string()]).optional().describe("End timestamp in seconds or HH:MM:SS.mmm form."),
        duration: z.number().positive().optional().describe("Duration in seconds when end is omitted."),
        format: z.enum(["wav", "m4a"]).optional().describe("Output audio format. Defaults to wav."),
        maxDurationSeconds: z.number().positive().optional().describe("Maximum allowed output duration. Defaults to 60 seconds.")
      },
      outputSchema: {
        inputPath: z.string(),
        outputDirectory: z.string(),
        audioPath: z.string(),
        format: z.enum(["wav", "m4a"]),
        startSeconds: z.number(),
        start: z.string(),
        endSeconds: z.number(),
        end: z.string(),
        durationSeconds: z.number(),
        duration: z.string(),
        source: z.object({
          inputPath: z.string(),
          durationSeconds: z.number(),
          audio: audioMetadataSchema()
        }),
        output: audioMetadataSchema().extend({
          sizeBytes: z.number()
        })
      }
    },
    async (request) => toToolResponse(() => audioExtractionService.getAudio(request))
  );

  server.registerTool(
    "crop_region",
    {
      title: "Crop region",
      description: "Extract and optionally upscale a rectangular region from one video frame.",
      inputSchema: {
        inputPath: z.string().min(1).describe("Local path to the video file to inspect."),
        timestamp: z.union([z.number(), z.string()]).describe("Timestamp in seconds or HH:MM:SS.mmm form."),
        region: z
          .object({
            x: z.number().describe("Left coordinate in pixels or normalized 0..1 units."),
            y: z.number().describe("Top coordinate in pixels or normalized 0..1 units."),
            width: z.number().positive().describe("Region width in pixels or normalized 0..1 units."),
            height: z.number().positive().describe("Region height in pixels or normalized 0..1 units."),
            unit: z.enum(["pixel", "normalized"]).optional().describe("Coordinate unit. Defaults to pixel.")
          })
          .describe("Rectangular crop region."),
        scale: z.number().positive().optional().describe("Output magnification. Defaults to 1."),
        format: z.enum(["png", "jpeg"]).optional().describe("Output image format. Defaults to png.")
      },
      outputSchema: {
        inputPath: z.string(),
        outputDirectory: z.string(),
        imagePath: z.string(),
        timestampSeconds: z.number(),
        timestamp: z.string(),
        format: z.enum(["png", "jpeg"]),
        scale: z.number(),
        region: z.object({
          unit: z.enum(["pixel", "normalized"]),
          pixel: cropRegionSchema(),
          normalized: cropRegionSchema()
        }),
        output: z.object({
          width: z.number(),
          height: z.number(),
          sizeBytes: z.number()
        }),
        source: z.object({
          inputPath: z.string(),
          width: z.number(),
          height: z.number(),
          durationSeconds: z.number()
        })
      }
    },
    async (request) => toToolResponse(() => cropRegionService.cropRegion(request))
  );

  return server;
}

function audioSchema() {
  return z.object({
    hasAudio: z.boolean(),
    codec: z.string().optional(),
    sampleRate: z.number().optional(),
    channels: z.number().optional()
  });
}

function audioMetadataSchema() {
  return audioSchema().extend({
    channelLayout: z.string().optional()
  });
}

function frameOutputSchema() {
  return z.object({
    imagePath: z.string(),
    timestampSeconds: z.number(),
    timestamp: z.string(),
    format: z.enum(["png", "jpeg"]),
    source: z.object({
      inputPath: z.string(),
      width: z.number(),
      height: z.number(),
      durationSeconds: z.number()
    })
  });
}

function cropRegionSchema() {
  return z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number()
  });
}

async function toToolResponse<T>(callback: () => Promise<T>) {
  try {
    const structuredContent = await callback();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(structuredContent, null, 2)
        }
      ],
      structuredContent
    };
  } catch (error) {
    const payload =
      error instanceof MediaError
        ? error.toJSON()
        : {
            code: "unexpected_error",
            message: error instanceof Error ? error.message : String(error),
            details: {}
          };

    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(payload, null, 2)
        }
      ]
    };
  }
}
