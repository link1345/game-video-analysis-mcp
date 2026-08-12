import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MediaError } from "./media/errors.js";
import { VideoInfoService } from "./media/videoInfo.js";

export function createGameVideoAnalysisServer(): McpServer {
  const server = new McpServer({
    name: "game-video-analysis-mcp",
    version: "0.1.0"
  });
  const videoInfoService = new VideoInfoService();

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
              tools: ["get_video_info"],
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

  return server;
}
