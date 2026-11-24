# サントラベル 公式サイト：作業ルール

## 作業を始める前に【必ず守る】

しおりメーカー・HP・申込フォーム・予約管理シート（Code.gs）は、複数のチャットで作業している。作業を始める前に、Googleドライブの引き継ぎメモを読むこと。作業が終わったら、メモの「変更の記録」に1行追記すること。

- 引き継ぎメモ：「サントラベルHP バックアップ」フォルダの「サントラベル 引き継ぎメモ（しおり・HP・申込フォーム）」
  https://docs.google.com/document/d/1PkawI3Mhj22327E01R0Gkl9Q6-7IPX3UJqokcWlEhxE/edit
- 手元や過去の会話にあるファイルを直さず、必ず最新を取り直してから直す（しおり＝ドライブ「Shiorimaker-pro」、HP・Code.gs＝GitHub main、申込フォーム＝サーバーの /form/）。

## Apps Script（gas/Code.gs）を変更したとき【必ず守る】

`gas/Code.gs` や `gas/appsscript.json` を変更したら、作業の報告の最後に、毎回かならず次の注意をユーザーに伝えること（ユーザーから「毎回注意してほしい」と依頼されている）。

> ⚠️ Apps Script の更新をお願いします
> 1. スプレッドシートの［拡張機能］→［Apps Script］に、新しい Code.gs の内容を貼り付けて保存
> 2. ［デプロイ］→［デプロイを管理］→ 鉛筆アイコン（編集）→ バージョンを「新バージョン」にして［デプロイ］
>
> ［新しいデプロイ］は使わないでください。URLが変わり、サイト（tours.html の API_URL）が予約管理シートとつながらなくなります。

- 現在のウェブアプリURL（tours.html の `API_URL`）：
  `https://script.google.com/macros/s/AKfycbxcpd82ognNzyklT20gCCV5_sZUXZyvTCwtfAH76W85fQAKpEybJjwDyOk6QcJYUndt/exec`
- URLが変わってしまった場合は、新しいURLを `tours.html` の `var API_URL=` に設定してコミットする。

## そのほか
- 変更を GitHub（main）に反映したら、Google ドライブ「サントラベルHP バックアップ」フォルダにもバックアップを追加する。
- 予約管理スプレッドシート：https://docs.google.com/spreadsheets/d/1opgavHwsUVodk8ZRxuyhmRoIiqAi6eUzfZUDe_j2Cxs/edit
- コミットの作者は `Sun Travel <noreply@suntravel.jp>`。
