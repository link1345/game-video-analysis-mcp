import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaError } from "./errors.js";

export class TempWorkspace implements AsyncDisposable {
  private disposed = false;

  private constructor(public readonly path: string) {}

  static async create(prefix = "game-video-analysis-"): Promise<TempWorkspace> {
    const path = await mkdtemp(join(tmpdir(), prefix)).catch((cause: unknown) => {
      throw new MediaError("temporary_workspace_error", "Failed to create a temporary workspace.", {
        cause: cause instanceof Error ? cause.message : String(cause)
      });
    });

    return new TempWorkspace(path);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    await rm(this.path, { recursive: true, force: true });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

export async function withTempWorkspace<T>(
  callback: (workspace: TempWorkspace) => Promise<T>,
  prefix?: string
): Promise<T> {
  const workspace = await TempWorkspace.create(prefix);

  try {
    return await callback(workspace);
  } finally {
    await workspace.dispose();
  }
}
