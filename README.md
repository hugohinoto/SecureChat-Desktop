# SecureChat Desktop

SecureChatのオンライン機能を利用するWindows向けデスクトップクライアントです。通常時はSecureChat Webクライアントをアプリに同梱したローカルRendererで表示し、HTTPS API通信をMain Processが代行します。接続できない場合は同じデザインシステムのオフライン保管庫へ切り替えます。

## v0.5.1

- Fix desktop API connectivity by routing API requests through Electron's network stack, consistent with the startup connectivity probe.

## v0.5.0

- GitHub Releasesの最新安定版を起動後・6時間ごとに確認し、更新をバックグラウンドでダウンロードします。
- GitHub Release APIが提示するSHA-256ダイジェストと照合してから更新ファイルを使用します。
- 更新は再起動時に実行し、起動確認ができなければ旧EXEへロールバックします。
- `portable-data` はEXEの差し替え対象外です。メニューから手動で更新確認もできます。

- Webサイトをリモート表示する方式から、Webクライアントをアプリに同梱してローカル表示する方式へ変更しました。
- ログイン・チャット・管理・SecureDropのAPI通信はMain ProcessがHTTPSで代行し、画面遷移やサイト表示に依存しません。
- HttpOnlyセッションCookieはRendererへ公開せず、OSの `safeStorage` で暗号化して保存します（暗号化機能が利用できない環境ではメモリ内のみ）。
- オンライン／オフライン画面は同じSecureChatデザインシステムを使用します。オフラインメッセージはローカルVault内だけに保存します。
- SecureDropの暗号化バイナリ転送と必要なヘッダーを限定許可で中継します。

- 初回起動時は本番サーバー `https://securechat.hugohinoto.workers.dev` へ自動接続します。
- ネットワーク障害・サーバー接続失敗時はアプリ内のオフライン保管庫を開きます。
- オフライン保管庫では会話とメッセージを端末内に作成・保存できます。
- 保管庫はマスターパスワードから導出した鍵でAES-256-GCM暗号化し、scryptを使用します。
- オフラインで作成したメッセージは「送信待ち」として保存され、相手には送信されません。
- メニューからオンライン接続とオフライン保管庫を切り替えられます。

## オンライン機能

接続先のSecureChatサーバーで利用可能な機能を使用します。

- アカウント登録（招待コード）・ログイン・ログアウト・アカウント削除
- ユーザー検索、相互OTP連絡先認証、個別チャット
- Durable Objects WebSocketによるリアルタイム通信
- 既存Crypto Protocol v1互換と、双方の指紋確認・承認を前提とするMatrix Rust/WASM Olm / Megolm v2クライアント
- 端末ごとの暗号鍵・鍵配送・端末管理
- SecureDrop、運営のお知らせ、バグ報告
- ブラウザー通知（OSの通知許可が必要）

このデスクトップアプリはオンライン時の暗号方式やAPIを独自実装せず、SecureChat WebクライアントのUI・暗号化ロジックを同梱して使用します。API通信はRendererから直接ネットワークへ出さず、Main Processの限定IPCを通して設定済みHTTPSオリジンに送ります。暗号化の実際の状態は会話ごとの画面表示に従ってください。

## 初回接続とオフライン動作

1. SecureChat Desktopを起動します。
2. 本番サーバーへ自動接続します。
3. サーバーへ接続できない場合は、ローカル保管庫画面へ自動的に切り替わります。
4. 初回は12文字以上のマスターパスワードで保管庫を作成し、次回以降は同じパスワードで解除します。

オフライン保管庫はオンラインアカウントとは別のローカルデータ領域です。オンラインのチャット履歴・アカウント・暗号鍵をオフライン保管庫から参照することはありません。オフライン中のメッセージは暗号化して端末に保存されますが、現バージョンではオンライン会話への自動送信・自動同期・既存チャットへの統合は行いません。送信待ち表示は相手に届いたことを意味しません。

アプリメニューの「SecureChat → オンラインに接続」から再接続できます。「オフライン保管庫を開く」でローカル保管庫へ戻れます。接続先URLは初期値としてアプリに組み込まれ、必要な場合は「サーバー接続先を変更」から変更できます。変更した接続先はポータブル版では `portable-data/server-config.json`、通常インストール版ではアプリのユーザーデータに保存されます。接続先はHTTPSのみ許可します（ローカルWorker開発用HTTP接続は `SECURECHAT_ALLOW_INSECURE_DEV=1` の開発時だけ許可）。

## データとポータブル利用

Windowsポータブル版では、実行ファイルと隣接する `portable-data` フォルダーを一緒に保管・移動してください。IndexedDBの端末暗号鍵、Webアプリのローカル状態、OS保護されたログインセッション、オフライン保管庫はこのフォルダーに保存されます。ログインセッションはOSの `safeStorage` で暗号化されるため、別PCへ移動した場合は再ログインが必要になることがあります。端末プロファイルを含むため、共有PCではフォルダーを他人に渡さないでください。

マスターパスワードを忘れるとオフライン保管庫を復号できません。保管庫ファイル `portable-data/vault.scv` はバックアップできますが、バックアップにも機密情報が含まれるため安全に保管してください。

## セキュリティ境界

- オンライン画面は同梱したローカルファイルから読み込み、リモートWebページをWebContentsで直接表示しません。
- RendererはNode.js統合を無効化し、API呼び出し専用の限定preloadブリッジだけを利用します。
- APIブリッジは `/api/` パスと設定済みHTTPSオリジンだけを許可し、メソッド・本文サイズ・SecureDrop用ヘッダーを検証します。
- HttpOnlyセッションCookieはMain Process内で保持し、OSの `safeStorage` で暗号化して保存します。RendererにはCookieやパスワードを返しません。
- ローカルRendererのCSPは外部ネットワーク接続を禁止し、API通信はMain Process経由に限定します。
- 外部HTTPSリンクは既定ブラウザーで開きます。
- ローカル保管庫はローカルファイル画面と限定IPCを使用し、IPC送信元を検証します。
- 保管庫データはAES-256-GCMで認証付き暗号化し、scryptで鍵を導出します。
- Electronプロファイルのコピーは端末鍵の複製になります。端末の複製・失効はSecureChat側の端末管理方針に従ってください。

## 自動更新

Windowsポータブル版は起動後と6時間ごとにGitHub Releasesの最新安定版を確認し、更新があればバックグラウンドで取得します。ダウンロードしたEXEはGitHub Release APIのSHA-256ダイジェストと照合し、再起動を選ぶまで現在のアプリを変更しません。再起動時は専用PowerShellヘルパーが旧EXEをバックアップして差し替え、新版が画面を正常に読み込んだことを確認できた場合だけバックアップを削除します。75秒以内に起動確認できなければ旧EXEへ戻します。

更新配信は `vX.Y.Z` タグのGitHub Releaseに `SecureChat-Desktop-X.Y.Z-portable.exe` を添付して行います。タグと `package.json` のバージョンは一致させてください。Release APIのSHA-256ダイジェストはダウンロード破損・転送中の改変検出に使いますが、GitHubアカウントやRelease自体が侵害された場合への独立した署名保証ではありません。Windows版は現状コード署名されていないため、SmartScreen警告が表示される場合があります。

## 開発

Requirements: Node.js 24 or later and npm.

    npm install
    npm run build
    npm test
    npm start

ローカルCloudflare Workerを使う開発時だけ、`SECURECHAT_ALLOW_INSECURE_DEV=1` と `SECURECHAT_SERVER_URL=http://127.0.0.1:8787` を設定して起動できます。

## Windowsポータブル版（インストール不要）

    npm run dist:win

生成物はインストーラーではなく、単体起動できる x64 のポータブル EXE（`SecureChat-Desktop-0.5.1-portable.exe`）です。Node.js、npm、Electron、追加ランタイムを利用者側でインストールする必要はありません。Chromium / ElectronランタイムはEXEに含まれます。EXEをダブルクリックすると一時フォルダーへ展開して起動し、Windowsへのインストール、スタートメニュー登録、レジストリ登録、管理者権限は要求しません。

初回起動後は、同じ場所に `portable-data` フォルダーが自動作成されます。別のPCへ移動するときはEXEと `portable-data` フォルダーを一緒にコピーしてください。EXE単体でも起動できますが、`portable-data` を移動しない場合は接続先設定・ログイン状態・ローカル保管庫が引き継がれません。
