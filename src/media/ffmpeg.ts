import { MediaError } from "./errors.js";
import { resolveExecutable, validateInputVideoPath } from "./paths.js";

export interface FfmpegConfig {
  ffmpegPath?: string;
  ffprobePath?: string;
  envPath?: string;
  timeoutMs?: number;
}

export interface ProcessResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProbeResult {
  inputPath: string;
  format: Record<string, unknown>;
  streams: Array<Record<string, unknown>>;
}

const defaultTimeoutMs = 30_000;

export class FfmpegRunner {
  constructor(private readonly config: FfmpegConfig = {}) {}

  async getFfmpegPath(): Promise<string> {
    return resolveExecutable(this.config.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg", this.config.envPath);
  }

  async getFfprobePath(): Promise<string> {
    return resolveExecutable(this.config.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe", this.config.envPath);
  }

  async runFfmpeg(args: string[]): Promise<ProcessResult> {
    const executable = await this.getFfmpegPath();
    return runProcess(executable, args, this.config.timeoutMs ?? defaultTimeoutMs);
  }

  async runFfprobe(args: string[]): Promise<ProcessResult> {
    const executable = await this.getFfprobePath();
    return runProcess(executable, args, this.config.timeoutMs ?? defaultTimeoutMs);
  }

  async probeVideo(inputPath: string): Promise<ProbeResult> {
    const validatedPath = await validateInputVideoPath(inputPath);
    const result = await this.runFfprobe([
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      validatedPath
    ]);

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (cause) {
      throw new MediaError("invalid_probe_output", "ffprobe returned invalid JSON.", {
        stderr: result.stderr,
        cause: cause instanceof Error ? cause.message : String(cause)
      });
    }

    if (!isProbeJson(parsed)) {
      throw new MediaError("unsupported_input", "ffprobe did not return media stream information.", {
        inputPath: validatedPath,
        stderr: result.stderr
      });
    }

    return {
      inputPath: validatedPath,
      format: parsed.format,
      streams: parsed.streams
    };
  }
}

async function runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  const process = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe"
  });

  const timeout = setTimeout(() => {
    process.kill();
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ]).finally(() => {
    clearTimeout(timeout);
  });

  if (exitCode !== 0) {
    const timedOut = exitCode === null;
    throw new MediaError(timedOut ? "process_timeout" : "process_failed", "ffmpeg process failed.", {
      command,
      args,
      exitCode,
      stderr
    });
  }

  return {
    command,
    args,
    exitCode,
    stdout,
    stderr
  };
}

function isProbeJson(value: unknown): value is { format: Record<string, unknown>; streams: Array<Record<string, unknown>> } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { format?: unknown; streams?: unknown };
  return typeof candidate.format === "object" && candidate.format !== null && Array.isArray(candidate.streams);
}
