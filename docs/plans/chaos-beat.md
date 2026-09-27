# plan: CHAOS BEAT 実装手順

spec: [../specs/chaos-beat.md](../specs/chaos-beat.md) / design: [../design/chaos-beat.md](../design/chaos-beat.md)

チェックを1つずつ潰す。plan から外れる判断が出たら、コードより先に spec/design を直す。

## Phase 1 — コアループ（これだけで化ける）
### エンジン（chaos-pendulum.ts）
- [ ] 状態機械を `playing/slowmo/over` に作り替え、`GAME_TIME=30` の実時間カウントに変更
- [ ] `timeScale` を導入し、物理積分に掛ける（slowmo≈0.15／通常1.0／鬼1.3）
- [ ] ターゲットを `{x,y,r,type,bornAt}` 化し、`newTarget()` で1つずつ出す
- [ ] 叩く act()：距離→判定(kind)→基本点→`score += round(pts×comboMult)`→コンボ/ maxCombo 更新→slowmo→次の的
- [ ] 判定しきい値（0.35R/0.7R/R/1.25R）とラベル(kind)を実装
- [ ] 「あと Npx」用に nearMissPx を算出して payload へ
- [ ] onEvent を作り替え（game_start / hit / game_over）。round_complete 等の5R名残を削除
- [ ] 5ラウンド・「次へ」・timeout(15秒)・over時ボタン隠しなどの旧仕様を撤去
- [ ] 30秒で game_over。setDifficulty/restart は維持（restart=即リトライ）

### 描画・演出
- [ ] HUD：残り時間バー（30秒）、スコア、コンボ、倍率
- [ ] 判定ラベル（PERFECT/GREAT/GOOD/MISS/NEAR MISS）を大きくポップ表示（既存 popT 流用）
- [ ] 成功パーティクル（既存 burst 流用）を kind で強弱
- [ ] slowmo 中の視覚（軽い残像 or フラッシュ）

### 音（audio.ts）
- [ ] 判定SEを kind 別に（PERFECT 豪華／GREAT/GOOD 軽め／MISS 濁り）※ビート/レイヤーは Phase 2/3

### コンポーネント（ChaosPendulum.astro）
- [ ] HUD DOM（スコア/コンボ/タイム）と結果パネル（スコア＋最大コンボ＋即リトライ）に作り替え
- [ ] onEvent 橋渡しを hit/game_over に更新（GA4・音・自己ベスト・ランキング）
- [ ] 「1から始める」→「もう一回」（即リトライ）に。5R前提のコピー撤去
- [ ] 難易度セレクター・ランキングタブは流用

### 保存・通信・DB
- [ ] storage.ts：自己ベストを {score, maxCombo} に
- [ ] migration 0003：`max_combo` 追加。切替時に既存行 DELETE
- [ ] scores.ts：payload に maxCombo/hits、検証を新レンジに、保存に max_combo
- [ ] ranking.ts（front/back）：maxCombo を返し、並びに副キー追加。行に最大コンボ併記
- [ ] D1 マイグレーション適用（--remote）＋既存行クリア

### 仕上げ
- [ ] ゲームページのコピー（lead/how-to）を30秒・コンボ・判定に更新
- [ ] `npx astro build` 通過を確認 → コミット → プッシュ → 実機で手触り確認

## Phase 2 — 気持ちよさ
- [ ] CHAOS FEVER（PERFECT3連→速度1.3×・得点2×・演出強化・MISSで解除）
- [ ] Magnet Assist（易しい：的付近で timeScale≈0.65／普通：弱／難しい・鬼：なし）
- [ ] BPM ビートで的が脈動（audio のビートクロックと同期）

## Phase 3 — アーケード化
- [ ] コンボで曲が層を増す（drum→bass→synth→melody）
- [ ] 動く的（ステージ進行でゆっくり移動）
- [ ] ボーナス的（赤3倍／青+2秒／虹FEVER）

## あとで（別タスク）
- [ ] 制作記録記事 `chaos-pendulum-tsukutta` を作り替え後の内容に加筆（updatedDate 更新）
- [ ] タイトルを「CHAOS BEAT」にするか最終決定（表記・OGP・スラッグ）
