import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function createExecutable(dir: string, name: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const executablePath = join(dir, name);
  await writeFile(executablePath, `#!/usr/bin/env bun\n${body}\n`);
  await chmod(executablePath, 0o755);
  return executablePath;
}

export async function createFixtureVideo(dir: string, name = "sample.mp4"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const videoPath = join(dir, name);
  await writeFile(videoPath, "stub video fixture");
  return videoPath;
}
