#!/usr/bin/env bun

import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGameVideoAnalysisServer } from "./server.js";

export async function main(): Promise<void> {
  const server = createGameVideoAnalysisServer();
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
