# NOTES
Đây là file note chung của team agent-bridge. Khi Yang nói "đọc note", đọc file này. Khi cần ghi note, viết vào đây.

---

## Cách đọc lịch sử
Khi Yang bảo "đọc lịch sử":
- Mặc định: đọc 20 tin gần nhất: `inbox({all: true, limit: 20})`
- Có số: "đọc lịch sử N tin" → `inbox({all: true, limit: N})`
- Có thời gian: "đọc lịch sử X tiếng" → đọc all rồi tự lọc theo timestamp
- Tuyệt đối không đọc toàn bộ messages.jsonl (tốn token, chết quota).

## Cách đọc note
Khi Yang bảo "đọc note": đọc file NOTES.md này và xử lý theo nội dung bên trong.
Bình thường (wake/resume): không đọc note, chỉ đọc inbox unread.

## Cập nhật note
Khi cần ghi nhớ gì mới: viết vào file này, ghi ngày tháng, ngắn gọn.

---

## 2026-06-18 20:56 — Selica cập nhật
- Review Celine code: DONE (PASS, APPROVE merge. 4 minor)
- Goose persistent: hoạt động (stdin pipe OK). Vấn đề: idle timeout 3ph + server restart mất child + config không auto-reload → cold-spawn. Đã sửa supervisor bỏ --watch.
- Codex `-C` deprecated: Selica fix (bỏ khỏi adapter) nhưng warning thật là plugin Twilio ngoài → không cần fix.
- Server: supervisor.js đang chạy index.js thẳng (không --watch). Config load thủ công.
- Claire: disabled đến 20/6
- Celine/Ariel: online standby
- Persistent mode: working, cần restart server sau config change để load keepAliveMs