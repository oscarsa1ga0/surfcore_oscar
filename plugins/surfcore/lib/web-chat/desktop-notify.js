import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function notifyFishHomeOnMac(count) {
  const message = count === 1 ? '你收到一条新消息。' : '你收到 ' + count + ' 条新消息。';
  await run('/usr/bin/osascript', [
    '-e', 'on run argv',
    '-e', 'display notification (item 1 of argv) with title "鱼姬之家"',
    '-e', 'end run',
    message,
  ], { timeout: 5000 });
}
