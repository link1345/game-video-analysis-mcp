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

`bun run start` launches a stdio MCP server. MCP clients can also run the package entrypoint directly:

```json
{
  "mcpServers": {
    "game-video-analysis": {
      "command": "bun",
      "args": ["/Users/link/dev/game-video-analysis-mcp/bin/game-video-analysis-mcp.ts"]
    }
  }
}
```

If the package is linked or installed, use the binary name instead:

```json
{
  "mcpServers": {
    "game-video-analysis": {
      "command": "game-video-analysis-mcp"
    }
  }
}
```

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

### `get_frame`

Extract a single image frame from a local video.

Input:

```json
{
  "inputPath": "/absolute/path/to/video.mp4",
  "timestamp": "00:00:12.500",
  "format": "png"
}
```

`timestamp` may be a number of seconds or an `HH:MM:SS.mmm` style string. `format` is optional and defaults to `png`; `jpeg` is also supported.

Response fields:

- `frame.imagePath`
- `frame.timestampSeconds` and `frame.timestamp`
- `frame.format`
- `frame.source.inputPath`, `frame.source.width`, `frame.source.height`, and `frame.source.durationSeconds`
- `outputDirectory`

### `get_frames`

Extract multiple image frames from a local video at a fixed interval.

Input:

```json
{
  "inputPath": "/absolute/path/to/video.mp4",
  "start": 12,
  "end": "00:00:14.000",
  "interval": 0.5,
  "maxFrames": 6,
  "format": "png"
}
```

Use either `end` or `duration`. The default maximum is 12 frames, and the hard maximum is 50 frames. Each returned frame includes the same timestamp and source metadata as `get_frame`.

The frame tools reject invalid timestamps, out-of-range timestamps, and excessive frame requests with structured MCP errors.

### `get_clip`

Extract a short MP4 clip from a local video.

Input:

```json
{
  "inputPath": "/absolute/path/to/video.mp4",
  "start": "00:00:12.000",
  "duration": 3,
  "maxDurationSeconds": 10
}
```

Use either `end` or `duration`. Timestamps may be seconds or `HH:MM:SS.mmm` strings. The default maximum clip duration is 30 seconds, with a hard maximum of 120 seconds. Output is re-encoded as an MP4 for stable compatibility, and an audio track is preserved when the source has one.

Response fields:

- `clipPath`
- `startSeconds` / `start`, `endSeconds` / `end`, and `durationSeconds` / `duration`
- `source.inputPath`, `source.width`, `source.height`, `source.durationSeconds`, and `source.audio`
- `output.hasAudio` and `output.sizeBytes`
- `outputDirectory`

The clip tool rejects missing `end`/`duration`, out-of-range timestamps, reversed ranges, and clips longer than the configured maximum.

### `get_audio`

Extract an audio segment from a local video without forcing mono conversion.

Input:

```json
{
  "inputPath": "/absolute/path/to/video.mp4",
  "start": "00:00:12.000",
  "duration": 3,
  "format": "wav",
  "maxDurationSeconds": 30
}
```

Use either `end` or `duration`. Timestamps may be seconds or `HH:MM:SS.mmm` strings. `format` defaults to `wav` for analysis-friendly PCM output; `m4a` is also available. The default maximum audio duration is 60 seconds, with a hard maximum of 300 seconds. The source channel configuration is preserved when ffmpeg can preserve it.

Response fields:

- `audioPath`
- `format`
- `startSeconds` / `start`, `endSeconds` / `end`, and `durationSeconds` / `duration`
- `source.inputPath`, `source.durationSeconds`, and `source.audio`
- `output.hasAudio`, `output.codec`, `output.sampleRate`, `output.channels`, `output.channelLayout`, and `output.sizeBytes`
- `outputDirectory`

The audio tool returns a structured `no_audio_stream` error for videos without audio, and rejects missing `end`/`duration`, out-of-range timestamps, reversed ranges, and audio segments longer than the configured maximum.

### `crop_region`

Extract a rectangular region from a single frame and optionally upscale it for closer HUD inspection.

Input with pixel coordinates:

```json
{
  "inputPath": "/absolute/path/to/video.mp4",
  "timestamp": "00:00:12.500",
  "region": {
    "x": 1280,
    "y": 80,
    "width": 520,
    "height": 180
  },
  "scale": 2,
  "format": "png"
}
```

Input with normalized coordinates:

```json
{
  "inputPath": "/absolute/path/to/video.mp4",
  "timestamp": 12.5,
  "region": {
    "x": 0.66,
    "y": 0.05,
    "width": 0.27,
    "height": 0.17,
    "unit": "normalized"
  },
  "scale": 2
}
```

`timestamp` may be seconds or an `HH:MM:SS.mmm` string. `region.unit` defaults to `pixel`; normalized coordinates must fit inside the 0..1 source frame. `scale` defaults to 1. Upscaling uses nearest-neighbor interpolation to avoid unnecessary smoothing of small HUD text.

Response fields:

- `imagePath`
- `timestampSeconds` and `timestamp`
- `format` and `scale`
- `region.unit`, `region.pixel`, and `region.normalized`
- `output.width`, `output.height`, and `output.sizeBytes`
- `source.inputPath`, `source.width`, `source.height`, and `source.durationSeconds`
- `outputDirectory`

The crop tool rejects out-of-range timestamps, regions outside the source frame, empty regions, and invalid scale values with structured MCP errors.

## Scope

This foundation includes:

- a minimal TypeScript MCP server
- a shared ffmpeg/ffprobe execution layer
- input video path validation
- managed temporary workspace creation and cleanup
- normalized video metadata through `get_video_info`
- single and interval frame extraction through `get_frame` and `get_frames`
- short MP4 clip extraction through `get_clip`
- bounded audio segment extraction through `get_audio`
- rectangular frame-region extraction and upscaling through `crop_region`
- structured errors for missing binaries and invalid input
- tests that exercise server startup, ffprobe execution, invalid input, missing binary handling, and temp cleanup
