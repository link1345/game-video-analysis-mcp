export type MediaErrorCode =
  | "binary_not_found"
  | "invalid_input_path"
  | "unsupported_input"
  | "process_failed"
  | "process_timeout"
  | "invalid_probe_output"
  | "temporary_workspace_error"
  | "invalid_timestamp"
  | "invalid_time_range"
  | "timestamp_out_of_range"
  | "too_many_frames"
  | "frame_extraction_failed"
  | "invalid_crop_region"
  | "crop_extraction_failed"
  | "clip_extraction_failed"
  | "no_audio_stream"
  | "audio_extraction_failed";

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
