import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
              tools: ["get_video_info", "get_frame", "get_frames"],
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

  return server;
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
