import { isDeepStrictEqual } from 'node:util';
import { validatePlan } from './plan.js';

function fail(code, message, hint) {
  throw Object.assign(new Error(message), { code, hint });
}

export function revisePlan(store, id, revision, patch, limits, checkAssets = () => {}) {
  const current = store.getPlan(id, revision);
  if (!current) fail('VIDEO_BAD_REVISION', '找不到要修改的版本', '先查看项目状态和版本号');
  const plan = current.plan;
  const sections = ['title', 'scenes', 'cover', 'audioTracks', 'submission'];
  if (!patch || Array.isArray(patch) || typeof patch !== 'object'
    || Object.keys(patch).some((key) => !sections.includes(key))) {
    fail('VIDEO_BAD_PATCH', '补丁包含未知字段', '可修改 title/scenes/cover/audioTracks/submission');
  }
  if ('scenes' in patch) {
    const edits = patch.scenes;
    if (!Array.isArray(edits) || !edits.length) fail('VIDEO_BAD_PATCH', 'scenes 需要镜头补丁数组', '每项通过 id 指定现有镜头');
    const seen = new Set();
    for (const edit of edits) {
      const index = plan.scenes.findIndex((scene) => scene.id === edit?.id);
      if (index < 0 || seen.has(edit.id) || Object.keys(edit).some((key) => !['id', 'visual', 'duration', 'lines', 'titleCard', 'transitionOut'].includes(key))) {
        fail('VIDEO_BAD_PATCH', '镜头补丁有未知/重复镜头或字段', '用计划里的镜头 id。增删或重新排序时请用 save');
      }
      seen.add(edit.id);
      const scene = plan.scenes[index];
      for (const [key, value] of Object.entries(edit)) {
        if (key === 'id') continue;
        if (!['visual', 'duration', 'transitionOut'].includes(key)) {
          scene[key] = value;
          continue;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          fail('VIDEO_BAD_PATCH', `镜头 ${edit.id} 的 ${key} 必须是对象`, '使用对象指定想修改的剪辑字段');
        }
        // null 指定删除可选参数，例如把视频镜头换成图片时移除 inMs/outMs。
        const updated = { ...scene[key], ...value };
        for (const field of Object.keys(value)) {
          if (value[field] === null) delete updated[field];
        }
        scene[key] = updated;
      }
    }
  }
  for (const key of sections.filter((key) => key !== 'scenes')) {
    if (key in patch) plan[key] = ['cover', 'submission'].includes(key) ? { ...plan[key], ...patch[key] } : patch[key];
  }
  const check = validatePlan(plan, { limits });
  if (!check.ok) fail('VIDEO_PLAN_INVALID', '修订后的计划校验失败', check.errors.map((e) => `${e.path}：${e.message}`).join('；'));
  checkAssets(plan);
  return store.savePlan(id, plan, { expectRevision: revision });
}

export function compareVersions(store, id, from, to) {
  const left = store.getPlan(id, from)?.plan;
  const right = store.getPlan(id, to)?.plan;
  if (!left || !right) fail('VIDEO_BAD_REVISION', '比较需要两个有效版本', '用 status 查看版本号');
  const before = new Map(left.scenes.map((scene) => [scene.id, scene]));
  const after = new Map(right.scenes.map((scene) => [scene.id, scene]));
  const sceneChanges = [...new Set([...before.keys(), ...after.keys()])].flatMap((sceneId) => {
    const a = before.get(sceneId);
    const b = after.get(sceneId);
    if (!a) return [{ sceneId, change: 'added' }];
    if (!b) return [{ sceneId, change: 'removed' }];
    const fields = Object.keys({ ...a, ...b }).filter((key) => !isDeepStrictEqual(a[key], b[key]));
    if (!fields.length) return [];
    const edit = { sceneId, change: 'edited', fields };
    if (fields.includes('lines')) {
      const left = new Map((a.lines ?? []).map((line) => [line.id, line]));
      const right = new Map((b.lines ?? []).map((line) => [line.id, line]));
      edit.changedLineIds = [...new Set([...left.keys(), ...right.keys()])]
        .filter((id) => !isDeepStrictEqual(left.get(id), right.get(id)));
    }
    return [edit];
  });
  const timing = (revision) => store.getArtifact(id, revision, 'preview')?.meta?.timeline ?? null;
  return {
    from, to, sceneChanges,
    sceneOrderChanged: !isDeepStrictEqual([...before.keys()], [...after.keys()]),
    coverChanged: !isDeepStrictEqual(left.cover, right.cover),
    audioChanged: !isDeepStrictEqual(left.audioTracks ?? [], right.audioTracks ?? []),
    submissionChanged: !isDeepStrictEqual(left.submission, right.submission),
    titleChanged: left.title !== right.title,
    timings: { from: timing(from), to: timing(to) },
    rendered: store.getArtifact(id, to, 'preview')?.meta ?? null,
  };
}
