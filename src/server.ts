import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createGameVideoAnalysisServer(): McpServer {
  const server = new McpServer({
    name: "game-video-analysis-mcp",
    version: "0.1.0"
  });

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
                managedTemporaryFiles: true
              },
              excluded: ["apex_specific_analysis", "ocr", "audio_event_classification", "coaching"]
            },
            null,
            2
          )
        }
      ]
    })
  );

  return server;
}
