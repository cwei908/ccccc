# 個股研究筆記

台股個股研究筆記網站。一家公司一頁，每頁都用同一套八個章節，所有數字都附來源。

- 網站：https://cwei908.github.io/ccccc/
- 規則文件：[AGENTS.md](AGENTS.md)

## 這個專案的重點

重點不在單一網頁，而在一套可以重複使用的規則：

1. **內容和版面分開**：筆記是 `content/notes/` 裡的 Markdown，版面由 `scripts/build.mjs` 統一產生。
2. **規則寫成文件**：[AGENTS.md](AGENTS.md) 說明專案目的、檔案放哪裡、怎麼命名、每個章節怎麼寫、哪些事不能做。
3. **規則可以被檢查**：建置腳本會檢查章節順序、數字有沒有來源、來源格式、有沒有投資建議用語，沒通過就不會產生網頁。

所以新增一家公司時，只需要對 AI 說「依照 AGENTS.md 新增 2454 聯發科的筆記」。

## 目前的筆記

| 代號 | 公司 | 產業 | 資料期別 |
| --- | --- | --- | --- |
| 2330 | 台積電 | 半導體 | 2026Q3 |
| 2383 | 台光電 | 電子零組件 | 2026Q3 |
| 2308 | 台達電 | 電子零組件 | 2026Q3 |
| 2454 | 聯發科 | 半導體 | 2026Q3 |

## 使用方式

需要 Node 18 以上，沒有其他相依套件。

```bash
node scripts/build.mjs --check   # 只檢查內容
node scripts/build.mjs           # 檢查並產生網頁
```

建置後用瀏覽器開 `index.html` 就能預覽。推上 GitHub 後由 GitHub Pages 直接提供（main 分支根目錄）。

### 法說會素材（選用）

有 AlphaMemo Pro 方案的話，可以把追蹤公司的法說會摘要和逐字稿抓到本機，更新筆記時當素材：

```bash
echo "ALPHAMEMO_API_KEY=amk_你的金鑰" > .env   # .env 不會進 git
node scripts/alphamemo-sync.mjs --dry-run      # 先看會讀幾場（不扣額度）
node scripts/alphamemo-sync.mjs                # 同步到 data/alphamemo/，打開 INDEX.md 看
```

素材只留在本機，不會出現在網站上。怎麼用在筆記裡見 [AGENTS.md](AGENTS.md) 第 14 節。

## 目錄

```
AGENTS.md            專案規則
site.config.json     網站設定（選單、產業清單、章節清單、禁用詞）
content/notes/       個股筆記的 Markdown 來源
content/pages/       一般頁面的 Markdown 來源
scripts/build.mjs    檢查並產生網頁
scripts/alphamemo-sync.mjs   同步法說會素材到 data/alphamemo/（本機，不進 git）
assets/              樣式與首頁篩選功能
index.html、about.html、notes/   建置產物，請勿手動修改
```

## 聲明

這裡是個人學習筆記，不構成任何投資建議。數字以公司公告與公開資訊觀測站為準。
