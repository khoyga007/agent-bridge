# agent-bridge — KẾ HOẠCH (design frozen, chờ Yang "go" mới code)

> Trạng thái: **HOLD**. Toàn bộ dưới đây đã thiết kế + 3 agent (Claire/Celina/Ariel) đồng thuận qua bridge 2026-06-16. CHƯA code dòng nào. Chỉ thực thi khi Yang ra lệnh.
>
> Vai: **Claire** lead/plan/review/merge · **Celina** core dev (code lõi) · **Ariel** QA + brute-force/khối lượng lớn. Code lõi server.js = Claire+Celina; Ariel QA/test. server.js SHARED — Celina gửi diff về thread, Claire review trước merge.

---

## P5 — AUTO-PRUNE / ROTATE (thread `p5-prune` / `p5-rotate`)

> ✅ **PHA 1 DONE & MERGED 2026-06-16** — server.js v0.4.0. Rotate-only (no-delete) + cursor {gen,offset,last_id} + cross-gen inbox + global lock + token-save (inbox limit default 20 / has_more / unread_remaining / compact fmt) + Windows EPERM/EACCES lock fix. Tests: test-p5-rotate.js ALL PASS. Pha 2 (prune-delete) vẫn HOLD chờ Yang policy.

**Vấn đề**: `/loop` poll lâu dài → `messages.jsonl` + `receipts.jsonl` phình vô hạn. Cursor là byte-offset tuyệt đối (P1) → cắt/đè in-place làm offset lệch, agent đọc loạn.

**Quyết định**:
- ❌ LOẠI compact in-place + time-delete active record — read không lock, truncate giữa readSync = crash/offset sai.
- ✅ CHỌN **generation-rotate**, không mutate in-place.

**Thiết kế MVP (rotate-only, no-delete)**:
1. Active = `messages.jsonl`; `current_gen` lưu trong `state.json`.
2. Rotate khi size > MAX → rename `messages.<gen>.jsonl` (immutable), tạo `messages.jsonl` rỗng, `current_gen++`.
3. Cursor nâng cấp: `cursor.<agent>.json = {gen, offset, last_id}`. **Backward-compat**: cursor số trần → coi `{gen:0, offset:N}`.
4. `inbox` đọc xuyên gen: từ `{gen,offset}` → EOF gen đó; nếu `gen < current_gen` hết file thì nhảy `gen+1` offset 0; lặp tới current. Vẫn chỉ tiêu thụ tới dòng `\n` hoàn chỉnh cuối.
5. Receipts: `receipts.<gen>.jsonl` rotate đồng nhịp messages, prune cùng gen. Pha 1 KHÔNG giữ receipt mồ côi.
6. Lock: rotate lấy **GLOBAL `bridge.lock`** (ngắn) chặn append + read-state lúc rename. Append thường giữ lock per-file như cũ. Cursor ghi atomic temp+rename. Parse lỗi → prune ABORT (không best-effort xoá).
7. **Trigger MAX**: 5000 dòng HOẶC 5MB (cái tới trước). Test mode: MAX = 50 dòng / 10KB để ép rotate. Lưu ý receipts phình ~3× (3 agent).

**★ TOKEN-SAVE (Yang lệnh 2026-06-16, gộp cùng patch inbox):** chống "đọc inbox dội nguyên đống".
- 3 ca dội: (1) đọc lại rỗng = P1 cursor đã lo · (2) rotate reset offset=0 dội lại = {gen,offset} fix · (3) backlog lớn dội 1 phát = THÊM `limit`/`has_more`.
- `inbox({limit?})`: trả tối đa `limit` tin cũ nhất chưa đọc, đẩy cursor ĐÚNG số đã trả, output kèm `has_more` + `unread_remaining`. **DEFAULT limit=20** kể cả không truyền (naive inbox() không bao giờ dội). `limit:0`=unlimited (cửa thủ công). Agent has_more=true thì tự lặp (convention Agent Bus max_items≤20).
- setOffset partial phải đi qua cross-gen logic (cắt giữa gen → offset đúng byte; trúng ranh gen → {gen,offset} đúng chỗ).
- compact fmt: bỏ field rỗng (reply_to:null không in), timestamp rút gọn. `all/since` vẫn full-dump nhưng nhận `limit` nếu truyền.

**Pha 2 — ✅ DONE & MERGED 2026-06-16 (Yang chốt policy: "an toàn + cửa thoát"). Test-p5-prune 6 ca + run-tests 8 bộ XANH.**
> Follow-up (non-block): prune có thể xoá record `task` của task CÒN MỞ vắt nhiều gen → task mất khỏi reducer. Hiếm (task mở >max_lines) + fail-safe (result reject). Fix sau: trước khi xoá gen G, scan task_id còn open/claimed trong G → hạ minGen về G (giữ gen).

Policy + design:

Quy tắc prune-DELETE:
1. `minGen = min(cursor.<agent>.gen)` qua MỌI agent có cursor. Xoá `messages.<G>.jsonl` + `receipts.<G>.jsonl` với mọi `G < minGen`. → cả 3 đã đọc qua G mới xoá = zero mất unread.
2. KHÔNG bao giờ xoá `current_gen` (active) hay gen ≥ minGen.
3. Cursor số trần / agent chưa đọc → coi `gen:0` → minGen=0 → không xoá gì (an toàn mặc định).
4. **Cửa thoát `max_backlog`** (config trong state.json, MẶC ĐỊNH 0=TẮT): nếu >0, agent có `cursor.gen ≤ current_gen - max_backlog` coi như CHẾT → loại khỏi phép tính minGen → prune chạy bỏ qua nó (hi sinh unread của agent chết). Bật thủ công khi 1 agent thật sự bỏ đi.
5. Lock: prune giữ GLOBAL `bridge.lock` (như rotate), atomic. Parse lỗi bất kỳ cursor/state → ABORT toàn bộ, KHÔNG best-effort xoá.
6. Trigger: chạy prune ngay SAU rotate (cùng critical section nếu được) + expose tool `prune` thủ công.

**Task khi go**:
- Celina (core): rotate + state.json + cursor `{gen,offset,last_id}` + cross-gen inbox + global lock trong server.js → gửi DIFF về thread.
- Ariel (QA): stress test — append đồng thời 2 process, ép size vượt MAX trigger rotate giữa /loop tick, agent offline rồi rotate xong mới đọc (không mất unread), đọc trúng lúc rotate (không crash dòng dở), cày volume cho rotate nổ nhiều lần.
- Claire: chốt schema state.json+cursor, review diff, lo migration gen0, merge.

---

## TASK-CLAIM — hàng đợi task phân tán (thread `task-claim`)

> ✅ **DONE & MERGED 2026-06-16** — task-reducer.js (pure/clockless/log-order) + server.js 5 tool (task/claim/renew/result/requeue). OCC fencing reread+append atomic dưới GLOBAL_LOCK; lease default 1800s; result idempotent replay; requeue chặn lease còn sống 2 lớp. Tests: test-task-claim.js ALL PASS. Cần RESTART agent để nạp tool. Follow-up (low): toolTask verify-after-append (non-strict appendTo có thể silent-drop khi contention >1s). DOC: requeue lease-check = append-time guard, KHÔNG reducer-derived (reducer clockless).

**Vấn đề**: phân phối task cho 3 agent qua append-only log, KHÔNG broker trung tâm, agent **turn-based** (sống khi chạy turn, biến mất bất kỳ lúc nào). Nguy cơ: double-claim, lost task, crash giữa chừng, claim race (read không lock).

**★ Kết quả cốt lõi**: EXACTLY-ONCE tuyệt đối với side-effect tuỳ ý = **BẤT KHẢ** (Two Generals/FLP). Mục tiêu spec = **EFFECTIVELY-ONCE** dưới hợp đồng task idempotent.

**Thiết kế chốt**:
1. **Arbitration = LOG ORDER, KHÔNG wall-clock ts** (clock skew/collision). Append atomic (P2 lock) = total order → claim hợp lệ SỚM NHẤT theo offset/id thắng, tie-break record id.
2. **Records**:
   - `task{task_id, epoch, spec_hash}`
   - `claim{task_id, epoch, agent, nonce, lease_seconds}`
   - `renew{task_id, epoch, agent}`
   - `result{task_id, epoch, agent, result_hash, side_effect_keys[]}`
   - `requeue{task_id, from_epoch, to_epoch, reason}`
3. **Fencing/OCC**: trước side-effect VÀ trước ghi result, agent reread log — chỉ tiếp nếu claim mình vẫn winner + chưa có requeue epoch mới hơn. Sai → abort. Result epoch cũ bị reducer ignore.
4. **Lease**: claimant tự khai `lease_seconds` trong claim; DEFAULT 1800s/30m (an toàn cho turn-based im lâu). Task dài → append `renew` trước hết hạn. Quá hạn không result → ai cũng append `requeue epoch+1`.
5. **Idempotency**: mọi side-effect có `idempotency_key = task_id+epoch` hoặc output path ổn định. Non-idempotent/destructive → cờ `requires_human_orchestrator`, KHÔNG eligible distributed claim (Yang cầm tay).
6. **Leaderless**: requeue/expire = append record, deterministic reducer quyết state. Claire chỉ post+review, KHÔNG broker (Claire có thể offline).

**Task khi go**: (chưa chia chi tiết — phụ thuộc P5 xong trước hay không; bàn lại lúc Yang bật)

---

## PRODUCTION — local-first distribution (thread `prod`)

**Scope (Yang chốt)**: người ngoài TẢI VỀ, set-up LOCAL với agent họ ĐANG CÓ (bộ bất kỳ), tối giản/dễ/hiệu quả. 1 máy, 1 user, agent của chính mình.

**NON-GOALS (ghi rõ để khỏi over-build)**: network/daemon, auth token, E2EE, multi-tenant, scale nhiều user, internet-facing. Local-first = explicit "non-production-internet". (Adapter network/HTTP/WS, identity/HMAC, SQLite — ghi nhận cho tương lai xa, KHÔNG vào MVP.)

**Giữ**: 0-dep (điểm mạnh — không bắt cài gì) + shared-file transport local.

**DELIVERABLE #1 — SKILL (skill-first, agent tự cài)**:

Đóng gói thành SKILL: agent TỰ là installer. Người dùng quăng folder cho agent → gõ `/install` → agent đọc SKILL.md, tự dò client, hỏi tên, sửa config, verify. Bỏ phần khó nhất của setup.js (tự viết TOML parser 0-dep, auto-detect path) — agent dùng file-tools + phán đoán. Skill chỉ MÔ TẢ quy trình.

- **Bundle**: `server.js` (bridge 0-dep) + `SKILL.md` (instructions agent chạy) + `INSTALL.md` (bản tay universal cho agent không có 'skill': Codex/AGENTS.md, Antigravity) + `README.md` + `PLAN.md` (nâng cấp).
- **SKILL.md frontmatter**: `name: agent-bridge-installer`, description nêu rõ "local single-user install, use when user asks install/connect local agents".
- **QUY TRÌNH BẮT BUỘC mọi client**: READ config → PLAN/DIFF user xem → BACKUP timestamped → WRITE → VALIDATE syntax ngay → ROLLBACK từ backup nếu lỗi → DOCTOR roundtrip.
- **SAFETY RULES (chống agent làm bậy)**:
  1. BACKUP FIRST qua terminal (`cp config config.bak.<ts>`) TRƯỚC khi đụng file-tool.
  2. SHOW DIFF + chờ user OK trước khi ghi (trừ khi user cho phép cài luôn).
  3. IDEMPOTENT: update block có sẵn, không nhân đôi; không đụng key khác.
  4. POST-WRITE VALIDATION ngay (`node -e "require('<config>')"` / TOML parse). Lỗi → RESTORE backup LẬP TỨC.
  5. ANTI-HALLUCINATION: không thấy config → DỪNG, in manual snippet. CẤM bịa path / tạo file dummy / đoán mò.
  6. Address validate `[a-z0-9_-]{1,32}`, reject `all/system/server`.
  7. Path absolute + forward-slash trong JSON/TOML.
  8. Chỗ không parse/bound an toàn → manual snippet, không auto-sửa.
- **INPUTS hỏi user**: client nào kết nối · address mỗi agent · store dir (default `~/.agent-bridge`).
- **STEPS**: locate bundle+server.js → check node>=18 → resolve store per-OS → detect config → mỗi client: read → entry `{command:node, args:[server.js abs, --self addr, --store dir]}` → diff → backup → write → update agents.json → doctor → báo files đổi + restart.
- **UNINSTALL**: gỡ đúng managed block, giữ store trừ khi user `--purge`.

**DELIVERABLE #2 (fallback optional) — setup.js** (`node setup.js`, hoặc npx nếu publish) cho ai cài KHÔNG qua agent:
   - Auto-detect client: Claude `~/.claude.json` · Codex `~/.codex/config.toml` · Antigravity/Cursor theo OS. Không chắc → in hướng dẫn tay, KHÔNG ghi bừa.
   - Inject: JSON qua JSON.parse/stringify; TOML/non-JSON qua **managed-block markers** `# BEGIN/END agent-bridge managed` + bounded replace.
   - **BACKUP bắt buộc** trước khi ghi: `<config>.agent-bridge.bak.<ts>`. **IDEMPOTENT** (chạy lại update đúng block, không nhân đôi). **DRY-RUN** in diff trước khi áp.
2. **Agent-agnostic**: bỏ hardcode claire/celina/ariel. `--self <addr>` giữ làm runtime; setup sinh entry theo tên user chọn. Validate slug `[a-z0-9_-]{1,32}`, reserved `all/system/server`. Registry `agents.json {address,label,client,created_at}`; broadcast `all` theo registry, fallback peers-seen.
3. **Portable**: store per-OS — Win `%USERPROFILE%\.agent-bridge`, mac/Linux `$HOME/.agent-bridge`. server.js path resolve RELATIVE script dir, KHÔNG hardcode `C:\Users`. node không trong PATH → báo rõ. Store: `messages.jsonl, receipts.jsonl, state.json, agents.json, cursors/, locks/`.
4. **doctor** (healthcheck): node>=18? · store read/write? · server.js tồn tại? · parse config + bridge entry valid? · path absolute + forward-slash đúng? · address trùng? · lock stale? · spawn server dry-call `peers`/`inbox` roundtrip OK?
5. **Commands**: `setup` · `doctor` · `send-test --from a --to b` (chứng minh roundtrip) · `uninstall` (gỡ managed block, giữ backup/store trừ `--purge`).
6. **Docs**: README người lạ set-up <5 phút.

**Task khi go**: Celina core (setup.js detect/inject/backup/idempotent, agent-agnostic addressing, per-OS layout) · Ariel QA (failure-mode matrix: config corruption, path lạ, OS khác, tên trùng, perm denied; verify doctor bắt hết) · Claire (chốt managed-block format + agents.json schema, review, merge, viết README).

---

## BÀI HỌC ĐI MƯỢN — adopt từ tool có sẵn (research 2026-06-16)

Khảo sát: concept mình KHÔNG mới. Tool tương tự: **Agent Bus MCP** (gần nhất, gần song sinh — topic/stream/cursor-per-peer, SQLite), **agent-collab-mcp** (task state machine + role gating + dashboard, SQLite), **SLM Mesh** (8 tool, broker+Unix socket push+SQLite+WAL, file-lock, shared KV, bearer auth, 480 test), **claude-peers-mcp**, **Message Bus Claude Code Skill**.

**Ngách giữ vững**: gần hết tụi nó dùng broker+SQLite+socket. Mình **0-dep thuần, file-only, không daemon** = bản tối giản nhất, cài-là-chạy. Đó là cạnh tranh duy nhất → KHÔNG đánh đổi.

> ✅ **XONG 6/6 2026-06-16** (Yang lệnh: học trước, Production gác). Sóng A: #1 sync · #6 test+package.json v0.4.0. Sóng B: #3 review-verdict · #5 file-lock. Sóng C: #2 role-gating (policy.js + roles.json + preset, advisory mode, distributed reducer teeth) + #4 preset GỘP. TẤT CẢ MERGED, run-tests xanh hết. **✅ RESTART XONG + VERIFY LIVE 2026-06-16: review/task/sync OK; gating advisory chạy đúng (claire claim → warn + reducer DROP → task vẫn open). Sổ borrowed-lessons ĐÓNG.**

**HỌC NGAY (Yang chốt — rẻ, không phá 0-dep)**:
1. ✅ **Gộp tool `sync(topic, outbox=[...])`** (học Agent Bus): 1 call vừa publish vừa lấy unread → cắt nửa round-trip trong /loop poll. Giữ send/inbox riêng cho backward-compat, thêm `sync` làm fast-path. **MERGED** — toolSync({outbox,limit,peek}).
2. ✅ **★ Role-based tool gating** (học agent-collab): enforce charter Ở TẦNG PROTOCOL, không bằng niềm tin. Agent role + task state quyết tool nào gọi được. Chống state corruption + giữ kỷ luật vai. **MERGED** — policy.js (validateAction PURE, fail-open) + roles.json (advisory) + presets/planner-executor-qa.json; server gate task/claim/renew/result/requeue/review (advisory=warn, enforce=reject); reducer DROP record vượt quyền (răng thật leaderless); reviews() lọc review của actor không có quyền. **(Thiết kế ↓ "Role Gating — design")**
3. ✅ **Review verdict cấu trúc** (học agent-collab): record review = {verdict: approve|request-changes, file-level issues[], severity}. Hợp khâu Claire review diff. **MERGED** — review({target,verdict,issues}) + reviews({target}), thread=reviews.
4. 🔧 **Strategy preset** (học agent-collab 6 strategy): charter mình ≈ planner-executor/architect-builder → đóng thành preset config chọn lúc setup, không hardcode. **GỘP vào #2** — presets/planner-executor-qa.json (đang làm sóng C).
5. ✅ **File-lock tool** (học SLM Mesh): tool cho agent khoá file repo chống 3 đứa sửa đè (file-based lock + auto-expire, hợp 0-dep). Khác lock nội bộ của log. **MERGED** — flock/funlock/flocks, locks/<sha1>.json, advisory-only.
6. 🟡 **Pin version + viết test** (học SLM 480 test/100% cov): install pin version; thêm test suite (kỷ luật test hiện = 0). **MERGED** — run-tests.js + package.json v0.4.0 (`npm test`). Follow-up: thêm test-sync.js.

### Role Gating — design (chốt 2026-06-16)

**Threat model**: gating = ANTI-MISTAKE (workflow guardrail), KHÔNG security. Agent ác sửa được server.js / ghi thẳng messages.jsonl → chống cái đó cần crypto/auth = out-of-scope. **README PHẢI ghi rõ: "workflow safety, không phải security isolation."**

**Cơ chế leaderless (authority = policy file + reducer rules, không leader sống)**:
1. Client/UX: nhét ràng buộc role vào tool description → LLM không thử gọi sai.
2. **★ Distributed reducer**: mỗi agent reducer validate action theo `roles.json`. Record sai role → DROP khỏi derived state. Dù agent hack server.js cho ghi, reducer các agent khác vẫn IGNORE → record bậy không ai công nhận. Đây là răng thật của leaderless.
3. Append-time: `validatePolicy(record, reducedState, roles)` reject JSON-RPC error trước khi ghi; reducer ignore cái lọt qua (client cũ/manual).

**State-aware**: `merge/approve` chỉ khi task state=`review_requested` + actor có quyền; `implement_result` chỉ nếu actor = claim-winner; `request_changes` chỉ reviewer.

**roles.json**: `{agent, role, allowed_actions, review_required_for, state_permissions}`. Preset `planner-executor-qa`: claire=plan/assign/approve/merge/requeue · celina=claim/implement/report/request_review · ariel=test/review/research/bulk_edit_if_assigned.

**policy_mode**: `advisory` (append+warning, dev/test) | `enforce` (reject invalid). MVP gate record quan trọng (claim/approve/merge/review-verdict), KHÔNG gate send/inbox social. `policy_admin` mới append `policy_update`. doctor có `policy_check` scan log.

**KHÔNG đua (sân SLM/agent-collab, phá 0-dep)**: broker, socket push, SQLite, dashboard web, auth token. 
**Thua đau không vá được nếu giữ 0-dep**: real-time push (tụi nó Unix socket <100ms; mình poll /loop 60s). Chấp nhận poll, HOẶC pha sau làm adapter socket OPTIONAL (không bắt buộc, giữ file-mode mặc định).

---

## THỨ TỰ THỰC THI ĐỀ XUẤT
1. P5 rotate MVP (nền lưu trữ ổn định) → 2. task-claim (xây trên log rotate-safe) → 3. **Production local-first** (setup.js + agent-agnostic + portable + doctor — biến repo thành thứ người lạ tải về dùng được) → 4. P5 pha 2 prune-delete + offline policy (chờ Yang).

Lưu ý thứ tự: nếu mục tiêu là PHÁT HÀNH cho người ngoài sớm, có thể đẩy Production lên trước task-claim — task-claim là tính năng nâng cao, không cản phát hành bản dùng cơ bản. Quyết lúc Yang "go".

Tất cả chờ Yang gõ "go".
