// 浏览器之外的图像输出适配器。私聊消息、表情和头像均由宿主校验本轮权限后返回。
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { surfcoreDir } from './token-budget.js';
import { WEB_CHAT_API, WEB_CHAT_PORT } from '../plugins/surfcore/lib/web-chat/port.js';

const server = new McpServer({ name: 'web-images', version: '1.0.0' });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

server.tool(
  'web_read_images',
  '把当前网页私聊回合授权的图片交给视觉模型。先用 web_chat_image_ticket 获取一次性凭证。',
  { ticket: z.string().regex(/^[a-f0-9]{64}$/) },
  async ({ ticket }) => {
    try {
      const token = fs.readFileSync(path.join(surfcoreDir(), 'web-chat', 'notify-token'), 'utf8').trim();
      const response = await fetch(`http://127.0.0.1:${WEB_CHAT_PORT}${WEB_CHAT_API}/model-images`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(50_000),
      });
      const value = await response.json();
      if (!response.ok || !value.ok) return fail([value.error, value.hint].filter(Boolean).join(' ') || '当前回合无法读取这张图。');
      return { content: value.blocks.map((block) => block.type === 'image'
        ? { type: 'image', mimeType: block.mediaType, data: block.data }
        : { type: 'text', text: block.text }) };
    } catch {
      return fail('看图服务暂时不可用。请确认鱼姬之家仍在线，再从当前网页回合申请凭证。');
    }
  },
);

await server.connect(new StdioServerTransport());
