/**
 * 日记工具（注册进 DSH 的全局工具面）。
 *
 * 为什么不是 MCP server：
 *   · SurfCore 插件宿主本身就是 DSH 里的一个 host plugin，工具注册用 ctx.tools.register 即可；
 *   · 日记是角色级能力，不属于 QQ，也不该被 QQ 的 MCP server 带着走；
 *   · 少一个 stdio 进程、少一份 profile MCP 配置，测试也能直接调 execute。
 *
 * 工具只做“受控接口”：所有文件操作都走 src/diary-store.js，模型永远拿不到路径参数。
 */
import path from 'node:path';
import {
  captureCandidate, createEntry, deleteEntry, editEntry, getCurrentCharacter, listEntries,
  readEntries, resolveCharacter, searchEntries, shareEntry,
} from '../../../src/diary-store.js';

const CHARACTER_ID = {
  type: 'string',
  description: '可选：当前角色 id。日记会话里带上它可以防止角色切换后写错人；普通对话不用填。',
};

const TAGS = {
  type: 'array',
  items: { type: 'string' },
  description: '可选标签（最多 12 个，每个最多 24 字）。',
};

function textTool(name, description, parameters, handler) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(parameters)) {
    const { required: isRequired, ...schema } = value ?? {};
    properties[key] = schema;
    if (isRequired === true) required.push(key);
  }
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      try {
        const result = await handler(args && typeof args === 'object' ? args : {});
        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error?.message ?? error) });
      }
    },
  };
}

function pickString(args, key, max = 200) {
  const value = args?.[key];
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function resolveCurrent(args) {
  const current = getCurrentCharacter();
  if (!current) throw new Error('当前没有加载角色；日记功能不可用');
  const wanted = String(args?.characterId ?? '').trim();
  if (wanted && wanted !== current.id) {
    throw new Error(`角色已经切换（当前 ${current.id}，调用里是 ${wanted}）；不要往旧角色写日记`);
  }
  return { ...current, diaryDir: path.join(current.dir, 'diary') };
}

export function createDiaryToolDefinitions({ log = () => {}, getConfig = () => ({}) } = {}) {
  const tools = [
    textTool(
      'diary_write',
      '写一篇自己的日记：第一人称、自然，写给自己看，不是给主人交报告。可以写今天发生的事、当时想法、和主人/别人的相处；没有值得记的就别写，不要编造。',
      {
        content: { type: 'string', description: '日记正文（第一人称）；最多 20000 字。', required: true },
        title: { type: 'string', description: '可选标题；不强制。' },
        date: { type: 'string', description: '写哪一天（YYYY-MM-DD）；默认今天，不能写未来。' },
        tags: TAGS,
        visibility: { type: 'string', enum: ['private', 'shareable'], description: '默认 private（只给自己）；shareable 表示这篇你愿意整篇给主人看。' },
        source: { type: 'string', description: '来源标记，如 qq/bili/pet/manual；默认 manual。' },
        characterId: CHARACTER_ID,
      },
      (args) => {
        const current = resolveCurrent(args);
        return createEntry(current.diaryDir, {
          content: args.content,
          title: pickString(args, 'title'),
          date: pickString(args, 'date', 10),
          tags: args.tags,
          visibility: args.visibility,
          source: pickString(args, 'source', 32) || 'manual',
          characterId: current.id,
        });
      },
    ),

    textTool(
      'diary_capture',
      '把今天值得以后回顾的一件事暂存成候选（一句话即可），晚上整理时再决定写不写。普通寒暄、重复信息不用记；不要每轮都记。',
      {
        note: { type: 'string', description: '一句话：发生了什么、为什么值得留（最多 500 字）。', required: true },
        source: { type: 'string', description: '来源标记，如 qq/bili/pet；默认 qq。' },
        tags: TAGS,
        characterId: CHARACTER_ID,
      },
      (args) => {
        const current = resolveCurrent(args);
        const cfg = getConfig() ?? {};
        if (cfg.captureEnabled === false) throw new Error('自主暂存候选已关闭（设置 → SurfCore → 日记 → 允许自主暂存候选）');
        return captureCandidate(current.diaryDir, {
          note: args.note,
          source: pickString(args, 'source', 32) || 'qq',
          tags: args.tags,
          characterId: current.id,
        });
      },
    ),

    textTool(
      'diary_read',
      '读你自己的日记（默认今天，也可按 id）。返回里 private=true 的内容是只给你自己看的；不能原样发给主人——要展示先用 diary_share 选一段摘录。',
      {
        id: { type: 'string', description: '可选：日记 id（如 d-20261112-001）。' },
        date: { type: 'string', description: '可选：读哪一天（YYYY-MM-DD）；不传 id/date 就是今天。' },
        limit: { type: 'number', description: '当天最多读几篇（默认 5，最多 10）。' },
        characterId: CHARACTER_ID,
      },
      (args) => {
        const current = resolveCurrent(args);
        return readEntries(current.diaryDir, {
          id: pickString(args, 'id', 40),
          date: pickString(args, 'date', 10),
          limit: Number(args.limit) || 5,
        });
      },
    ),

    textTool(
      'diary_search',
      '搜自己的历史日记：按关键词、日期范围、标签过滤。只返回摘要片段；需要全文再用 diary_read。',
      {
        query: { type: 'string', description: '关键词；留空则按日期/标签列。' },
        from: { type: 'string', description: '起始日期（YYYY-MM-DD）。' },
        to: { type: 'string', description: '结束日期（YYYY-MM-DD）。' },
        tags: TAGS,
        limit: { type: 'number', description: '最多返回几条（默认 10，最多 50）。' },
        characterId: CHARACTER_ID,
      },
      (args) => {
        const current = resolveCurrent(args);
        return searchEntries(current.diaryDir, {
          query: pickString(args, 'query', 120),
          from: pickString(args, 'from', 10),
          to: pickString(args, 'to', 10),
          tags: args.tags,
          limit: Number(args.limit) || 10,
        });
      },
    ),

    textTool(
      'diary_list',
      '列自己的日记目录：日期、标题、可见性、字数；不含正文。用来回顾有哪些日子写过、哪篇可以再看。',
      {
        from: { type: 'string', description: '起始日期（YYYY-MM-DD）。' },
        to: { type: 'string', description: '结束日期（YYYY-MM-DD）。' },
        tags: TAGS,
        limit: { type: 'number', description: '最多列几条（默认 20，最多 200）。' },
        characterId: CHARACTER_ID,
      },
      (args) => {
        const current = resolveCurrent(args);
        return listEntries(current.diaryDir, {
          from: pickString(args, 'from', 10),
          to: pickString(args, 'to', 10),
          tags: args.tags,
          limit: Number(args.limit) || 20,
        });
      },
    ),

    textTool(
      'diary_edit',
      '改自己的日记：替换正文、追加一段、改标题/标签/可见性。只能改当前角色日记目录里的条目。',
      {
        id: { type: 'string', description: '要改的日记 id。', required: true },
        content: { type: 'string', description: '新正文（整篇替换）；不传就保留原文。' },
        append: { type: 'string', description: '在原文后追加一段（不会覆盖原文）。' },
        title: { type: 'string', description: '新标题；不传就保留。' },
        tags: TAGS,
        visibility: { type: 'string', enum: ['private', 'shareable'], description: '改可见性；private 只能摘录分享。' },
        characterId: CHARACTER_ID,
      },
      (args) => {
        const current = resolveCurrent(args);
        return editEntry(current.diaryDir, {
          id: pickString(args, 'id', 40),
          content: args.content,
          append: args.append,
          title: args.title,
          tags: args.tags,
          visibility: args.visibility,
          characterId: current.id,
        });
      },
    ),

    textTool(
      'diary_delete',
      '删自己的日记（移到回收站，可人工找回）。只删当前角色日记目录里的条目，不会碰别的角色。',
      {
        id: { type: 'string', description: '要删的日记 id。', required: true },
        characterId: CHARACTER_ID,
      },
      (args) => {
        const current = resolveCurrent(args);
        return deleteEntry(current.diaryDir, { id: pickString(args, 'id', 40), characterId: current.id });
      },
    ),

    textTool(
      'diary_share',
      '从一篇日记里选内容给主人看。shareable 可以整篇（mode="full"）；private 只能传正文里的原文片段（mode="excerpt" + excerpt）。会记下这次授权，之后发这段才不会被出站闸拦。',
      {
        id: { type: 'string', description: '要分享的日记 id。', required: true },
        mode: { type: 'string', enum: ['excerpt', 'full'], description: '默认 excerpt；full 只对 shareable 日记有效。' },
        excerpt: { type: 'string', description: 'private 日记要分享的原文片段（必须和正文一字不差，最多 2000 字）。' },
        reason: { type: 'string', description: '可选：为什么愿意分享这一段。' },
        characterId: CHARACTER_ID,
      },
      (args) => {
        const current = resolveCurrent(args);
        return shareEntry(current.diaryDir, {
          id: pickString(args, 'id', 40),
          mode: pickString(args, 'mode', 16) || 'excerpt',
          excerpt: args.excerpt,
          reason: pickString(args, 'reason', 200),
        });
      },
    ),
  ];
  log(`[diary] 已构建 ${tools.length} 个日记工具`);
  return tools;
}

export const DIARY_TOOL_NAMES = Object.freeze([
  'diary_write', 'diary_capture', 'diary_read', 'diary_search',
  'diary_list', 'diary_edit', 'diary_delete', 'diary_share',
]);

// 供脚本直接验证“当前角色解析”不依赖 DSH。
export { resolveCharacter };
