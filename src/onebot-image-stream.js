// NapCat can read its own container's image cache and stream the bytes to the host.
import { createHash, randomUUID } from 'node:crypto';

const CHUNK_SIZE = 64 * 1024;
const MAX_LINE = 2 * CHUNK_SIZE;

// Reject paths, URLs and traversal before giving a message's file reference to any gateway action.
export function isProbablySafeImageFileRef(file) {
  const ref = String(file ?? '').trim();
  return /^[\w.+=@-]{1,512}$/.test(ref) && !ref.includes('..');
}

/** Download via the configured gateway, using only a safe OneBot image reference. */
export async function downloadOneBotImageStream({ httpUrl, accessToken, file, maxBytes, request = fetch }) {
  const ref = String(file ?? '').trim();
  if (!isProbablySafeImageFileRef(ref)) throw new Error('无效的 OneBot 图片引用');
  const response = await request(`${String(httpUrl).replace(/\/+$/, '')}/download_file_image_stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify({ file: ref, chunk_size: CHUNK_SIZE }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`OneBot 图片流不可用（HTTP ${response.status}）`);
  }

  const decoder = new TextDecoder();
  const chunks = [];
  const maxWireBytes = Math.ceil(maxBytes * 4 / 3) + 1024 * (Math.ceil(maxBytes / CHUNK_SIZE) + 3);
  let pending = '';
  let wireBytes = 0;
  let bytes = 0;
  let started = false;
  let complete = false;

  function consume(line) {
    if (!line.trim()) return;
    if (line.length > MAX_LINE || complete) throw new Error('OneBot 图片流帧无效');
    let frame;
    try { frame = JSON.parse(line); } catch { throw new Error('OneBot 图片流帧不是 JSON'); }
    if (frame?.status !== 'ok' || frame.retcode !== 0) throw new Error('OneBot 网关拒绝了图片流请求');
    const packet = frame.data;
    if (!started && packet?.type === 'stream' && packet.data_type === 'file_info') {
      const size = Number(packet.file_size);
      if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) throw new Error('OneBot 图片大小无效或超限');
      started = true;
    } else if (started && packet?.type === 'stream' && packet.data_type === 'file_chunk') {
      if (packet.index !== chunks.length || typeof packet.data !== 'string'
          || packet.data.length > Math.ceil(CHUNK_SIZE / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(packet.data)) {
        throw new Error('OneBot 图片流分块无效');
      }
      const chunk = Buffer.from(packet.data, 'base64');
      bytes += chunk.length;
      if (!chunk.length || chunk.length !== packet.size || bytes > maxBytes) throw new Error('OneBot 图片流大小无效或超限');
      chunks.push(chunk);
    } else if (started && packet?.type === 'response' && packet.data_type === 'file_complete'
        && bytes > 0 && packet.total_bytes === bytes && packet.total_chunks === chunks.length) {
      complete = true;
    } else {
      throw new Error('OneBot 图片流顺序或完成标记无效');
    }
  }

  for await (const chunk of response.body) {
    wireBytes += chunk.length;
    if (wireBytes > maxWireBytes) throw new Error('OneBot 图片流响应超限');
    const lines = (pending + decoder.decode(chunk, { stream: true })).split('\n');
    pending = lines.pop();
    for (const line of lines) consume(line);
    if (pending.length > MAX_LINE) throw new Error('OneBot 图片流帧超限');
  }
  consume(pending + decoder.decode());
  if (!complete) throw new Error('OneBot 图片流未完整接收');
  return Buffer.concat(chunks, bytes);
}

/** Stage validated image bytes inside NapCat for actions that require a gateway-local file. */
export async function uploadOneBotStickerImage(request, image) {
  const { buffer, mimeType } = image;
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[mimeType];
  if (!ext || !buffer?.length) throw new Error('没有可上传的表情图片');
  const streamId = randomUUID();
  const filename = `surfcore-${streamId}.${ext}`;
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const chunkBytes = 256 * 1024;
  const totalChunks = Math.ceil(buffer.length / chunkBytes);
  const signal = AbortSignal.timeout(25_000);
  const upload = async (params) => {
    let reply;
    try {
      reply = await request('upload_file_stream', { stream_id: streamId, ...params }, { signal });
    } catch {
      throw new Error('NapCat 表情图片传输中断');
    }
    if (reply?.status !== 'ok' || reply.retcode !== 0) throw new Error('NapCat 未能接收表情图片');
    return reply.data;
  };
  for (let index = 0; index < totalChunks; index++) {
    const chunk = buffer.subarray(index * chunkBytes, (index + 1) * chunkBytes);
    const data = await upload({
      chunk_data: chunk.toString('base64'),
      chunk_index: index,
      total_chunks: totalChunks,
      file_size: buffer.length,
      expected_sha256: sha256,
      filename,
      file_retention: 120_000,
    });
    if (data?.status !== 'chunk_received' || data.stream_id !== streamId) throw new Error('NapCat 未确认表情分片');
  }
  const complete = await upload({ is_complete: true });
  const file = String(complete?.file_path ?? '');
  const segments = file.split(/[\\/]/);
  if (complete?.status !== 'file_complete'
      || complete.stream_id !== streamId
      || Number(complete.file_size) !== buffer.length
      || String(complete.sha256).toLowerCase() !== sha256
      || !/^(\/|[A-Za-z]:[\\/])/.test(file)
      || /[\u0000-\u001f\u007f]/.test(file)
      || segments.includes('..')
      || segments.at(-1) !== filename) {
    throw new Error('NapCat 未返回经过校验的临时图片');
  }
  return file;
}
