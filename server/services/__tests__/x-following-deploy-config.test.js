/**
 * X Following 2h lane 部署面一致性测试（timer/service/触发脚本/config/文档）。
 *
 * Contract: 代码模式语义（feed 默认 / hybrid 显式 / per-user 显式）必须与
 * systemd 单元、触发脚本守卫、job 类型、API 端点、.env.example、README
 * 互相咬合 —— 「不能只改代码」的静态守卫。运行时行为由
 * test_x_following_trigger.py（python unittest）覆盖。
 *
 * 纯文件读取，零 DB / 零网络。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const timer = read('deploy', 'thinkpad', 'argus-eagleye-x-following.timer');
const service = read('deploy', 'thinkpad', 'argus-eagleye-x-following.service');
const trigger = read('deploy', 'thinkpad', 'eagleye-x-following.py');
const readme = read('deploy', 'thinkpad', 'README-x-following-incremental.md');
const envExample = read('.env.example');
const jobsSource = read('server', 'services', 'jobs.js');
const settingsRoute = read('server', 'routes', 'settings.js');

describe('X Following 2h lane 部署一致性', () => {
  it('timer：严格 2h 节拍 + 持久化 + 小随机抖动', () => {
    expect(timer, 'OnCalendar 钉死 01/2:10（01:10,03:10,…,23:10，每天 12 次）').toContain('OnCalendar=*-*-* 01/2:10');
    const jitter = Number(timer.match(/^RandomizedDelaySec=(\d+)$/m)?.[1]);
    expect(Number.isFinite(jitter), 'RandomizedDelaySec 必须是整数秒').toBe(true);
    expect(jitter, 'RandomizedDelaySec 不得放大节拍偏移（≤15min）').toBeLessThanOrEqual(900);
    expect(timer, 'Persistent=true 保证停机期间的 tick 补跑一次').toContain('Persistent=true');
    expect(timer, 'WantedBy=timers.target').toContain('WantedBy=timers.target');
  });

  it('service：oneshot 执行触发脚本，EnvironmentFile 与脚本默认 env 文件一致', () => {
    expect(service).toContain('Type=oneshot');
    expect(service, 'ExecStart 指向安装的触发脚本').toContain('ExecStart=/usr/bin/python3 %h/.local/bin/eagleye-x-following.py');
    expect(service, 'EnvironmentFile 指向 eagleye-pipeline.env').toContain('%h/.config/argus/eagleye-pipeline.env');
  });

  it('触发脚本：模式守卫跟随 connector 默认（未设=feed），per-user 才交还 pipeline', () => {
    expect(trigger, 'Effective mode 默认 feed（与 connector resolveXMode 默认一致）').toContain("mode = 'feed'");
    expect(trigger, '守卫元组必须恰好是 feed/hybrid').toContain("if mode not in ('feed', 'hybrid'):");
    expect(trigger, '脚本默认 env 文件与 service EnvironmentFile 同路径').toContain("'.config/argus/eagleye-pipeline.env'");
    expect(trigger, 'overlap 守卫检查 pipeline 单例 job 类型').toContain("('full-pipeline','fetch-all')");
    expect(trigger, 'POST 端点与后端路由一致').toContain("'/api/x-following/sync?background=true'");
  });

  it('job 类型与 API 端点：触发脚本引用的类型/端点在服务端真实存在', () => {
    expect(jobsSource).toContain("FULL_PIPELINE: 'full-pipeline'");
    expect(jobsSource).toContain("FETCH_ALL: 'fetch-all'");
    expect(jobsSource).toContain("X_FOLLOWING_SYNC: 'x-following-sync'");
    expect(settingsRoute).toContain("routes['/api/x-following/sync']");
  });

  it('文档与 env 样例：hybrid 语义、降级限频变量、per-user 回滚口径一致', () => {
    expect(readme, 'README 必须文档化 hybrid 模式').toContain('hybrid');
    expect(readme, 'README 必须文档化降级限频变量').toContain('X_FOLLOWING_FULL_FALLBACK_COOLDOWN_MS');
    expect(readme, '回滚口径：移除 pin 回到 feed 默认，per-user 必须显式 pin').toContain('X_FOLLOWING_MODE=per-user');
    expect(envExample, '.env.example 必须文档化三个模式取值').toMatch(/#.*"hybrid".*feed-first/s);
    expect(envExample).toContain('X_FOLLOWING_FULL_FALLBACK_COOLDOWN_MS=');
  });
});
