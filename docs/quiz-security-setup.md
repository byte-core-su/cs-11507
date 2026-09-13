# 題庫安全金鑰與作答統計初始化

本系統將選擇題正解與流程排序解答保留在 Firestore 的 `quizAnswerKeys`，學生網頁只保留題幹、選項與可操作的積木。學生送出後，Firestore Security Rules 才依答案金鑰寫入不可修改的作答紀錄。

## 一次性設定

1. 在 Firebase Console 的 Firestore Rules，部署本專案的 `firestore.rules`。
2. 使用教師帳號登入系統後，開啟 `shared/quiz-key-import.html`。
3. 選取本機 `private/quiz-answer-keys.json` 並匯入。
4. 成功後保留離線備份或刪除該金鑰檔；不可推送至 GitHub 或提供給學生。

## 作答統計資料

每次送出會建立 `quizAttempts/{uid}/events/{attemptId}`，包含學期、題號、題幹、作答選項或排序、正確與否、作答秒數及時間。教師端可依題號、班級、單元與日期彙整：作答人數、首次答對率、總正確率和各選項分布。

此機制適用於教學診斷；學生仍可重複嘗試選項，因此不可直接作為正式評量成績。
