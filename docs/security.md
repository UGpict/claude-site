# Claude Code セキュリティ設定（必ず守ること）

> 人間向けメモ。Claude Code に毎回読ませる必要はない（CLAUDE.md からは参照しない）。
> このファイルは `docs/` 配下なので Astro のビルド対象外＝サイトには公開されない。
> 設定キーの正確な仕様・最新の名称は Claude Code 公式ドキュメントで確認すること。

## `.claude/settings.json`（プロジェクト設定）

`filesystem.denyRead` は独立ブロックではなく **`sandbox` ブロック内** に書く。

```json
{
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "filesystem": {
      "denyRead": ["~/.aws/credentials", "~/.ssh"]
    }
  },
  "permissions": {
    "deny": [
      "Bash(rm -rf *)",
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(git push --force *)",
      "Bash(git reset --hard *)",
      "Bash(chmod 777 *)",
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(**/*.pem)",
      "Read(**/*.key)"
    ]
  }
}
```

> 補足：`.claude/settings.local.json` は個人用のローカル上書き（セッション中の「Always allow」が溜まる場所）。
> 上の `deny` は `allow` より優先されるため、ローカルに `Bash(git push *)` があっても
> `Bash(git push --force *)` の deny は効く（評価順は deny → ask → allow）。

## セキュリティ原則

1. **サンドボックスは「有効化」と「脱出口を塞ぐ」を両方やる**
   - `allowUnsandboxedCommands: false` を必ずセットで設定する。
   - これがないと `dangerouslyDisableSandbox` で回避されてしまう。「有効化」と「完全に塞ぐ」は別物。

2. **deny ルールで危険なコマンドを止める**
   - 評価順は deny → ask → allow。deny は最優先で、後から allow で上書きされない。
   - `git push --force` / `git reset --hard` の事故は取り返しがつかないので deny に入れる。

3. **機密ファイルは両方の経路で塞ぐ**
   - `permissions.deny` は Read ツール経由をブロック。
   - `sandbox.filesystem.denyRead` は Bash 経由（`cat ~/.ssh/id_rsa` 等）もブロック。
   - プロンプトインジェクション対策として両方設定する。

4. **ネットワークはホワイトリスト方式で制限する**
   - 業務に必要なドメイン（GitHub・npm・PyPI 等）だけ許可する。
   - 悪意あるコードが外部サーバーへデータ送信するのを防ぐ。

5. **`/permissions` で定期的に棚卸しする**
   - セッション中に「Always allow」で溜まった不要ルールを月 1 で確認する。
   - `/status` で読み込まれている設定ファイル・エラーも確認する。

## チーム開発：Managed Settings で組織ポリシーを強制

```json
{
  "permissions": {
    "disableBypassPermissionsMode": "disable"
  },
  "allowManagedPermissionRulesOnly": true,
  "allowManagedHooksOnly": true,
  "allowManagedMcpServersOnly": true
}
```

## MCP サーバーの制限

- 素性の不確かな MCP サーバーを使わせない。
- `allowManagedMcpServersOnly: true` で、管理者が承認したサーバー以外を閉じる。
- 追加で MCP を入れるときは、接続先 URL と権限を必ず確認してから許可する。

## このリポジトリの現状メモ

- `.claude/settings.json`（コミット対象・共有）に上記の sandbox / deny ポリシーを配置済み。
- `.claude/settings.local.json`（個人用・`allow` リスト）は `.gitignore` で除外済み。
- **Windows の注意**：サンドボックス本体（bwrap）は Linux / WSL 前提。ネイティブ Windows で
  実行すると `sandbox.enabled: true` は警告のうえ非サンドボックスで動く（`failIfUnavailable` 既定 false のため起動は止まらない）。
  `permissions.deny` は環境に関係なく効く。完全なサンドボックスを効かせたいなら WSL 上で使う。
- 反映確認：`/status` で読み込まれた設定ファイル、`/permissions` で deny/allow を確認する。
  反映されないときは `/hooks` を一度開くか再起動で設定を再読み込みする。
