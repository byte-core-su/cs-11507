# Notion 學習作品整理

教師端的「Notion 整理」頁面以系統名冊為唯一學生來源，並將每一位學生的 8 個「運算思維」與 8 個「程式設計」任務整理為 16 筆作品索引。這樣補交、重新檢核或更換 Classroom 作業時，不會因為移動頁面而遺失學生對應關係。

## 教師端操作

1. 在「作業檢核」選擇班級；「Notion 整理」會自動跟隨該班級。
2. 按「讀取本班 Classroom 作業」。系統會依課程名稱中的班級代號找出對應課程。
3. 為 16 個任務分別指定 Classroom 作業，按「儲存本班任務對照」。每個班級可有不同作業連結，之後可隨時改寫。
4. 下載兩種 CSV：
   - **學生名冊 CSV**：每位學生一列，可匯入 Notion 的學生資料庫。
   - **作品索引 CSV**：每位學生 × 16 個任務一列，包含作品類別、任務名稱、對應作業、上傳時間與教師核定狀態。

作品是否完成仍以教師端核定紀錄為準；學生自行上傳附件只會成為待檢核的證據，不會直接變成通關紀錄。

## 建議 Notion 結構

不要建立大量深層資料夾。建立兩個資料庫後，用關聯、篩選與群組呈現「類別 → 班級 → 學生 → 作品」：

### 1. 學生名冊

| 欄位 | 類型 |
| --- | --- |
| 姓名 | 標題 |
| 學號 | 文字 |
| 班級 | 選項 |
| 座號 | 數字 |
| 同步鍵 | 文字 |

匯入「學生名冊 CSV」時，將 CSV 的「姓名」指定為標題欄位。

### 2. 學習作品

| 欄位 | 類型 |
| --- | --- |
| 名稱 | 標題 |
| 學生 | 關聯至「學生名冊」 |
| 學期 | 選項 |
| 班級 | 選項 |
| 座號 | 數字 |
| 學號 | 文字 |
| 類別 | 選項 |
| 任務鍵 | 文字 |
| 任務名稱 | 文字 |
| Classroom 作業 | 文字 |
| 教師狀態 | 選項 |
| 作品上傳時間 | 日期 |
| 教師核定時間 | 日期 |
| 作品連結 | 網址 |
| 作品附件 | 檔案與媒體 |
| 同步鍵 | 文字 |

「同步鍵」由系統使用，請保留為文字欄位但不必在作品牆卡片顯示。同步時，系統以它尋找既有學生與作品，因此重新同步只會更新同一張卡，不會重複建立。作品附件只會存放 Google Classroom 的 HTTPS 外部連結；檔案權限仍由 Google Drive／Classroom 原始設定控制。

匯入「作品索引 CSV」後，將「學生」欄位逐步關聯到學生名冊。資料庫可建立兩個檢視：

- **運算思維**：篩選「類別＝運算思維」，依班級、學生群組；每一頁可放該生的通關截圖連結。
- **程式設計**：篩選「類別＝程式設計」，依班級、學生群組；每一頁可放該生的成果影片連結。

## 啟用前置設定

「任務對照」儲存在 Firestore 的教師限定設定中，因此先部署本專案的最新版 `firestore.rules`。學生無法讀取或改寫這份設定。

目前 CSV 匯入可立即使用。若要做成按下教師端按鈕後直接建立／更新 Notion 作品頁，請依下列方式設定。

### Apps Script 的安全連線設定

1. 以目標 Notion 工作區的擁有者身分，在 Notion `Settings → Connections` 開啟 Developer Mode，建立一個內部 Connection。它需要 **Read content、Insert content、Update content** 三項內容權限。
2. 在「學生名冊」與「學習作品」資料庫右上 `••• → Connections`，各自加入這個 Connection；兩個資料庫都必須加入。
3. 取得兩個資料庫的 **Data source ID**：資料庫設定 `Manage data sources` 中，對資料來源按 `••• → Copy data source ID`。請使用 Data source ID，不是網頁網址或一般 database ID。
4. 開啟本專案的 Apps Script，選擇 `Project Settings → Script properties`，新增下列三項。值只能直接貼在這裡，**不可放進本網站、Firebase、GitHub 或聊天訊息**：

| 指令碼屬性 | 值 |
| --- | --- |
| `NOTION_API_TOKEN` | 此 Connection 的 internal token |
| `NOTION_STUDENTS_DATA_SOURCE_ID` | 「學生名冊」Data source ID |
| `NOTION_WORKS_DATA_SOURCE_ID` | 「學習作品」Data source ID |

5. 在 Apps Script 內貼上最新版 `shared/google-classroom.gs`，重新部署 Web App。維持原本設定：以存取網頁應用程式的使用者身分執行，且只限校內網域。
6. 回到教師端「Notion 整理」。當畫面顯示「Notion 連線已完成」後，先設定並儲存本班任務與 Classroom 作業對照，再選擇一項任務按「同步指定任務到 Notion」。

每次同步會處理該班所有學生：先建立或更新學生名冊資料，再建立或更新該任務的作品卡。作品狀態以教師核定紀錄為準；PNG 僅寫入運算思維任務，MP4 僅寫入程式設計任務。Notion 的連線金鑰只由 Apps Script 在伺服端讀取。Notion 對資料庫頁面的建立、更新與內容區塊分別採用資料來源與頁面 API；這也是保留結構化作品索引的原因。[Notion connection capabilities](https://developers.notion.com/reference/capabilities)、[Query a data source](https://developers.notion.com/reference/query-a-data-source) 與 [Create a page](https://developers.notion.com/reference/post-page) 可作為設定依據。
