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
- `users/{uid}.terms.{termId}.usage`：本學期有效使用秒數與每次上課紀錄。登入會建立紀錄；頁面可見時每 2 分鐘累積，離開或關閉頁面則以最後活動時間結束該次紀錄。
- `users/{uid}.teacherProgress.{termId}`：該學期教師核定資料。
- `users/{uid}.teacherProgress.{termId}.taskCompletions`：運算思維與程式設計由教師檢核 Classroom 附件後，依指定單元寫入的完成紀錄；學生入口只能讀取，不能自行勾選或修改。
- `users/{uid}.teacherProgress.{termId}.taskHistory`：每次附件檢核的歷史事件，供教師端依週回看 32 項任務的成長曲線。

部署前請將根目錄的 `firestore.rules` 發佈至 Firebase，並以本目錄作為網站部署根目錄。

下一個學年度只需新增新的學期內容資料夾，並將 `firebase-config.js` 的 `academicYearId` 更新為新的學年度。

## 測試學期切換

正式入口不帶參數時，會依日期自動判定學期。測試時可在入口網址加上 `?testTerm=115-1` 或 `?testTerm=115-2`，例如 `index.html?testTerm=115-1`。測試學期會在該瀏覽器工作階段內維持，頁面左下角會顯示黃色測試標示；以 `?testTerm=auto` 開啟入口即可回到正式自動判定。

## Google Classroom 整合與測試

教師後台的「Google Classroom」分頁是上下學期共用的唯讀看板：可查詢課程、作業、每位學生的繳交狀態、遲交標示與附件連結，不會更動 Classroom 中的任何資料。系統已內建 Classroom Web App 連線網址，不需要再次輸入。

### 直接測試

1. 以教師帳號開啟 `teacher.html?testTerm=115-1` 或 `teacher.html?testTerm=115-2`，登入後進入「Google Classroom」。
2. 按「Google 授權」，完成授權後回到教師後台。
3. 按「更新課程」，選擇課程與作業，確認繳交狀態與附件連結是否顯示。

Classroom 學生帳號會以 `qfm151xxxx@mail.qfm.kh.edu.tw` 格式對應平台學號；不符合此格式的 Classroom 成員會顯示為「未對應」，便於教師檢查名冊。
