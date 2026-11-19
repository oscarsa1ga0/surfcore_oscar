import { execFile } from 'node:child_process';
import { getImageDimensions } from '../../../../src/image-dimensions.js';

export const WEB_IMAGE_LIMIT = 8 * 1024 * 1024;

export function parseWebImage(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(WEB_IMAGE_LIMIT / 3) * 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4) return null;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > WEB_IMAGE_LIMIT) return null;
  let type;
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) type = 'image/png';
  else if (bytes.subarray(0, 3).toString('hex') === 'ffd8ff') type = 'image/jpeg';
  else if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) type = 'image/gif';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') type = 'image/webp';
  const dimensions = getImageDimensions(bytes);
  if (!type || !dimensions?.width || !dimensions?.height || dimensions.width * dimensions.height > 24_000_000) return null;
  return { type, bytes };
}

export async function webImagePrompt({ type, bytes }, { ffmpeg = 'ffmpeg' } = {}) {
  const buffer = Buffer.from(bytes);
  if (type === 'image/gif' || (type === 'image/webp' && buffer.toString('ascii', 12, 16) === 'VP8X' && (buffer[20] & 2))) {
    // File input is deliberately supplied on stdin. Sample across the decoded animation, with a time and memory bound.
    try {
      const png = await new Promise((resolve, reject) => {
        const child = execFile(ffmpeg, ['-v', 'error', '-threads', '1', '-i', 'pipe:0', '-an',
          '-vf', 'fps=3,scale=320:320:force_original_aspect_ratio=decrease,pad=320:320:(ow-iw)/2:(oh-ih)/2,tile=3x3',
          '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
        { encoding: 'buffer', timeout: 12_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
          if (error || !stdout.length) reject(error || new Error('空动图拼图'));
          else resolve(stdout);
        });
        child.stdin.on('error', () => {});
        child.stdin.end(buffer);
      });
      return { blocks: [
        { type: 'text', text: '动图抽帧拼图，依时间顺序从左到右再换行。空格是补位。' },
        { type: 'image', mediaType: 'image/png', data: png.toString('base64') },
      ], note: '' };
    } catch {
      // Try a real static frame before asking the model to interpret an unsupported GIF container.
      try {
        const childOutput = await new Promise((resolve, reject) => {
          const child = execFile(ffmpeg, ['-v', 'error', '-threads', '1', '-i', 'pipe:0', '-frames:v', '1',
            '-vf', 'scale=960:960:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
          { encoding: 'buffer', timeout: 8_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
            if (error || !stdout.length) reject(error || new Error('空静态帧'));
            else resolve(stdout);
          });
          child.stdin.on('error', () => {});
          child.stdin.end(buffer);
        });
        return { blocks: [{ type: 'image', mediaType: 'image/png', data: childOutput.toString('base64') }], note: '动图抽帧失败，鱼姬只收到首帧。' };
      } catch {
        return { blocks: [{ type: 'text', text: '用户发了动图，当前运行时无法解码。请如实说明你没有看到内容。' }], note: '动图无法解码。可发静态截图，或检查 SurfCore 的 ffmpeg。' };
      }
    }
  }
  return { blocks: [{ type: 'image', mediaType: type, data: buffer.toString('base64') }], note: '' };
}

export function webQuote(message) {
  const type = message.attachments?.[0]?.type ?? '';
  const mediaLabel = message.action === 'sticker' ? '[表情]' : type === 'image/gif' ? '[GIF]'
    : type.startsWith('audio/') ? '[语音]' : type.startsWith('image/') ? '[图片]' : '';
  return { id: message.id, author: message.author, text: String(message.text || mediaLabel || '[消息]').slice(0, 200) };
}

export function webContextMessage(message, chars) {
  const media = (message.attachments ?? []).map(({ id, type }) => ({
    id, type, kind: type.startsWith('audio/') ? 'audio' : 'image',
  }));
  return {
    seq: message.seq, id: message.id, messageId: message.id, author: message.author,
    text: String(message.text ?? '').slice(0, chars), at: message.at,
    ...(message.quote ? { quote: message.quote } : {}),
    ...(message.action ? { action: message.action } : {}),
    ...(media.length ? { media, hasMedia: true } : {}),
  };
}

const opusHeader = Buffer.from('A_OPUS');

export function parseWebAudio(data) {
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(WEB_IMAGE_LIMIT / 3) * 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4) return null;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length < 24 || bytes.length > WEB_IMAGE_LIMIT) return null;
  const head = bytes.toString('ascii', 0, 4);
  let type;
  if (head === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') type = 'audio/wav';
  else if (head === 'OggS') type = 'audio/ogg';
  else if (bytes.toString('ascii', 4, 8) === 'ftyp') type = 'audio/mp4';
  else if (bytes.readUInt32BE(0) === 0x1a45dfa3 && bytes.subarray(0, 4096).includes(opusHeader)) type = 'audio/webm';
  else if (head.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) type = 'audio/mpeg';
  else if (head === 'fLaC') type = 'audio/flac';
  return type ? { type, bytes } : null;
}
