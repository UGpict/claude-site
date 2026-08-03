# Claude をはじめる

Anthropic の AI「Claude」を、これから使ってみたい人・使いはじめたばかりの人に向けて
やさしく解説するブログです。[Astro](https://astro.build) で構築しています。

## コンテンツ

`src/content/blog/` に記事（Markdown）が入っています。

1. **Claude とは何か** (`claude-toha-nanika.md`) — 入門。モデルの種類と使える場所
2. **Claude Code の使い方** (`claude-code-tsukaikata.md`) — ターミナルで動く AI エージェント
3. **実例：KangaL を作った話** (`kangal-kaihatsu-jirei.md`) — AI との開発事例
4. **初心者がゼロから作った方法** (`shoshinsha-hitokara-tsukutta.md`) — 制作記録

## 開発

```sh
npm install       # 依存関係のインストール
npm run dev       # 開発サーバー（http://localhost:4321）
npm run build     # 本番ビルド（dist/ に出力）
npm run preview   # ビルド結果をローカルで確認
```

## 記事の追加

`src/content/blog/` に `.md` / `.mdx` ファイルを追加します。フロントマターは以下の形式：

```yaml
---
title: '記事タイトル'
description: '一覧・OGP に表示される説明'
pubDate: 'Aug 03 2026'
heroImage: '../../assets/blog-placeholder-1.jpg'
---
```

## ライセンス / クレジット

Astro 公式のブログスターターをベースにしています。
