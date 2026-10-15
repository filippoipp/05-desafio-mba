export enum VideoStatus {
  Draft = 'draft',
  Processing = 'processing',
  Ready = 'ready',
  Failed = 'failed',
}

export interface VideoMetadata {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  formatName: string | null;
}
