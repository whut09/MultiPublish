import path from 'node:path';
import {existsSync} from 'node:fs';

export interface FfmpegResolveOptions {
  resourcesPath?: string;
  appPath?: string;
  importedPath?: string | null;
  cwd?: string;
  envPath?: string;
  exists?: (candidate: string) => boolean;
}

function unpacked(value: string) {
  return value.replace(/app\.asar(?=$|[\\/])/, 'app.asar.unpacked');
}

export function ffmpegCandidates(options: FfmpegResolveOptions = {}) {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const cwd = options.cwd ?? process.cwd();
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    options.envPath,
    resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', executable) : undefined,
    resourcesPath ? path.join(resourcesPath, 'node_modules', 'ffmpeg-static', executable) : undefined,
    options.appPath ? path.join(unpacked(options.appPath), 'node_modules', 'ffmpeg-static', executable) : undefined,
    options.importedPath ? unpacked(options.importedPath) : undefined,
    path.join(cwd, 'node_modules', 'ffmpeg-static', executable),
  ];
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)).map(candidate => path.normalize(candidate)))];
}

export function resolveFfmpegBinary(options: FfmpegResolveOptions = {}) {
  const exists = options.exists ?? existsSync;
  const candidates = ffmpegCandidates(options);
  const binary = candidates.find(exists);
  if (binary) return binary;
  throw new Error('FFmpeg 文件不存在。已检查：' + candidates.join('；'));
}
