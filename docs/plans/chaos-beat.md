# plan: CHAOS BEAT 実装手順

spec: [../specs/chaos-beat.md](../specs/chaos-beat.md) / design: [../design/chaos-beat.md](../design/chaos-beat.md)

チェックを1つずつ潰す。plan から外れる判断が出たら、コードより先に spec/design を直す。

## Phase 1 — コアループ（これだけで化ける）

> ✅ 2026-09-27 実装・デプロイ済み（下記チェック項目は概ね完了）。手触りは実機で検証中。
> 音は判定SEのみ（ビート音は Phase 2）。BPM脈動は視覚のみ実装。
### エンジン（chaos-pendulum.ts）
- [ ] 状態機械を `playing/slowmo/over` に作り替え、`GAME_TIME=30` の実時間カウントに変更
- [ ] `timeScale` を導入し、物理積分に掛ける（slowmo≈0.15／通常1.0／鬼1.3）
- [ ] ターゲットを `{x,y,r,bornAt}` 化し、`newTarget()` で1つずつ出す
- [ ] **ターゲット寿命 TTL=3秒**：超過で MISS（コンボ切断・0点）→即次
- [ ] **入力ロック**：act() 先頭で `if (state !== 'playing') return;`
- [ ] 叩く act()：距離→判定(kind)→**GOOD以上なら combo+1→倍率再計算→`score += round(pts×mult)`**（NEAR/MISS は0点・combo=0）→ maxCombo 更新 →slowmo→次の的
- [ ] 判定しきい値（0.35R/0.7R/R/1.25R、超or寿命切れ=miss）とラベル(kind)を実装
- [ ] **BPM脈動（視覚）**：BPM=130 で描画時に的半径を脈動（判定距離は素のR）
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

## Phase 2 — 気持ちよさ ✅ 2026-09-27 実装・デプロイ済み
- [x] CHAOS FEVER（PERFECT3連→速度1.3×・得点2×・縁の明滅＋FEVER表示・MISS/NEARで解除）
- [x] Magnet Assist（easy assist=0.6／normal=0.82／hard・oni=なし。的付近90pxでスロー）
- [x] BPM 拍の音（engine が `beat` イベントを emit → audio.beat。4拍ごとにアクセント）。的の視覚脈動は Phase 1 済み

## Phase 3 — アーケード化
- [ ] コンボで曲が層を増す（drum→bass→synth→melody）
- [ ] 動く的（ステージ進行でゆっくり移動）
- [ ] ボーナス的（赤3倍／青+2秒／虹FEVER）

## 外部レビュー反映（2026-09-27）
- [x] ① ターゲット到達時刻を **BPM に量子化**（次の拍＋1〜3拍先の軌道点に配置）＝リズム×カオス化
- [x] ② 結果送信の **difficulty 固定バグ修正**（lastResult に難易度を保存し、それで送信）
- [x] ③ リトライを結果画面の**主CTA**に（大ボタン＋スペース/Enterで即リトライ）。ランキング登録は副導線
- [x] ④ **NEAR MISS と MISS を分離**（near=「◯秒早い/遅い！」、miss=「MISS」のみ）
- [x] ⑤ PERFECT–GOOD の**点差拡大**（PERFECT90-100/GREAT70-90/GOOD40-70、内部100点は維持）
- [x] ⑥ **コンボ節目演出**（3/5/10で「×倍率!」ポップ＋「あと1回で×N」ヒント）
- [x] ⑦ **「◯秒早い/遅い」**（軌道予測±0.45秒で最接近時刻を探索）
- [ ] ⑧ 曲レイヤー（0→kick / 3→bass / 5→hihat / 10→melody / FEVER→lead、MISSで層が剥がれる）※次回
- [ ] ⑨ FEVER 超強化（虹的・軌跡2倍・微シェイク・背景フラッシュ・巨大×2表示）※次回

## あとで（別タスク）
- [ ] 制作記録記事 `chaos-pendulum-tsukutta` を作り替え後の内容に加筆（updatedDate 更新）
- [ ] タイトルを「CHAOS BEAT」にするか最終決定（表記・OGP・スラッグ）
