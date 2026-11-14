import fs from 'node:fs';
import path from 'node:path';
import { ffmpegPath } from '../../tools/lib/ffmpeg.mjs';

export function resolveFfprobe() {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return null;
  const candidate = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return fs.existsSync(candidate) ? candidate : null;
}

export const LOCAL_MEDIA_FORMATS = 'mov,matroska,webm,wav,mp3,flac,ogg,aac';

const sec = (ms) => (ms / 1000).toFixed(3);

export function clipAudioFilter(index, visual, durationMs, output) {
  return `[${index}:a:0]atrim=start=${sec(visual.inMs)}:end=${sec(visual.outMs)},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume=-15dB,apad,atrim=end=${sec(durationMs)}[${output}]`;
}

export function buildAudioMix(tracks, baseIndex, totalMs, { spoken, original }) {
  const duration = sec(totalMs);
  const inputs = [];
  const filters = [];
  const music = [];
  const effects = [];
  if (spoken && tracks.some((track) => track.kind === 'music')) {
    filters.push('[narration]asplit=2[mainVoice][sideVoice]');
  } else {
    filters.push('[narration]anull[mainVoice]');
  }
  for (const [i, track] of tracks.entries()) {
    const label = `track${i}`;
    inputs.push('-protocol_whitelist', 'file', '-format_whitelist', LOCAL_MEDIA_FORMATS, '-i', track.file);
    filters.push(`[${baseIndex + i}:a:0]atrim=start=${sec(track.inMs)}:end=${sec(track.outMs)},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume=${track.gainDb}dB,adelay=${track.startMs}:all=1,apad,atrim=end=${duration}[${label}]`);
    (track.kind === 'music' ? music : effects).push(`[${label}]`);
  }
  if (music.length) {
    filters.push(`${music.join('')}amix=inputs=${music.length}:duration=longest:normalize=0[music]`);
    filters.push(spoken ? '[music][sideVoice]sidechaincompress=threshold=0.025:ratio=6:attack=20:release=400[backing]' : '[music]anull[backing]');
  }
  const tracksToMix = ['[mainVoice]', ...(original ? ['[original]'] : []), ...effects, ...(music.length ? ['[backing]'] : [])];
  const mix = tracksToMix.length > 1 ? `amix=inputs=${tracksToMix.length}:duration=first:normalize=0` : 'anull';
  filters.push(`${tracksToMix.join('')}${mix},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100,atrim=end=${duration}[aout]`);
  return { inputs, filters };
}
