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

## Tools

### `get_video_info`

Inspect a local video file with ffprobe and return normalized metadata for later extraction tools.

Input:

```json
{
  "inputPath": "/absolute/path/to/video.mp4"
}
```

Response fields:

- `durationSeconds` and `duration`
- `width` / `height`
- `frameRate.raw` and `frameRate.fps`
- `videoCodec`
- `audio.hasAudio`, plus `audio.codec`, `audio.sampleRate`, and `audio.channels` when available
- `streams.video` and `streams.audio`

The tool returns structured MCP errors for missing paths, unsupported files, missing ffprobe, or files without a video stream.

## Scope

This foundation includes:

- a minimal TypeScript MCP server
- a shared ffmpeg/ffprobe execution layer
- input video path validation
- managed temporary workspace creation and cleanup
- normalized video metadata through `get_video_info`
- structured errors for missing binaries and invalid input
- tests that exercise server startup, ffprobe execution, invalid input, missing binary handling, and temp cleanup

Media extraction tools such as `get_frame`, `get_clip`, and `get_audio` are intentionally left for later issues.
