export type MediaErrorCode =
  | "binary_not_found"
  | "invalid_input_path"
  | "unsupported_input"
  | "process_failed"
  | "process_timeout"
  | "invalid_probe_output"
  | "temporary_workspace_error";

export class MediaError extends Error {
  constructor(
    public readonly code: MediaErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "MediaError";
  }

  toJSON(): { code: MediaErrorCode; message: string; details: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      details: this.details
    };
  }
}
