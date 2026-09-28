## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)

## CHAOS BEAT（`/games/chaos-pendulum/`）のルール

- **ランキング（D1 `chaos_pendulum_scores`）は初期化・削除しない。** 他の人が遊んでいるため、DELETE・テーブル再作成・リセット用 migration は行わない（2026-09-28 オーナー決定）。
- 仕様・設計・計画は `docs/specs|design|plans/chaos-beat.md`。変更前に読むこと。
