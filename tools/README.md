# 集章測驗發布檔維護

使用 Node.js 與 pnpm，在本目錄執行 `pnpm install --frozen-lockfile --ignore-scripts` 安裝固定版本 Terser。

可編輯來源保存在本機 `.maintenance/quiz-sources/`（以網站根目錄為基準），包含兩學期測驗 HTML 與失焦處理程式。此資料夾與 `tools/node_modules/` 均不納入 Git；**請另外備份本機來源，不要放進網站部署目錄或上傳公開位置**。新下載的專案不會包含這些本機來源，維護前須先還原備份。

首次處理尚未壓縮的頁面時，可在本目錄執行 `pnpm run quiz:capture` 保留可編輯來源；已有來源或頁面已壓縮時，此動作會拒絕覆蓋。

後續更新請編輯本機來源，再執行 `pnpm run quiz:build` 產生發布版、`pnpm run quiz:check` 檢查是否一致。若直接更動發布檔，建置會拒絕覆蓋，須先將更新合併回本機來源。

此處理只壓縮內嵌 JavaScript、改名局部變數及跳脫非 ASCII 字元；不改 HTML/CSS 版型、題目與選項的實際文字、不改全域事件函式或物件屬性、不更動答案驗證模組及 Firestore Rules。不產生 source map 或公開原始碼副本。每次更新仍須驗證作答、換題、失焦與完成紀錄；建置一致性檢查不等同操作測試。

這是閱讀難度調整，不是加密。瀏覽器需要顯示的題目仍可閱讀，本處理也不會移除既有 Git 歷史中的舊版程式。
