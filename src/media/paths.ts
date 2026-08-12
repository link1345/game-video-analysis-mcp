import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { MediaError } from "./errors.js";

export async function validateInputVideoPath(inputPath: string): Promise<string> {
  if (inputPath.trim().length === 0) {
    throw new MediaError("invalid_input_path", "Input video path must not be empty.");
  }

  const absolutePath = resolve(inputPath);
  const pathStats = await stat(absolutePath).catch((cause: unknown) => {
    throw new MediaError("invalid_input_path", "Input video path does not exist.", {
      inputPath,
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  });

  if (!pathStats.isFile()) {
    throw new MediaError("invalid_input_path", "Input video path must point to a file.", { inputPath });
  }

  await access(absolutePath, constants.R_OK).catch((cause: unknown) => {
    throw new MediaError("invalid_input_path", "Input video path is not readable.", {
      inputPath,
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  });

  return absolutePath;
}

export function candidateExecutablePaths(command: string, envPath = process.env.PATH ?? ""): string[] {
  if (isAbsolute(command) || command.includes("/")) {
    return [command];
  }

  return envPath
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(entry, command));
}

export async function resolveExecutable(command: string, envPath?: string): Promise<string> {
  for (const candidate of candidateExecutablePaths(command, envPath)) {
    const canExecute = await access(candidate, constants.X_OK)
      .then(() => true)
      .catch(() => false);

    if (canExecute) {
      return candidate;
    }
  }

  throw new MediaError("binary_not_found", `${command} was not found or is not executable.`, {
    command,
    hint: `Install ${command} or configure ${command.toUpperCase()}_PATH.`
  });
}
