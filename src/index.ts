import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGameVideoAnalysisServer } from "./server.js";

export async function main(): Promise<void> {
  const server = createGameVideoAnalysisServer();
  await server.connect(new StdioServerTransport());
}
