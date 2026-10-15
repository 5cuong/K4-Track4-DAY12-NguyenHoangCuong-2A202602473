# Thang điểm Lab Day 12 (100 điểm)

> Bài cá nhân, nộp qua **repo GitHub công khai của bạn** (bản fork hoặc repo riêng). Bạn **cài 10 hàm**, **chạy** đường ống, **đọc bằng chứng** và **giải thích**. Xem [`README.md`](README.md) và [`GUIDE.md`](GUIDE.md).

## Cách chấm

- Giảng viên clone repo của bạn (commit mới nhất **trước hạn nộp**), ghi đè các file ngoài 10 hàm TODO bằng bản gốc, đặt `--student-id` bằng **MSSV ghi trong `REPORT.md`**, rồi chạy lại toàn bộ và so với `evidence/` bạn nộp. Số khác nhau nghĩa là bài không phải của bạn hoặc mã không chạy được.
- Mỗi MSSV cho một bộ số riêng nên báo cáo của bạn được đối chiếu **giữa các repo**; giảng viên có thể gọi **vấn đáp ngắn (5 phút)**.

## A. Bằng chứng (35 điểm, tự động bằng `scripts/check_submission.py`)

| Mục | Điểm | Đạt khi |
|---|---|---|
| `data_audit.json` | 3 | Có, loại trùng đúng |
| `replay.json` | 5 | Chạy lại giống hệt; refactor không giống từng bit nhưng 0 đoạn vượt dung sai; AEB làm lệch một số đoạn (không phải tất cả) |
| `scenarios.json` | 6 | **0 ô lệch** khi kiểm chứng bộ mô phỏng ở cả hai độ trễ (tức `unavoidable` đúng); đủ số sự kiện khai thác |
| `openloop.json` | 4 | Đủ bốn bộ điều khiển và PercMLP+, từ 3 seed trở lên |
| `closedloop.json` | 6 | Đủ bốn bộ điều khiển, từ 3 seed trở lên, có xếp hạng và lưới cho cả hai độ trễ |
| `agents.json` | 4 | Có `T` hiệu chỉnh và hai bảng so sánh |
| `gate.json`, `fix.json` | 7 | Có quyết định cho mọi ứng viên; `fix.json` khớp với `gate.json`; chạy bằng MSSV thật, cùng một mã trên mọi file |

## B. Hàm tự cài (15 điểm, tự động bằng `python3 -m unittest discover -s tests`)

| Nhóm kiểm thử | Hàm | Điểm |
|---|---|---|
| `Replay` | `compare_with_tol` | 2 |
| `Metrics` | `ttc`, `required_decel`, `wilson` | 4 |
| `Metrics`, `Simulator` | `unavoidable` | 3 |
| `Mining` | `mine_braking` | 2 |
| `OpenLoop` | `l2_summary` | 1 |
| `Gate` | `rule_closed_loop_logs`, `rule_scenario_grid` | 2 |
| `Dagger` | `dagger_windows` | 1 |

Mỗi nhóm đạt điểm khi **mọi** kiểm thử trong nhóm qua.

## C. Báo cáo (40 điểm)

Mỗi câu 5 điểm: **đúng bản chất**, **dẫn số của chính bạn** (khớp `evidence/`), không chép lại tài liệu.

| Câu | Tiêu chí chấm kỹ nhất |
|---|---|
| 1 | Nêu đúng ba vấn đề, kèm số tương quan và số quỹ đạo trùng |
| 2 | Hiểu vì sao cần dung sai; giải thích đúng vì sao AEB chỉ lệch ở khung TTC thấp; hiểu vì sao phát nhanh nhất che lỗi trễ hạn |
| 3 | Dùng biên bất khả thi để phân biệt "ai cũng đâm" với "bộ điều khiển đâm"; nhận ra log không phủ vùng phanh mạnh |
| 4 | Chỉ ra đúng các cặp đảo thứ hạng và **giải thích cơ chế**, không chỉ mô tả bảng |
| 5 | Dùng khoảng tin cậy và dải qua seed để nêu rủi ro của việc báo một lần chạy |
| 6 | Giải thích "va chạm giả" và việc loại tác nhân làm đổi kết luận |
| 7 | Gắn mỗi quy tắc rớt với nguyên nhân gốc; không nói PercMLP+ "tốt hơn" IDM nếu bằng chứng chỉ cho thấy "không kém hơn" |
| 8 | Ít nhất ba giới hạn có lý do, liên hệ đến quyết định phát hành |

## D. Git và trình bày (10 điểm)

Ít nhất **5 commit của bạn** (không tính các commit có sẵn từ bộ khung) trải qua nhiều bước; repo của bạn **công khai** và sạch (không `data/`, không `work/`); `python3 scripts/check_submission.py` không còn `[FAIL]`: **10 điểm**. Mỗi mục `[FAIL]` còn lại trừ 1 điểm (tối đa −10).

## Lỗi bị trừ điểm

| Lỗi | Trừ |
|---|---|
| Kết luận dựa trên **một seed** hoặc không nêu dải qua seed | −5 |
| Số trong báo cáo **không có** trong `evidence/` | −2 mỗi số (tối đa −10) |
| Nói PercMLP+ (hoặc bất kỳ mô hình học nào) **tốt hơn** IDM mà không có bằng chứng | −3 |
| Chỉnh ngưỡng cổng, sửa `tests/`, hoặc sửa tay `evidence/` | −20 |
| Bằng chứng chạy bằng `--quick` hoặc MSSV `demo` | −10 |
| Số trùng với bài khác (trong khi MSSV khác nhau) | 0 điểm phần liên quan, báo cáo vi phạm |
