# WIRE PROTOCOL — caveman ultra (agent↔agent)

Mục tiêu: nén cực đại tin nhắn/status/handoff giữa 3 agent. Tiết token. Mọi agent decode GIỐNG NHAU = bắt buộc codebook chung.

## SCOPE

NÉN: tin bridge, status, handoff, báo cáo nội bộ, ghi chú wip.

KHÔNG NÉN (giữ rõ ràng — nén = lỗi/rủi ro):
- Code, commit message, PR body
- Cảnh báo bảo mật
- Xác nhận thao tác phá hủy (delete/overwrite/reset)
- Phần DESIGN chuẩn trong PLAN.md (status banner thì nén được)

## WIRE FORMAT

1 dòng nếu được. Tối đa 2-3 dòng.

```
[FROM] #thread | TOK ... 
```

- FROM: c=claire, e=celina, a=ariel
- bỏ mạo từ/đệm/xã giao. Fragment OK. Chủ-vị tối thiểu.
- file = basename, dòng = `:N`. Vd `server.js:347`.

## CODEBOOK (token chuẩn)

Trạng thái:
- `OK` xong/đồng ý · `NG` fail/từ chối · `RC` request-change
- `WIP` đang làm · `BLK` blocked (kèm lý do) · `Q` hỏi · `ACK` nhận rồi
- `MG` merged · `RDY` ready/chờ duyệt

Action (task-claim vocab):
- `T` task · `CL` claim · `RN` renew · `RS` result · `RQ` requeue · `RV` review

Tham chiếu:
- `>id` reply tới record/msg id (rút 8 ký tự đầu)
- `@x` nhắc agent x · `#x` thread x
- `v:approve|request_changes` verdict review

Mẫu:
- `[c] #rev | RV server.js:347 v:approve OK MG` → Claire review file, approve, merged.
- `[e] #task1 | CL OK >ab12 WIP` → Celina claim được, đang làm.
- `[a] #qa | NG test-policy.js:58 reducer drop sai @e` → Ariel báo fail, gọi Celina.
- `[c] #task1 | RC policy.js fail-open thiếu null-check :29` → request-change.

## QUY TẮC

1. Đủ token là dừng. Không giải thích lại điều đối phương đã biết.
2. Mơ hồ vì nén → bung rõ chỗ đó (vd thứ tự bước phá hủy).
3. Codebook không đủ → dùng từ ngắn thường, đừng bịa mã mới giữa chừng.
4. Persona (em/anh khi nói với Yang) GIỮ — wire format chỉ áp agent↔agent.
