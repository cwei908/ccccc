#!/usr/bin/env node
// 個股研究筆記：建置與檢查腳本（零相依，Node 18 以上）
//
//   node scripts/build.mjs          檢查全部內容，通過後產生網頁
//   node scripts/build.mjs --check  只檢查，不寫入任何檔案
//
// 來源：content/notes/*.md、content/pages/*.md、site.config.json
// 產物：index.html、notes/*.html、<頁面>.html（請勿手動修改產物）
// 規則說明見 AGENTS.md；這支腳本負責把其中「可以機器檢查」的部分擋下來。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');
const NOTES_SRC = path.join(ROOT, 'content', 'notes');
const PAGES_SRC = path.join(ROOT, 'content', 'pages');
const NOTES_OUT = path.join(ROOT, 'notes');
const GENERATED_MARK = '<!-- 此檔由 scripts/build.mjs 產生，請勿手動修改；要改內容請改 content/ 後重新建置 -->';

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
const errors = [];
const warnings = [];
const fail = (file, msg) => errors.push(`${file}：${msg}`);
const warn = (file, msg) => warnings.push(`${file}：${msg}`);

// ---------------------------------------------------------------- 工具

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .sort();
}

// ---------------------------------------------------------------- frontmatter

function parseFrontmatter(raw, file) {
  const text = raw.replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) {
    fail(file, '檔案開頭必須是以 --- 包起來的 frontmatter');
    return { data: {}, body: text };
  }
  const data = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) {
      fail(file, `frontmatter 這一行看不懂：「${line}」（格式是 key: value）`);
      continue;
    }
    let value = kv[2].trim();
    if (/^\[.*\]$/.test(value)) {
      value = value
        .slice(1, -1)
        .split(/[,，]/)
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    data[kv[1]] = value;
  }
  return { data, body: m[2] };
}

// ---------------------------------------------------------------- Markdown 子集

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label, url) => {
    const external = /^https?:\/\//.test(url);
    const attrs = external ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${url}"${attrs}>${label}</a>`;
  });
  s = s.replace(/\[(\d+)\](?!\()/g, '<sup class="cite"><a href="#src-$1" aria-label="資料來源 $1">$1</a></sup>');
  return s;
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

const isBlockStart = (line) =>
  /^(#{2,3} |> ?|\||- |\d+\. )/.test(line);

// 把一段 Markdown 轉成區塊陣列，之後再轉 HTML（關鍵數字、資料來源等章節會另外處理）
function parseBlocks(md, file) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^<[a-zA-Z!/]/.test(line.trim())) {
      fail(file, `不可以直接寫 HTML：「${line.trim().slice(0, 30)}…」`);
      i++;
      continue;
    }
    if (/^# /.test(line)) {
      fail(file, '內文不要用一級標題（#），頁面標題由 frontmatter 產生');
      i++;
      continue;
    }
    if (/^#{4,} /.test(line)) {
      fail(file, '標題最多用到三級（###）');
      i++;
      continue;
    }
    if (/^\s+(- |\d+\. )/.test(line)) {
      fail(file, `不支援巢狀清單：「${line.trim().slice(0, 30)}」請改成同一層`);
      i++;
      continue;
    }
    if (/^!\[/.test(line.trim())) {
      fail(file, '目前不支援圖片語法；需要圖片請先依 AGENTS.md「擴充」一節處理');
      i++;
      continue;
    }
    let m;
    if ((m = line.match(/^(#{2,3}) (.+)$/))) {
      blocks.push({ type: m[1].length === 2 ? 'h2' : 'h3', text: m[2].trim() });
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(splitRow(lines[i++]));
      if (rows.length < 2 || !rows[1].every((c) => /^:?-{2,}:?$/.test(c))) {
        fail(file, '表格第二列必須是分隔線（| --- | --- |）');
        continue;
      }
      blocks.push({ type: 'table', head: rows[0], rows: rows.slice(2) });
      continue;
    }
    if (line.startsWith('>')) {
      const parts = [];
      while (i < lines.length && lines[i].startsWith('>')) parts.push(lines[i++].replace(/^> ?/, ''));
      blocks.push({ type: 'quote', text: parts.join('') });
      continue;
    }
    if (/^- \[[ xX]\] /.test(line)) {
      const items = [];
      while (i < lines.length && (m = lines[i].match(/^- \[([ xX])\] (.+)$/))) {
        items.push({ done: m[1] !== ' ', text: m[2] });
        i++;
      }
      blocks.push({ type: 'tasks', items });
      continue;
    }
    if (line.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ') && !/^- \[[ xX]\] /.test(lines[i]))
        items.push(lines[i++].slice(2));
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) items.push(lines[i++].replace(/^\d+\. /, ''));
      blocks.push({ type: 'ol', items });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++].trim());
    blocks.push({ type: 'p', text: para.join('') });
  }
  return blocks;
}

// 數值開頭是 + 套「漲」的顏色，開頭是 - 套「跌」的顏色（台股慣例：漲紅跌綠）
function trendClass(value) {
  if (/^[+＋]/.test(value)) return ' class="up"';
  if (/^[-−－]/.test(value)) return ' class="down"';
  return '';
}

function renderTable(block, { numbers = false } = {}) {
  const head = block.head.map((c) => `<th scope="col">${inline(c)}</th>`).join('');
  const body = block.rows
    .map((row) => {
      const cells = row
        .map((c, idx) => {
          if (numbers && idx === 0) return `<th scope="row">${inline(c)}</th>`;
          if (numbers && idx === 1) return `<td class="num"><span${trendClass(c)}>${inline(c)}</span></td>`;
          return `<td>${inline(c)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n');
  return `<div class="table-wrap"><table${numbers ? ' class="numbers"' : ''}>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`;
}

function renderBlock(b) {
  switch (b.type) {
    case 'h3':
      return `<h3>${inline(b.text)}</h3>`;
    case 'p':
      return `<p>${inline(b.text)}</p>`;
    case 'quote':
      return `<blockquote><p>${inline(b.text)}</p></blockquote>`;
    case 'ul':
      return `<ul>\n${b.items.map((t) => `<li>${inline(t)}</li>`).join('\n')}\n</ul>`;
    case 'ol':
      return `<ol>\n${b.items.map((t) => `<li>${inline(t)}</li>`).join('\n')}\n</ol>`;
    case 'tasks':
      return `<ul class="tasks">\n${b.items
        .map((t) => `<li class="${t.done ? 'done' : 'todo'}"><span class="box" aria-hidden="true"></span><span class="sr-only">${t.done ? '已確認：' : '待追蹤：'}</span>${inline(t.text)}</li>`)
        .join('\n')}\n</ul>`;
    case 'table':
      return renderTable(b);
    default:
      return '';
  }
}

// ---------------------------------------------------------------- 版面

function layout({ title, description, base, current, body, scripts = '' }) {
  const nav = config.nav
    .map((n) => `<a href="${base}${n.href}"${n.href === current ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`)
    .join('\n        ');
  const fullTitle = title ? `${title}｜${config.title}` : config.title;
  return `<!DOCTYPE html>
${GENERATED_MARK}
<html lang="zh-Hant-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(fullTitle)}</title>
  <meta name="description" content="${esc(description || config.description)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600&family=LXGW+WenKai+TC:wght@400;700&family=Noto+Sans+TC:wght@400;500;700&display=swap">
  <link rel="stylesheet" href="${base}assets/style.css">
</head>
<body>
  <a class="skip" href="#main">跳到主要內容</a>
  <header class="site-head">
    <div class="wrap">
      <a class="site-name" href="${base}index.html">${esc(config.title)}</a>
      <nav aria-label="主選單">
        ${nav}
      </nav>
    </div>
  </header>
  <main id="main">
${body}
  </main>
  <footer class="site-foot">
    <div class="wrap">
      <p>這裡是個人學習筆記，不構成任何投資建議。數字以公司公告與公開資訊觀測站為準。</p>
      <p>${esc(config.author)} 整理，原始檔與撰寫規則放在 <a href="${esc(config.repoUrl)}">GitHub</a>。</p>
    </div>
  </footer>${scripts}
</body>
</html>
`;
}

// ---------------------------------------------------------------- 個股筆記

const SOURCE_RE = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*[|｜]\s*([^|｜]+?)\s*[|｜]\s*(\d{4}-\d{2}-\d{2})$/;

function loadNote(filename) {
  const file = `content/notes/${filename}`;
  const raw = fs.readFileSync(path.join(NOTES_SRC, filename), 'utf8');
  const { data, body } = parseFrontmatter(raw, file);
  const slug = filename.replace(/\.md$/, '');

  // --- 檔名與 frontmatter
  const nameMatch = filename.match(/^(\d{4,6}[A-Z]?)-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/);
  if (!nameMatch) fail(file, '檔名格式必須是「股票代號-英文小寫簡稱.md」，例如 2330-tsmc.md');
  const required = ['code', 'name', 'name_en', 'market', 'industry', 'tags', 'summary', 'status', 'created', 'updated', 'data_as_of'];
  for (const key of required) {
    if (data[key] === undefined || data[key] === '' || (Array.isArray(data[key]) && !data[key].length))
      fail(file, `frontmatter 缺少必填欄位 ${key}`);
  }
  if (nameMatch && data.code && nameMatch[1] !== data.code) fail(file, `檔名的代號（${nameMatch[1]}）和 code（${data.code}）不一致`);
  if (data.market && !config.markets.includes(data.market)) fail(file, `market 必須是：${config.markets.join('、')}`);
  if (data.industry && !config.industries.includes(data.industry))
    fail(file, `industry「${data.industry}」不在 site.config.json 的 industries 清單裡（要新增產業請先改設定檔）`);
  if (data.status && !config.statuses.includes(data.status)) fail(file, `status 必須是：${config.statuses.join('、')}`);
  if (data.tags && !Array.isArray(data.tags)) fail(file, 'tags 必須寫成陣列，例如 [晶圓代工, AI]');
  if (Array.isArray(data.tags) && (data.tags.length < 2 || data.tags.length > 5)) fail(file, 'tags 要有 2 到 5 個');
  if (data.summary && [...data.summary].length > config.summaryMaxLength)
    fail(file, `summary 超過 ${config.summaryMaxLength} 個字（目前 ${[...data.summary].length} 個字）`);
  for (const key of ['created', 'updated']) if (data[key] && !isDate(data[key])) fail(file, `${key} 必須是 YYYY-MM-DD`);
  if (isDate(data.created || '') && isDate(data.updated || '') && data.updated < data.created) fail(file, 'updated 不能早於 created');
  if (data.data_as_of && !/^\d{4}Q[1-4]$/.test(data.data_as_of)) fail(file, 'data_as_of 格式是「年度Q季」，例如 2026Q3');

  // --- 禁用詞
  for (const word of config.bannedWords) {
    if (raw.includes(word)) fail(file, `出現禁用詞「${word}」：本站不寫投資建議，請改成描述事實或提出疑問`);
  }

  // --- 章節
  const blocks = parseBlocks(body, file);
  const sections = [];
  for (const b of blocks) {
    if (b.type === 'h2') sections.push({ title: b.text, blocks: [] });
    else if (sections.length) sections[sections.length - 1].blocks.push(b);
    else fail(file, '內文必須從第一個二級標題（## 公司在做什麼）開始，標題前不要放其他內容');
  }
  const expected = config.noteSections.map((s) => s.title);
  const actual = sections.map((s) => s.title);
  if (expected.join('|') !== actual.join('|')) {
    fail(file, `二級標題必須依序是：${expected.join(' → ')}（目前是：${actual.join(' → ') || '沒有'}）`);
  }
  const byId = {};
  config.noteSections.forEach((def) => {
    const found = sections.find((s) => s.title === def.title);
    if (found) byId[def.id] = { ...def, blocks: found.blocks };
  });
  for (const def of config.noteSections) {
    if (byId[def.id] && !byId[def.id].blocks.length) fail(file, `「${def.title}」是空的`);
  }

  // --- 資料來源
  const sources = [];
  if (byId.sources) {
    const list = byId.sources.blocks.find((b) => b.type === 'ol');
    if (!list || byId.sources.blocks.length !== 1) fail(file, '「資料來源」只能放一個編號清單（1. 2. 3.）');
    (list?.items || []).forEach((item, idx) => {
      const m = item.match(SOURCE_RE);
      if (!m) fail(file, `資料來源第 ${idx + 1} 筆格式不對，應為：[標題](網址)｜來源名稱｜YYYY-MM-DD`);
      else if (!isDate(m[4])) fail(file, `資料來源第 ${idx + 1} 筆的日期不是有效日期`);
      else sources.push({ title: m[1], url: m[2], publisher: m[3], date: m[4] });
    });
    if (list && list.items.length < 2) fail(file, '資料來源至少要 2 筆');
  }

  // --- 引用編號
  const used = new Set();
  const bodyWithoutSources = body.split(/^## 資料來源\s*$/m)[0];
  for (const m of bodyWithoutSources.matchAll(/\[(\d+)\](?!\()/g)) used.add(Number(m[1]));
  for (const n of used) if (n < 1 || n > sources.length) fail(file, `內文引用了 [${n}]，但資料來源沒有第 ${n} 筆`);
  sources.forEach((s, idx) => {
    if (!used.has(idx + 1)) warn(file, `資料來源第 ${idx + 1} 筆沒有被內文引用`);
  });
  const hasCite = (blocksOf) => /\[\d+\](?!\()/.test(JSON.stringify(blocksOf));
  for (const id of ['position', 'recent']) {
    if (byId[id] && !hasCite(byId[id].blocks)) fail(file, `「${byId[id].title}」至少要有一個來源引用，例如 [1]`);
  }

  // --- 關鍵數字
  let tiles = [];
  if (byId.numbers) {
    const table = byId.numbers.blocks.find((b) => b.type === 'table');
    if (!table) fail(file, '「關鍵數字」必須有一張表格');
    else {
      if (table.head.join('|') !== '項目|數值|期間|來源') fail(file, '「關鍵數字」表頭必須是：| 項目 | 數值 | 期間 | 來源 |');
      if (table.rows.length < 4) fail(file, '「關鍵數字」至少要 4 列（前 4 列會變成頁首的數字格）');
      table.rows.forEach((row, idx) => {
        if (row.length !== 4) fail(file, `「關鍵數字」第 ${idx + 1} 列要剛好 4 欄`);
        else {
          if (row.some((c) => !c)) fail(file, `「關鍵數字」第 ${idx + 1} 列有空格；查不到的數字不要列`);
          if (!/^\[\d+\]( ?\[\d+\])*$/.test(row[3])) fail(file, `「關鍵數字」第 ${idx + 1} 列的來源欄只能放引用編號，例如 [1]`);
        }
      });
      tiles = table.rows.slice(0, 4).map((r) => ({ label: r[0], value: r[1], period: r[2] }));
    }
  }

  // --- 追蹤清單
  if (byId.watchlist) {
    const tasks = byId.watchlist.blocks.find((b) => b.type === 'tasks');
    if (!tasks || tasks.items.length < 3) fail(file, '「追蹤清單」至少要 3 個待辦項目（- [ ] 開頭）');
  }
  if (byId.risks) {
    const list = byId.risks.blocks.find((b) => b.type === 'ul');
    if (!list || list.items.length < 3) fail(file, '「風險」至少要列 3 點（- 開頭）');
  }

  return { file, slug, data, byId, sources, tiles };
}

function renderNote(note, prev, next) {
  const d = note.data;
  const sectionHtml = config.noteSections
    .filter((def) => note.byId[def.id])
    .map((def) => {
      const sec = note.byId[def.id];
      let inner;
      if (def.id === 'sources') {
        inner = `<ol class="sources">\n${note.sources
          .map(
            (s, idx) =>
              `<li id="src-${idx + 1}"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><span class="src-meta">${esc(s.publisher)}，${s.date}</span></li>`
          )
          .join('\n')}\n</ol>`;
      } else {
        inner = sec.blocks.map((b) => (def.id === 'numbers' && b.type === 'table' ? renderTable(b, { numbers: true }) : renderBlock(b))).join('\n');
      }
      return `<section id="${def.id}" class="sec sec-${def.id}">\n<h2>${esc(def.title)}</h2>\n${inner}\n</section>`;
    })
    .join('\n\n');

  const toc = config.noteSections
    .filter((def) => note.byId[def.id])
    .map((def) => `<li><a href="#${def.id}">${esc(def.title)}</a></li>`)
    .join('\n          ');

  const tiles = note.tiles
    .map(
      (t) =>
        `<div class="tile"><dt>${esc(t.label)}</dt><dd><span${trendClass(t.value)}>${esc(t.value)}</span></dd><dd class="period">${esc(t.period)}</dd></div>`
    )
    .join('\n        ');

  const tags = (d.tags || []).map((t) => `<li>${esc(t)}</li>`).join('');
  const pager = [
    prev ? `<a class="prev" href="${prev.slug}.html"><span>上一篇</span>${esc(prev.data.code)} ${esc(prev.data.name)}</a>` : '<span></span>',
    next ? `<a class="next" href="${next.slug}.html"><span>下一篇</span>${esc(next.data.code)} ${esc(next.data.name)}</a>` : '<span></span>',
  ].join('\n        ');

  const body = `    <article class="note">
      <header class="note-head">
        <div class="wrap">
          <p class="crumb"><a href="../index.html">筆記總覽</a><span aria-hidden="true">／</span>${esc(d.industry)}</p>
          <div class="ticker">
            <span class="code">${esc(d.code)}</span>
            <h1>${esc(d.name)}<span class="en">${esc(d.name_en)}</span></h1>
          </div>
          <p class="lead"><mark>${esc(d.summary)}</mark></p>
          <dl class="meta">
            <div><dt>市場</dt><dd>${esc(d.market)}</dd></div>
            <div><dt>狀態</dt><dd>${esc(d.status)}</dd></div>
            <div><dt>資料期別</dt><dd>${esc(d.data_as_of)}</dd></div>
            <div><dt>最後更新</dt><dd><time datetime="${esc(d.updated)}">${esc(d.updated)}</time></dd></div>
          </dl>
          <ul class="tags" aria-label="標籤">${tags}</ul>
        </div>
      </header>
      <div class="wrap">
        <dl class="tiles" aria-label="關鍵數字摘要">
        ${tiles}
        </dl>
        <div class="note-body">
          <nav class="toc" aria-label="本頁章節">
            <p>本頁章節</p>
            <ol>
          ${toc}
            </ol>
          </nav>
          <div class="prose">
${sectionHtml}
          </div>
        </div>
        <nav class="pager" aria-label="其他筆記">
        ${pager}
        </nav>
      </div>
    </article>`;

  return layout({
    title: `${d.code} ${d.name}`,
    description: d.summary,
    base: '../',
    current: '',
    body,
  });
}

// ---------------------------------------------------------------- 首頁

function renderIndex(notes) {
  const industries = config.industries.filter((ind) => notes.some((n) => n.data.industry === ind));
  const chips = ['全部', ...industries]
    .map((ind, idx) => `<button type="button" class="chip" data-industry="${idx === 0 ? '' : esc(ind)}" aria-pressed="${idx === 0}">${esc(ind)}</button>`)
    .join('\n          ');
  const rows = notes
    .map((n) => {
      const d = n.data;
      const haystack = [d.code, d.name, d.name_en, d.industry, ...(d.tags || [])].join(' ').toLowerCase();
      return `<li data-industry="${esc(d.industry)}" data-search="${esc(haystack)}">
            <a class="row" href="notes/${n.slug}.html">
              <span class="code">${esc(d.code)}</span>
              <span class="who"><strong>${esc(d.name)}</strong><span class="en">${esc(d.name_en)}</span><span class="sum">${esc(d.summary)}</span></span>
              <span class="cell" data-label="產業">${esc(d.industry)}</span>
              <span class="cell" data-label="資料期別">${esc(d.data_as_of)}</span>
              <span class="cell" data-label="更新"><time datetime="${esc(d.updated)}">${esc(d.updated)}</time></span>
            </a>
          </li>`;
    })
    .join('\n          ');

  const body = `    <section class="hero">
      <div class="wrap">
        <h1>${esc(config.title)}</h1>
        <p class="tagline">${esc(config.tagline)}</p>
        <p class="how">每篇筆記都照同樣八個章節寫：公司在做什麼、產業位置、近期營運重點、關鍵數字、觀察與疑問、風險、追蹤清單、資料來源。數字後面的小編號可以點，會跳到出處。</p>
      </div>
    </section>
    <section class="board-sec">
      <div class="wrap">
        <div class="tools">
          <div class="chips" role="group" aria-label="依產業篩選">
          ${chips}
          </div>
          <label class="search"><span class="sr-only">搜尋代號、公司或標籤</span>
            <input type="search" id="q" placeholder="搜尋代號、公司或標籤" autocomplete="off">
          </label>
        </div>
        <p class="count" id="count" aria-live="polite">共 ${notes.length} 篇筆記</p>
        <div class="board-head" aria-hidden="true">
          <span>代號</span><span>公司</span><span>產業</span><span>資料期別</span><span>更新</span>
        </div>
        <ul class="board" id="board">
          ${rows}
        </ul>
        <p class="empty" id="empty" hidden>沒有符合的筆記。<button type="button" id="reset">清除篩選</button></p>
      </div>
    </section>`;

  return layout({
    title: '',
    description: config.description,
    base: '',
    current: 'index.html',
    body,
    scripts: '\n  <script src="assets/site.js" defer></script>',
  });
}

// ---------------------------------------------------------------- 一般頁面

function loadPage(filename) {
  const file = `content/pages/${filename}`;
  const raw = fs.readFileSync(path.join(PAGES_SRC, filename), 'utf8');
  const { data, body } = parseFrontmatter(raw, file);
  const slug = filename.replace(/\.md$/, '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(filename)) fail(file, '頁面檔名只能用英文小寫、數字和連字號');
  if (slug === 'index') fail(file, 'index 保留給首頁，請換一個檔名');
  for (const key of ['title', 'summary', 'updated']) if (!data[key]) fail(file, `frontmatter 缺少必填欄位 ${key}`);
  if (data.updated && !isDate(data.updated)) fail(file, 'updated 必須是 YYYY-MM-DD');
  const blocks = parseBlocks(body, file);
  return { file, slug, data, blocks };
}

function renderPage(page) {
  const inner = page.blocks.map((b) => (b.type === 'h2' ? `<h2>${inline(b.text)}</h2>` : renderBlock(b))).join('\n');
  const body = `    <article class="page">
      <header class="page-head">
        <div class="wrap">
          <h1>${esc(page.data.title)}</h1>
          <p class="tagline">${esc(page.data.summary)}</p>
        </div>
      </header>
      <div class="wrap">
        <div class="prose">
${inner}
          <p class="updated">最後更新 <time datetime="${esc(page.data.updated)}">${esc(page.data.updated)}</time></p>
        </div>
      </div>
    </article>`;
  return layout({ title: page.data.title, description: page.data.summary, base: '', current: `${page.slug}.html`, body });
}

// ---------------------------------------------------------------- 主流程

const notes = listMarkdown(NOTES_SRC).map(loadNote);
const pages = listMarkdown(PAGES_SRC).map(loadPage);

const codes = new Map();
for (const n of notes) {
  if (codes.has(n.data.code)) fail(n.file, `代號 ${n.data.code} 已經有筆記了（${codes.get(n.data.code)}），一家公司只能有一篇`);
  else codes.set(n.data.code, n.file);
}
for (const item of config.nav) {
  const target = item.href.replace(/\.html$/, '');
  if (target !== 'index' && !pages.some((p) => p.slug === target)) fail('site.config.json', `nav 連到 ${item.href}，但 content/pages/ 沒有對應的 ${target}.md`);
}
if (!notes.length) fail('content/notes', '至少要有一篇筆記');

for (const w of warnings) console.warn(`提醒 ${w}`);
if (errors.length) {
  console.error(`\n檢查沒過，共 ${errors.length} 個問題：`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('\n請依 AGENTS.md 修正後再執行一次。');
  process.exit(1);
}
console.log(`檢查通過：${notes.length} 篇筆記、${pages.length} 個頁面`);
if (CHECK_ONLY) process.exit(0);

// 首頁排序：最近更新的在前，同一天依代號
notes.sort((a, b) => b.data.updated.localeCompare(a.data.updated) || a.data.code.localeCompare(b.data.code));

fs.mkdirSync(NOTES_OUT, { recursive: true });
const keep = new Set(notes.map((n) => `${n.slug}.html`));
for (const f of fs.readdirSync(NOTES_OUT)) {
  if (f.endsWith('.html') && !keep.has(f)) {
    fs.unlinkSync(path.join(NOTES_OUT, f));
    console.log(`移除沒有來源的產物 notes/${f}`);
  }
}
notes.forEach((n, idx) => {
  fs.writeFileSync(path.join(NOTES_OUT, `${n.slug}.html`), renderNote(n, notes[idx - 1], notes[idx + 1]));
});
fs.writeFileSync(path.join(ROOT, 'index.html'), renderIndex(notes));
for (const p of pages) fs.writeFileSync(path.join(ROOT, `${p.slug}.html`), renderPage(p));
console.log(`已產生 index.html、${notes.length} 個 notes/*.html、${pages.map((p) => `${p.slug}.html`).join('、') || '0 個頁面'}`);
