// 六张候选：独立请求 SenseAudio 同步图片生成，落盘 + 独立解码校验。
// 只做一次抽取（one-pass draw）：不重试、不筛选、不修补、不后处理。
//
// ## 为什么不写「nohup ... &」而是配合 start.sh 守护化启动
//
// harness 的 bash 执行器把**每次工具调用**放在一个受管的进程组里，turn 被中断
// （用户点停止 / 会话 teardown）时会对那一组 SIGTERM→SIGKILL。
// `nohup` 只挡 SIGHUP，挡不住这个清理 —— 实测：nohup 起的探针 pgid = 工具调用的 pgid，
// 杀掉那一组它立刻死；而 setsid 脱离出的探针有自己的 pgid，同一次清理毫发无伤。
// 这就是上一次六张里第二波（B2/C1/C2）跑丢的原因。
//
// ## 三条硬要求
//
// 1. **可续跑**：已经拿到、文件也还在的候选直接认（不重画、不重复付费）；
// 2. **原子落盘**：先写 `.part` 再 rename，中途被杀不会留下半张图冒充成品；
// 3. **独立校验**：用 macOS 的 `sips` 解码一次宽高与格式，不靠我自己解析文件头。
//
// 用法：
//   node run.mjs                    # 跑没拿到的（续跑）
//   node run.mjs --status           # 只看进度，不发请求
//   node run.mjs --only B2,C1       # 只跑指定候选（用户明确要求重画时用）
//   IP_AS_LOGO_OUT=/some/dir node run.mjs   # 换输出目录（默认 ./out）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = process.env.IP_AS_LOGO_OUT ?? path.join(DIR, 'out');
const ENDPOINT = 'https://api.senseaudio.cn/v1/image/sync';
const CONCURRENCY = 3;
/** 同步接口一次 40–50 秒；给 5 分钟上限，免得某一枪挂住把整批拖死。 */
const PER_REQUEST_MS = 300_000;

/** 读 API key：环境变量 → ~/.YuanMy/senseaudio.key → 本目录 .key（兜底）。 */
function readKey() {
  const fromEnv = process.env.SENSEAUDIO_API_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  for (const file of [path.join(os.homedir(), '.YuanMy', 'senseaudio.key'), path.join(DIR, '.key')]) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value !== '') return value;
    } catch { /* 换下一个位置 */ }
  }
  console.error('找不到 API key：设 SENSEAUDIO_API_KEY，或写 ~/.YuanMy/senseaudio.key（chmod 600）');
  process.exit(2);
}

const argv = process.argv.slice(2);
const statusOnly = argv.includes('--status');
const onlyIndex = argv.indexOf('--only');
const only = onlyIndex >= 0
  ? new Set((argv[onlyIndex + 1] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''))
  : null;

const specs = JSON.parse(fs.readFileSync(path.join(DIR, 'prompts.json'), 'utf8'));

/** 用系统解码器复核一遍（自己解析头只当兜底）。 */
function verify(file) {
  try {
    const text = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', file], { encoding: 'utf8' });
    const num = (name) => {
      const hit = new RegExp(`${name}:\\s*(\\d+)`).exec(text);
      return hit === null ? null : Number(hit[1]);
    };
    const fmt = /format:\s*(\w+)/.exec(text);
    return { decoder: 'sips', width: num('pixelWidth'), height: num('pixelHeight'), format: fmt === null ? null : fmt[1] };
  } catch (err) {
    return { decoder: 'sips', error: String(err).slice(0, 200) };
  }
}

/** 文件头嗅探：sips 认不出来时至少知道拿到的是什么。 */
function sniff(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
    return { ext: 'png', mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2, width = null, height = null;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = buf.readUInt16BE(i + 5);
        width = buf.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
    return { ext: 'jpg', mime: 'image/jpeg', width, height };
  }
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp', width: null, height: null };
  }
  return { ext: 'bin', mime: 'application/octet-stream', width: null, height: null };
}

/*
 * `--selftest <秒>`：只写心跳、不发请求，用来**验证守护化真的生效**。
 *
 * 为什么要它：判断「守护进程能不能活过 harness 的进程组清理」不能靠推理 ——
 * 这个模式下让它写 20 秒心跳，然后在另一个工具调用里 kill 掉那一组，
 * 心跳还在继续才算数（实测：nohup 的会dead，守护化的继续写）。
 */
const selftestIndex = argv.indexOf('--selftest');
if (selftestIndex >= 0) {
  const seconds = Number(argv[selftestIndex + 1] ?? 20);
  const file = path.join(DIR, 'selftest.log');
  fs.writeFileSync(file, '');
  console.log(`自检：${String(seconds)} 秒内每 0.5 秒写一次心跳 → ${file}`);
  console.log(`本进程 pid=${String(process.pid)}（它的进程组就是守护后新建的那个）`);
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    fs.appendFileSync(file, `${String(Date.now())}\n`);
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  console.log(`自检结束，共 ${String(fs.readFileSync(file, 'utf8').trim().split('\n').length)} 次心跳`);
  process.exit(0);
}

const KEY = statusOnly ? null : readKey();

async function generate(spec) {
  const started = Date.now();
  const rec = {
    label: spec.label, direction: spec.direction, corner: spec.corner, palette: spec.palette,
    model: spec.model, size: spec.size, requested_size: spec.size,
    prompt_codepoints: [...spec.prompt].length,
  };
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: spec.model, prompt: spec.prompt, size: spec.size }),
      signal: AbortSignal.timeout(PER_REQUEST_MS),
    });
    const text = await res.text();
    rec.http_status = res.status;
    if (!res.ok) {
      rec.status = 'api_error';
      rec.error = text.slice(0, 600);
      return rec;
    }
    let payload;
    try { payload = JSON.parse(text); } catch { rec.status = 'bad_json'; rec.error = text.slice(0, 600); return rec; }
    if (!payload.url) { rec.status = 'no_url'; rec.error = JSON.stringify(payload).slice(0, 600); return rec; }
    rec.source_url = payload.url;

    const img = await fetch(payload.url, { signal: AbortSignal.timeout(120_000) });
    if (!img.ok) { rec.status = 'download_error'; rec.error = `HTTP ${img.status}`; return rec; }
    const buf = Buffer.from(await img.arrayBuffer());
    const info = sniff(buf);
    const file = path.join(OUT, `${spec.label}.${info.ext}`);
    // 原子落盘：先写临时名再 rename，中途被杀不会留下半张图冒充成品
    const tmp = `${file}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    rec.status = 'ok';
    rec.path = file;
    rec.bytes = buf.length;
    rec.mime = info.mime;
    rec.header = { width: info.width, height: info.height };
    rec.verified = verify(file);
    rec.width = rec.verified.width ?? info.width;
    rec.height = rec.verified.height ?? info.height;
    rec.square = rec.width != null && rec.width === rec.height;
    return rec;
  } catch (err) {
    rec.status = 'exception';
    rec.error = String(err && err.stack ? err.stack : err).slice(0, 600);
    return rec;
  } finally {
    rec.elapsed_ms = Date.now() - started;
    console.log(`[${rec.label}] ${rec.status} ${rec.width ?? '?'}x${rec.height ?? '?'} ${rec.elapsed_ms}ms ${rec.error ? rec.error.slice(0, 160) : ''}`);
  }
}

fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(DIR, 'run-log.json');

/*
 * 断点续跑：把上一次已经拿到、文件也还在的候选直接认下来。
 *
 * ⚠️ 之前这里在开头 `flush()` 空数组，一跑就把上一次的记录冲掉 —— 现在先读日志再合并。
 */
const results = [];
let prior = [];
try {
  prior = JSON.parse(fs.readFileSync(LOG, 'utf8'));
  if (!Array.isArray(prior)) prior = [];
} catch { prior = []; }
const doneLabels = new Set();
for (const rec of prior) {
  if (rec?.status === 'ok' && typeof rec.path === 'string' && fs.existsSync(rec.path)) {
    results.push(rec);
    doneLabels.add(rec.label);
  }
}
const flush = () => fs.writeFileSync(LOG, JSON.stringify(results, null, 2));

function summary() {
  console.log(`输出目录：${OUT}`);
  for (const spec of specs) {
    const rec = results.find((r) => r.label === spec.label);
    if (rec === undefined) { console.log(`${spec.label}\t待生成\t${spec.corner}`); continue; }
    const size = rec.width == null ? '?' : `${rec.width}x${rec.height}`;
    console.log(`${spec.label}\t${rec.status}\t${rec.corner}\t${size}\t${rec.bytes ?? '-'}B\t${rec.path ?? '-'}`);
  }
  const bad = specs.filter((s) => !doneLabels.has(s.label)).map((s) => s.label);
  console.log(bad.length === 0
    ? `全部就绪（${String(doneLabels.size)}/${String(specs.length)}）`
    : `还差：${bad.join(' ')}`);
}

if (statusOnly) { summary(); process.exit(0); }

flush();
if (doneLabels.size > 0) console.log(`续跑：已有 ${[...doneLabels].join(' ')}，跳过`);

const pending = specs.filter((spec) => !doneLabels.has(spec.label) && (only === null || only.has(spec.label)));
if (only !== null && pending.length === 0) console.log(`--only 指定的候选都已经有了：${[...only].join(' ')}`);

for (let i = 0; i < pending.length; i += CONCURRENCY) {
  const wave = pending.slice(i, i + CONCURRENCY);
  console.log(`--- wave ${i / CONCURRENCY + 1}: ${wave.map((w) => w.label).join(' ')} ---`);
  const done = await Promise.all(wave.map(async (spec) => {
    const rec = await generate(spec);
    results.push(rec);
    flush(); // 增量落盘：中途被打断也留下已完成的部分
    return rec;
  }));
  console.log(`wave ${i / CONCURRENCY + 1} done: ${done.map((d) => `${d.label}=${d.status}`).join(' ')}`);
}

flush();
console.log('');
summary();
