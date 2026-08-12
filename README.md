# Game Video Analysis MCP

Generic MCP server for making gameplay video observable through local video and audio extraction services. Game-specific knowledge, OCR, and coaching logic are intentionally outside this server.

## Requirements

- Bun 1.3+
- ffmpeg and ffprobe available on `PATH`, or configured with `FFMPEG_PATH` and `FFPROBE_PATH`

## Commands

```sh
bun install
bun run typecheck
bun test
bun run start
```

`bun run start` launches a stdio MCP server.

## Scope

This foundation includes:

- a minimal TypeScript MCP server
- a shared ffmpeg/ffprobe execution layer
- input video path validation
- managed temporary workspace creation and cleanup
- structured errors for missing binaries and invalid input
- tests that exercise server startup, ffprobe execution, invalid input, missing binary handling, and temp cleanup

Media extraction tools such as `get_video_info`, `get_frame`, and `get_clip` are intentionally left for later issues.
