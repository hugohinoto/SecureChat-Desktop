# SecureChat Desktop

SecureChatのオンライン機能を利用するWindows向けデスクトップクライアントです。SecureChat本体のWebアプリをElectronの分離されたウィンドウで開き、既存のAPI・認証・暗号化クライアントをそのまま使用します。

## オンライン機能

接続先のSecureChatサーバーで利用可能な機能を使用します。

- アカウント登録（招待コード）・ログイン・ログアウト・アカウント削除
- ユーザー検索、相互OTP連絡先認証、個別チャット
- Durable Objects WebSocketによるリアルタイム通信
- 既存Crypto Protocol v1互換と、双方の指紋確認・承認を前提とするMatrix Rust/WASM Olm / Megolm v2クライアント
- 端末ごとの暗号鍵・鍵配送・端末管理
- SecureDrop、運営のお知らせ、バグ報告
- ブラウザー通知（OSの通知許可が必要）

このデスクトップアプリは暗号方式やAPIを独自実装せず、接続先のSecureChat Webクライアントを使用します。暗号化の実際の状態は会話ごとの画面表示に従ってください。Crypto v2の実環境安全性はSecureChat本体側の独立監査・マルチ端末検証状況に依存します。

## 初回接続

1. SecureChat Desktopを起動します。
2. SecureChat本体が稼働しているHTTPSのルートURLを入力します。
3. 「保存して接続」を押します。
4. 既存のSecureChatアカウントでログインするか、招待コードで登録します。

接続先URLはポータブル版では portable-data/server-config.json、通常インストール版ではアプリのユーザーデータに保存されます。アプリメニューの「SecureChat → サーバー接続先を変更」から変更できます。アプリはHTTPS以外の接続先を拒否します。ローカルWorker開発用HTTP接続は SECURECHAT_ALLOW_INSECURE_DEV=1 の開発時だけ許可されます。

## データとポータブル利用

Windowsポータブル版では、実行ファイルと隣接する portable-data フォルダーを一緒に保管・移動してください。ログインCookie、IndexedDBの端末暗号鍵、Webアプリのローカル状態はElectronプロファイル内に保存されます。端末プロファイルを含むため、共有PCではフォルダーを他人に渡さないでください。

旧オフライン試作版の vault.scv が存在する場合、このオンライン版は削除しません。ただし旧ローカルキューをオンライン会話へ自動移行・送信することはありません。

## セキュリティ境界

- リモートSecureChatページにはNode.js統合・preloadブリッジを公開しません。
- HTTPSのみ許可し、メインウィンドウのナビゲーションを設定済みオリジンに制限します。
- 外部HTTPSリンクは既定ブラウザーで開きます。
- 設定画面はローカルファイルで動作し、限定されたIPCだけを使用します。
- Electronプロファイルのコピーは端末鍵の複製になります。端末の複製・失効はSecureChat側の端末管理方針に従ってください。

## 開発

Requirements: Node.js 24 or later and npm.

    npm install
    npm run build
    npm test
    npm start

ローカルCloudflare Workerを使う開発時だけ、SECURECHAT_ALLOW_INSECURE_DEV=1 と SECURECHAT_SERVER_URL=http://127.0.0.1:8787 を設定して起動できます。

## Windowsポータブル版

    npm run dist:win

ポータブル版は実行ファイルと portable-data フォルダーをセットで扱ってください。
