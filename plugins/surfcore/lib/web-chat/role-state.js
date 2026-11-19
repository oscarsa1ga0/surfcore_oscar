import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const LEGACY_FILES = ['memory.json', 'closure.json', 'briefing.md'];

export function createRoleStateFiles(directory, installedRole, log) {
  const roles = path.join(directory, 'roles');
  const ownerFile = path.join(roles, 'legacy-owner');
  let legacyOwner = '';
  try {
    if (LEGACY_FILES.some((name) => fs.existsSync(path.join(directory, name)))) {
      fs.mkdirSync(roles, { recursive: true, mode: 0o700 });
      try { fs.writeFileSync(ownerFile, installedRole, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      legacyOwner = fs.readFileSync(ownerFile, 'utf8');
    }
  } catch (error) {
    log('无法确认旧网页记忆的角色归属', error);
  }

  return (role, name) => {
    const id = createHash('sha256').update(role).digest('hex').slice(0, 32);
    const dir = path.join(roles, id);
    const target = path.join(dir, name);
    if (role === legacyOwner && LEGACY_FILES.includes(name) && !fs.existsSync(target)) {
      try {
        const legacy = path.join(directory, name);
        if (fs.existsSync(legacy)) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          fs.copyFileSync(legacy, target, fs.constants.COPYFILE_EXCL);
        }
      } catch (error) { if (error.code !== 'EEXIST') log('迁移旧网页记忆失败', error); }
    }
    return target;
  };
}
