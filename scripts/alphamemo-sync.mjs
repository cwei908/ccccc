#!/usr/bin/env node
// 法說會素材同步：從 AlphaMemo API 抓追蹤中公司的法說會摘要與逐字稿（零相依，Node 18 以上）
//
//   node scripts/alphamemo-sync.mjs                        增量同步：只讀有變動的場次
//   node scripts/alphamemo-sync.mjs --dry-run              只列出會讀哪些場次，不讀內容、不扣額度、不寫檔
//   node scripts/alphamemo-sync.mjs --full                 重抓完整清單，並移除已下架的場次（建議每週一次）
//   node scripts/alphamemo-sync.mjs --tickers 2330,2454    只同步指定代號（預設：content/notes/ 裡的全部公司）
//   node scripts/alphamemo-sync.mjs --from 2025-01-01      法說會日期下限（預設：一年前）
//
// 金鑰：環境變數 ALPHAMEMO_API_KEY，或寫在專案根目錄的 .env（已列入 .gitignore）。
// 產出：data/alphamemo/，只留在本機，不可 commit。使用規則見 AGENTS.md「法說會素材」一節。
// API 文件：https://www.alphamemo.ai/docs/api/list-transcripts（同目錄下還有 get-transcript、rate-limits、pagination）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'alphamemo');
const RAW = path.join(OUT, 'raw');
const STATE_FILE = path.join(OUT, 'state.json');
const EPOCH = '1970-01-01T00:00:00Z';
const LIST_LIMIT = 100;
const TICKERS_PER_LIST = 50;

// ---------------------------------------------------------------- 設定與參數

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  // Windows PowerShell 的 > 會存成 UTF-16，這裡一起處理
  const buf = fs.readFileSync(file);
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function parseArgs(argv) {
  const opts = { dryRun: false, full: false, tickers: null, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) die(`${a} 後面要接一個值`);
      return v;
    };
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--full') opts.full = true;
    else if (a === '--tickers') opts.tickers = next().split(/[,，\s]+/).filter(Boolean);
    else if (a.startsWith('--tickers=')) opts.tickers = a.slice(10).split(/[,，\s]+/).filter(Boolean);
    else if (a === '--from') opts.from = next();
    else if (a.startsWith('--from=')) opts.from = a.slice(7);
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(0);
    } else die(`看不懂的參數：${a}（用 --help 看用法）`);
  }
  return opts;
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// 台灣日期（UTC+8），API 的 call_date、date_from 都用台灣日期
function taipeiDate(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
}

function trackedTickers() {
  const dir = path.join(ROOT, 'content', 'notes');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').match(/^code:\s*["']?([0-9A-Z]+)["']?\s*$/m)?.[1])
    .filter(Boolean)
    .sort();
}

// ---------------------------------------------------------------- HTTP

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastQuota = null;

async function api(apiBase, key, pathname, { params, headers = {} } = {}) {
  const url = new URL(apiBase.replace(/\/$/, '') + pathname);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);

  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt >= 4) throw new Error(`連線失敗：${err.message}`);
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }

    const uniqueLeft = res.headers.get('x-quota-unique-remaining');
    const totalLeft = res.headers.get('x-quota-total-remaining');
    if (uniqueLeft !== null || totalLeft !== null) lastQuota = { unique: uniqueLeft, total: totalLeft };

    // 每分鐘 120 次：用完就等到重置時間
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      if (reset) await sleep(Math.max(0, reset * 1000 - Date.now()) + 1000);
    }

    if (res.status === 429 && attempt < 6) {
      const wait = Number(res.headers.get('retry-after')) || 10;
      console.log(`  請求太頻繁，等 ${wait} 秒後重試`);
      await sleep(wait * 1000);
      continue;
    }
    if ((res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) && attempt < 4) {
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }

    const text = res.status === 304 ? '' : await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { detail: text.slice(0, 200) };
    }
    return { status: res.status, headers: res.headers, body };
  }
}

const problem = (r) => {
  const b = r.body || {};
  return [b.code, b.title, b.detail].filter(Boolean).join('：') || `HTTP ${r.status}`;
};

// ---------------------------------------------------------------- 狀態檔

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { version: 1, tickers: {}, items: {} };
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return { version: 1, tickers: s.tickers || {}, items: s.items || {} };
}

function saveState(state) {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// 雙重保險：資料夾內放一個忽略全部檔案的 .gitignore，就算根目錄的 .gitignore 被改掉也不會被 commit
function guardOutputDir() {
  fs.mkdirSync(RAW, { recursive: true });
  const gi = path.join(OUT, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# 法說會素材只留在本機，不可 commit（見 AGENTS.md）\n*\n');
}

// ---------------------------------------------------------------- 輸出 Markdown

function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function duration(sec) {
  const m = Math.round((Number(sec) || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分`;
}

const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();
const cell = (s) => oneLine(s).replace(/\|/g, '｜');

function deckLinks(meta) {
  const links = [];
  if (meta.deck_zh_url) links.push(`[中文](${meta.deck_zh_url})`);
  if (meta.deck_en_url) links.push(`[英文](${meta.deck_en_url})`);
  return links.join('・') || '無';
}

function renderDigest(meta, data) {
  const speakers = data.speakers || {};
  const who = (code) => speakers[code]?.name || code || '未知講者';
  const lines = [];
  lines.push(`# ${meta.ticker} ${meta.company_name} 法說會 ${meta.call_date}`);
  lines.push('');
  lines.push('> 本檔由 scripts/alphamemo-sync.mjs 從 AlphaMemo API 產生，僅供個人研究使用：不可 commit、不可貼到網站。');
  lines.push('> 摘要與逐字稿是 AI 生成。寫進筆記前要用自己的話改寫，數字一律回頭對法說會簡報或財報，引用時寫簡報或財報。');
  lines.push('');
  lines.push(`- 法說會日期：${meta.call_date}`);
  lines.push(`- 長度：${duration(meta.duration_seconds)}`);
  lines.push(`- 語言：${data.language || meta.language}${data.is_translated ? `（由 ${data.original_language} 翻譯）` : '（原文）'}`);
  lines.push(`- 簡報 PDF：${deckLinks(meta)}`);
  lines.push(`- AlphaMemo ID：\`${meta.id}\``);
  lines.push(`- 內容最後變動：${data.transcript_updated_at || meta.updated_at}`);
  lines.push('');

  const codes = Object.keys(speakers);
  if (codes.length) {
    lines.push('## 講者', '', '| 代號 | 姓名 | 公司 | 職稱 |', '| --- | --- | --- | --- |');
    for (const c of codes) {
      const s = speakers[c] || {};
      lines.push(`| ${cell(c)} | ${cell(s.name)} | ${cell(s.company)} | ${cell(s.title)} |`);
    }
    lines.push('');
  }

  lines.push('## 摘要', '');
  const summary = Array.isArray(data.summary) ? data.summary : [];
  if (!summary.length) lines.push('（沒有摘要）', '');
  for (const sec of summary) {
    if (sec.heading) lines.push(`### ${oneLine(sec.heading)}`, '');
    for (const item of sec.items || []) {
      const refs = (item.sources || []).map((s) => `${who(s.speaker)} ${clock(s.start_sec)}–${clock(s.end_sec)}`);
      lines.push(`- ${oneLine(item.text)}${refs.length ? `（${refs.join('；')}）` : ''}`);
    }
    lines.push('');
  }

  lines.push('## 逐字稿', '');
  const sessions = Array.isArray(data.transcript) ? data.transcript : [];
  if (!sessions.length) lines.push('（沒有逐字稿）', '');
  sessions.forEach((sess, idx) => {
    const name = typeof sess.session === 'string' && sess.session.trim() ? sess.session.trim() : `第 ${idx + 1} 段`;
    lines.push(`### ${name}`, '');
    for (const seg of sess.segments || []) {
      lines.push(`**[${clock(seg.start_sec)}] ${who(seg.speaker)}**：${oneLine(seg.text)}`, '');
    }
  });
  return lines.join('\n');
}

function digestPath(state, meta) {
  const existing = state.items[meta.id]?.file;
  if (existing) return existing;
  const dir = String(meta.ticker).replace(/[^0-9A-Za-z.-]/g, '_');
  const taken = new Set(Object.values(state.items).map((i) => i.file).filter(Boolean));
  let rel = `${dir}/${meta.call_date}.md`;
  if (taken.has(rel)) rel = `${dir}/${meta.call_date}-${meta.id.slice(0, 8)}.md`;
  return rel;
}

function writeDigest(state, meta) {
  const rawFile = path.join(RAW, `${meta.id}.json`);
  if (!fs.existsSync(rawFile)) return;
  const data = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  const rel = digestPath(state, meta);
  fs.mkdirSync(path.join(OUT, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(OUT, rel), renderDigest(meta, data));
  state.items[meta.id].file = rel;
}

function removeItem(state, id) {
  const item = state.items[id];
  if (!item) return;
  if (item.file) fs.rmSync(path.join(OUT, item.file), { force: true });
  fs.rmSync(path.join(RAW, `${id}.json`), { force: true });
  delete state.items[id];
}

function writeIndex(state) {
  const byTicker = {};
  for (const [id, it] of Object.entries(state.items)) (byTicker[it.ticker] ||= []).push({ ...it, id });
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  const total = Object.keys(state.items).length;
  const lines = [
    '# 法說會素材索引',
    '',
    `最後同步：${now}（台北時間）。共 ${total} 場，資料來自 AlphaMemo API。`,
    '',
    '這個資料夾只留在本機，不可 commit、不可貼到網站。摘要是 AI 生成，寫筆記時要改寫並回頭對簡報或財報。',
    '',
  ];
  for (const ticker of Object.keys(byTicker).sort()) {
    const rows = byTicker[ticker].sort((a, b) => b.call_date.localeCompare(a.call_date));
    lines.push(`## ${ticker} ${rows[0].company_name}`, '', '| 日期 | 長度 | 摘要與逐字稿 | 簡報 PDF |', '| --- | --- | --- | --- |');
    for (const r of rows) {
      const digest = r.file ? `[開啟](${r.file})` : '尚未讀取';
      lines.push(`| ${r.call_date} | ${clock(r.duration_seconds)} | ${digest} | ${deckLinks(r)} |`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT, 'INDEX.md'), lines.join('\n'));
}

// ---------------------------------------------------------------- 主流程

async function listAll(apiBase, key, params) {
  const items = [];
  let cursor;
  do {
    const r = await api(apiBase, key, '/transcripts', { params: { ...params, limit: LIST_LIMIT, cursor } });
    if (r.status !== 200) throw new Error(`列出法說會失敗：${problem(r)}`);
    items.push(...(r.body.data || []));
    cursor = r.body.has_more ? r.body.next_cursor : null;
  } while (cursor);
  return items;
}

const META_KEYS = ['ticker', 'company_name', 'market', 'call_date', 'language', 'duration_seconds', 'updated_at', 'deck_zh_url', 'deck_en_url'];

async function main() {
  loadDotEnv();
  const opts = parseArgs(process.argv.slice(2));
  const key = process.env.ALPHAMEMO_API_KEY;
  const apiBase = process.env.ALPHAMEMO_API_BASE || 'https://api.alphamemo.ai/functions/v1/api/v1';
  if (!key) die('找不到 API 金鑰。請在專案根目錄建立 .env，寫一行 ALPHAMEMO_API_KEY=amk_...（.env 已列入 .gitignore），或設定同名環境變數。');
  if (!key.startsWith('amk_')) console.warn('提醒：金鑰通常是 amk_ 開頭，請確認有沒有貼錯。');

  const from = opts.from || taipeiDate(-365);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from))) die('--from 必須是 YYYY-MM-DD');
  const tickers = opts.tickers || trackedTickers();
  if (!tickers.length) die('沒有要同步的公司：content/notes/ 裡沒有筆記，也沒有用 --tickers 指定');
  const bad = tickers.filter((t) => !/^[0-9A-Z]{1,10}$/.test(t));
  if (bad.length) die(`股票代號格式不對：${bad.join('、')}`);

  // 先確認金鑰可用（/usage 不計篇）
  const usage = await api(apiBase, key, '/usage');
  if (usage.status === 401) die('金鑰無效或已停用，請到 AlphaMemo 設定 › API 金鑰重新產生。');
  if (usage.status === 403) die(`帳號沒有 API 權限（需要 Pro 或 Pro Max）：${problem(usage)}`);
  if (usage.status !== 200) die(`查詢用量失敗：${problem(usage)}`);
  console.log(`本期用量：${JSON.stringify(usage.body?.data ?? usage.body)}`);
  console.log(`同步範圍：${tickers.join('、')}，法說會日期 ${from} 以後${opts.full ? '（完整重抓）' : ''}${opts.dryRun ? '（試跑，不讀內容）' : ''}`);

  const state = loadState();
  if (!opts.dryRun) guardOutputDir();

  // 依「從哪個時間點開始抓」把代號分組，同一組用一次列表請求
  const groups = new Map();
  for (const t of tickers) {
    const prev = state.tickers[t];
    let after = EPOCH;
    if (!opts.full && prev?.updatedAfter && prev.from && prev.from <= from) {
      after = new Date(Date.parse(prev.updatedAfter) - 60_000).toISOString(); // 往回推 1 分鐘，避免漏掉
    }
    if (!groups.has(after)) groups.set(after, []);
    groups.get(after).push(t);
  }

  const count = { fetched: 0, unchanged: 0, removed: 0, failed: 0, pending: 0 };
  let quotaHit = null;

  for (const [after, all] of groups) {
    for (let i = 0; i < all.length; i += TICKERS_PER_LIST) {
      const group = all.slice(i, i + TICKERS_PER_LIST);
      const listed = await listAll(apiBase, key, { tickers: group.join(','), market: 'TW', date_from: from, updated_after: after });
      console.log(`\n${group.join('、')}：清單有 ${listed.length} 場${after === EPOCH ? '' : '有變動'}`);

      if (opts.dryRun) {
        for (const m of listed) {
          const local = state.items[m.id];
          const tag = !local?.etag ? '會讀取（計篇）' : local.updated_at === m.updated_at ? '沒變' : '會檢查（沒變就不計篇）';
          console.log(`  ${m.call_date} ${m.ticker} ${m.company_name}：${tag}`);
          if (!local?.etag) count.pending++;
        }
        continue;
      }

      let watermark = null; // 這一組成功處理到哪一筆的 updated_at
      let blocked = false; // 遇到第一筆失敗後，水位就不再往前推
      for (const m of listed) {
        const prevMeta = state.items[m.id];
        const metaChanged = !prevMeta || META_KEYS.some((k) => prevMeta[k] !== m[k]);
        state.items[m.id] = { ...prevMeta, id: m.id, ...Object.fromEntries(META_KEYS.map((k) => [k, m[k] ?? null])) };
        const hasRaw = fs.existsSync(path.join(RAW, `${m.id}.json`));

        if (quotaHit) {
          count.pending++;
          blocked = true;
          continue;
        }

        const headers = hasRaw && prevMeta?.etag ? { 'If-None-Match': prevMeta.etag } : {};
        let r;
        try {
          r = await api(apiBase, key, `/transcripts/${m.id}`, { headers });
        } catch (err) {
          r = { status: 0, body: { detail: err.message } };
        }

        if (r.status === 200) {
          fs.writeFileSync(path.join(RAW, `${m.id}.json`), JSON.stringify(r.body.data, null, 2));
          state.items[m.id].etag = r.headers.get('etag');
          state.items[m.id].fetched_at = new Date().toISOString();
          writeDigest(state, state.items[m.id]);
          count.fetched++;
          console.log(`  ✓ ${m.call_date} ${m.ticker} ${m.company_name}：已讀取`);
        } else if (r.status === 304) {
          if (metaChanged) writeDigest(state, state.items[m.id]);
          count.unchanged++;
        } else if (r.status === 404) {
          removeItem(state, m.id);
          count.removed++;
          console.log(`  − ${m.call_date} ${m.ticker} ${m.company_name}：內容已下架，移除本機檔案`);
        } else if (r.status === 403 && /monthly_(unique|total)_exceeded/.test(r.body?.code || '')) {
          quotaHit = r.body;
          count.pending++;
          blocked = true;
          continue;
        } else {
          count.failed++;
          blocked = true;
          console.log(`  ✗ ${m.call_date} ${m.ticker} ${m.company_name}：${problem(r)}`);
          continue;
        }
        if (!blocked && (!watermark || m.updated_at > watermark)) watermark = m.updated_at;
        saveState(state);
      }

      // --full 而且整組都順利：清單上已經沒有的場次（下架、刪除）從本機移除
      if (opts.full && !blocked) {
        const seen = new Set(listed.map((m) => m.id));
        for (const [id, it] of Object.entries(state.items)) {
          if (group.includes(it.ticker) && it.call_date >= from && !seen.has(id)) {
            removeItem(state, id);
            count.removed++;
            console.log(`  − ${it.call_date} ${it.ticker} ${it.company_name}：清單上已經沒有，移除本機檔案`);
          }
        }
      }

      for (const t of group) {
        const prev = state.tickers[t];
        const base = prev?.from && prev.from <= from ? prev.updatedAfter : null;
        const next = [base, watermark].filter(Boolean).sort().pop() || null;
        state.tickers[t] = { from, updatedAfter: next };
      }
      saveState(state);
    }
  }

  if (!opts.dryRun) {
    writeIndex(state);
    saveState(state);
  }

  console.log('');
  if (opts.dryRun) {
    console.log(`試跑完成：有 ${count.pending} 場會讀取並計篇。確認後拿掉 --dry-run 再執行。`);
    return;
  }
  console.log(`完成：新讀取 ${count.fetched} 場（計篇）、沒變 ${count.unchanged} 場（不計篇）、移除 ${count.removed} 場、失敗 ${count.failed} 場、未讀 ${count.pending} 場`);
  if (lastQuota) console.log(`本期剩餘額度：不重複篇數 ${lastQuota.unique ?? '—'}、總讀取篇數 ${lastQuota.total ?? '—'}`);
  console.log(`索引：${path.relative(ROOT, path.join(OUT, 'INDEX.md'))}`);
  if (quotaHit) {
    console.log(`\n本月額度已用完（${quotaHit.code}），剩下的場次要等額度重置後再跑。重置資訊：${JSON.stringify(quotaHit.usage ?? {})}`);
  }
  if (count.failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
