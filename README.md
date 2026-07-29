# 115 學年度資訊科技學習平台

這是上下學期共用的單一系統入口。

- `index.html` 依日期自動導向 115 學年度的當期學生入口：8 月至隔年 1 月為上學期，2 月至 7 月為下學期。
- `teacher.html` 依日期開啟當期教師後台；教師仍可直接使用各學期資料夾中的後台查看歷史資料。
- `firebase-config.js` 是唯一 Firebase 設定檔；所有學期頁面均引用它。
- `shared/` 放置共用登入識別與入口保護程式。
- `terms/115-1` 和 `terms/115-2` 僅放該學期教材、任務與圖片。

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
