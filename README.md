# 115 學年度資訊科技學習平台

這是上下學期共用的單一系統入口。

- `index.html` 依日期自動導向 115 學年度的當期學生入口：8 月至隔年 1 月為上學期，2 月至 7 月為下學期。
- `teacher.html` 依日期開啟當期教師後台；各學期中的 `teacher.html` 只是帶入學期範圍的轉接網址，實際後台只有一份。
- `firebase-config.js` 是唯一 Firebase 設定檔；所有學期頁面均引用它。
- `shared/portal.js` 是唯一的學生登入與入口網版型；`shared/teacher.html` 是唯一的教師後台版型。
- `terms/115-1` 和 `terms/115-2` 僅放該學期教材、任務設定（`term-config.js`）與圖片。

## Firestore 資料規則

- `rosters/{studentId}`：共用名冊。
- `users/{uid}.profile`：共用學生身分。
- `users/{uid}.terms.{termId}`：該學期任務、證書與成績。
- `users/{uid}.terms.{termId}.attendance.{YYYY-MM-DD}`：學生當日登入時間；教師可依日期查詢出席。
- `users/{uid}.teacherProgress.{termId}`：該學期教師核定資料。

部署前請將根目錄的 `firestore.rules` 發佈至 Firebase，並以本目錄作為網站部署根目錄。

下一個學年度只需新增新的學期內容資料夾，並將 `firebase-config.js` 的 `academicYearId` 更新為新的學年度。

## 測試學期切換

正式入口不帶參數時，會依日期自動判定學期。測試時可在入口網址加上 `?testTerm=115-1` 或 `?testTerm=115-2`，例如 `index.html?testTerm=115-1`。測試學期會在該瀏覽器工作階段內維持，頁面左下角會顯示黃色測試標示；以 `?testTerm=auto` 開啟入口即可回到正式自動判定。

## Google Classroom 整合與測試

教師後台的「Google Classroom」分頁是上下學期共用的唯讀看板：可查詢課程、作業、每位學生的繳交狀態、遲交標示與附件連結，不會更動 Classroom 中的任何資料。

### 一次性部署設定

1. 使用 `jimwang@mail.qfm.kh.edu.tw` 建立一個 Google Apps Script 專案。
2. 將 [shared/google-classroom.gs](shared/google-classroom.gs) 的內容貼入指令碼檔，並以 [shared/google-classroom-appsscript.json](shared/google-classroom-appsscript.json) 覆蓋專案資訊清單。
3. 在 Apps Script 的「服務」啟用 **Google Classroom API**；若系統要求，也在對應 Google Cloud 專案啟用同名 API。
4. 部署為「網頁應用程式」：設定為**以存取網頁應用程式的使用者身分執行**，並將存取範圍限制為教師帳號（或校內網域後，再由程式限制為該教師）。部署後複製結尾為 `/exec` 的網址。
5. 將該網址填入 [firebase-config.js](firebase-config.js) 最後的 `LEARNING_CLASSROOM_CONFIG.endpoint`；也可在教師後台的 Classroom 分頁暫存填入。前者會成為所有瀏覽器共用的預設值，後者只儲存在目前瀏覽器。

### 功能測試

1. 以教師帳號開啟 `teacher.html?testTerm=115-1`，登入後進入「Google Classroom」。
2. 首次使用時貼上 `/exec` 網址、按「儲存連線設定」，再按「Google 授權」，在新分頁完成 Classroom 權限授權。
3. 回到後台按「更新課程」，選一門課與一份作業，確認名冊中的已繳交、未繳交、遲交與附件連結正確顯示。
4. 以 `teacher.html?testTerm=115-2` 重複第 1–3 步。兩次會使用相同 Classroom 模組，但平台內的學習進度、出席與教師核定仍只讀取各自學期的 `terms.115-1` 或 `terms.115-2` 資料。

Classroom 學生帳號會以 `qfm151xxxx@mail.qfm.kh.edu.tw` 格式對應平台學號；不符合此格式的 Classroom 成員會顯示為「未對應」，便於教師檢查名冊。
