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
- `users/{uid}.activeSession`：目前有效的跨裝置學生登入識別；新裝置登入時會更新此資料。
- 學生登入僅保留在目前瀏覽器頁籤的工作階段；關閉頁籤後重新開啟入口網，必須再次輸入驗證碼。
- `users/{uid}.teacherProgress.{termId}`：該學期教師核定資料。
- `users/{uid}.teacherProgress.{termId}.taskCompletions`：運算思維與程式設計由教師檢核 Classroom 附件後，依指定單元寫入的完成紀錄；`completedAt` 使用附件上傳日期，`reviewedAt` 保留教師核定日期。學生入口只能讀取，不能自行勾選或修改。
- `users/{uid}.teacherProgress.{termId}.taskHistory`：每次附件檢核的歷史事件，供教師端依週回看 32 項任務的成長曲線；曲線以 `completedAt`（附件上傳日期）計算。
- `teacherSettings/notionSync`：教師限定的班級／任務／Classroom 作業對照；學生無法讀取或改寫。
- `quizAnswerKeys/{questionId}`：教師專用的題目答案金鑰。正確選項與流程排序解答不放在學生端網頁，避免從網頁原始碼直接取得答案。
- `quizAttempts/{uid}/events/{attemptId}`：學生每次作答的不可修改紀錄。Firestore Rules 會依私密答案金鑰判定正誤，供教師端的「題目作答分析」查看作答人數、首次答對率、答對率、選項分布與平均作答時間。

部署前請將根目錄的 `firestore.rules` 發佈至 Firebase，並以本目錄作為網站部署根目錄。首次啟用題目保護時，教師也要登入 `shared/quiz-key-import.html`，匯入本機保管的私密題庫金鑰檔；該檔案不可推送至 GitHub。

下一個學年度只需新增新的學期內容資料夾，並將 `firebase-config.js` 的 `academicYearId` 更新為新的學年度。

## 正式評量提醒

本系統目前仍存在登入驗證風險，適合作為教材、上課進度與教師輔助檢核使用；不建議將平台自動記錄或顯示的結果直接作為正式評量成績。題目保護可避免由網頁原始碼直接取得正解，但作答分析仍應作為教學診斷使用；正式成績應由教師依作業、測驗與人工覆核結果判定。

## 學生登入與重複登入限制

- **同一瀏覽器**：同一時間只能使用一個學號；同學號可開啟多個課程分頁。若改以不同學號登入，系統會提示先關閉原學生的所有課程分頁。
- **不同裝置或瀏覽器**：同一學號在新裝置登入後，原裝置會在連線時收到登入識別更新，自動回到入口並顯示「此帳號已在其他裝置登入」。離線中的原裝置會在恢復連線後退出。
- **個人暫存資料**：流程圖、Scratch 解鎖與補充單元開啟紀錄會依學生分開儲存，不會因同一台電腦曾使用其他學號而混用。

## Google Classroom 整合

教師後台的「Google Classroom」分頁是上下學期共用的唯讀看板：可查詢課程、作業、每位學生的繳交狀態、遲交標示與附件連結，不會更動 Classroom 中的任何資料。系統已內建 Classroom Web App 連線網址，不需要再次輸入。

### 使用方式

1. 以教師帳號開啟正式教師入口 `teacher.html`，登入後進入「Google Classroom」。
2. 按「Google 授權」，完成授權後回到教師後台。
3. 按「更新課程」，選擇課程與作業，確認繳交狀態與附件連結是否顯示。

Classroom 學生帳號會以 `qfm15xxxxx@mail.qfm.kh.edu.tw` 格式對應平台學號；不符合此格式的 Classroom 成員會顯示為「未對應」，便於教師檢查名冊。

## Notion 學習作品整理

教師端的「Notion 整理」會依作業檢核班級，保存 8 項運算思維與 8 項程式設計的 Classroom 作業對照，並可下載學生名冊與 16 項作品索引 CSV。完成目標工作區的 Connection 與 Apps Script 指令碼屬性設定後，也能將指定任務直接建立或更新為 Notion 作品卡；連線金鑰不會存入網站或 Firebase。學生身分一律由系統名冊帶入，教師核定狀態與附件上傳時間會保留在作品索引中。Notion 建議以學生名冊與學習作品兩個資料庫呈現，完整欄位與操作方式見 [Notion 學習作品整理](docs/notion-learning-archive.md)。
