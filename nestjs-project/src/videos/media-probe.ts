import { spawn } from 'child_process';
import { access } from 'fs/promises';
import { VideoMetadata } from './video-status';

interface ProbeJson {
  format?: { duration?: string; format_name?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
  }>;
}

export function parseProbe(stdout: string): VideoMetadata {
  const json = JSON.parse(stdout) as ProbeJson;
  const streams = json.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const raw = Number(json.format?.duration ?? video?.duration ?? 0);

  return {
    durationSeconds: Number.isFinite(raw) ? raw : 0,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    formatName: json.format?.format_name ?? null,
  };
}

function run(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? 1,
      });
    });
  });
}

export async function probe(filePath: string): Promise<VideoMetadata> {
  const result = await run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr || 'ffprobe failed');
  }
  return parseProbe(result.stdout);
}

export async function extractThumbnail(
  filePath: string,
  destPath: string,
  durationSeconds: number,
): Promise<void> {
  const seek = durationSeconds >= 2 ? '1' : '0';
  const result = await run('ffmpeg', [
    '-y',
    '-ss',
    seek,
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    destPath,
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr || 'ffmpeg failed');
  }
  try {
    await access(destPath);
  } catch {
    throw new Error(result.stderr || 'ffmpeg produced no thumbnail');
  }
}
