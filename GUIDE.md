# GUIDE — làm từng bước

Quy trình lặp lại ở mỗi bước: **(1)** đọc mục tiêu, **(2)** cài hàm TODO, **(3)** chạy kiểm thử của bước, **(4)** chạy bước, **(5)** đọc kết quả và trả lời câu hỏi gợi ý (chúng là nguyên liệu cho `REPORT.md`).

Gợi ý chung: bạn chạy được **từng bước riêng** (`python3 run_all.py <bước>`), nên đừng chờ cài hết rồi mới chạy. Dùng mã sinh viên thật ngay từ đầu để số liệu bạn thấy là số liệu bạn sẽ nộp: `python3 run_all.py --student-id <MSSV> <bước>`.

---

## Bước 0 · Dữ liệu (không viết mã)

```bash
python3 run_all.py data
```

Tải, loại trùng, chia, và ghi `evidence/data_audit.json`. **Đọc kỹ file này**: nó chứa những điều bạn phải biết trước khi tin bất kỳ con số nào về dữ liệu.

Câu hỏi gợi ý (→ câu 1 của báo cáo):
- Cột `Acc_LV` (gia tốc xe dẫn) có khớp với đạo hàm của `Speed_LV` không? Thử đọc `acc_lead_column_corr_with_dv_dt` và so với cột tương ứng của xe theo sau. Bạn nên dùng gia tốc nào khi khai thác ca phanh?
- Có bao nhiêu quỹ đạo trùng hệt nhau? Vì sao điều đó nguy hiểm khi chia train/test?
- Vì sao ta chia theo **quỹ đạo** chứ không chia theo khung hình?

---

## Bước 1 · Phát lại

**Hàm cần cài:** `replay.compare_with_tol`

Log được ghi thành file JSON Lines có dấu thời gian, rồi phát lại từng thông điệp theo thứ tự thời gian cho một bộ điều khiển dạng "luồng". Bạn cài phần **so sánh hai lần phát lại theo từng đoạn, có dung sai**.

```bash
python3 -m unittest discover -s tests -k Replay -v
python3 run_all.py --student-id <MSSV> replay
```

**Dấu hiệu đúng:** lần chạy lại cùng mã cho 0 đoạn khác nhau; bản "refactor float32" không giống từng bit nhưng **0 đoạn vượt dung sai**; thay đổi AEB làm lệch **một số ít** đoạn.

Để **mở một đoạn bị lệch**, dán đoạn này vào một file `peek.py` (số đoạn lấy từ dòng `open them: [...]` mà bước 1 in ra) rồi chạy `python3 peek.py`:

```python
import numpy as np
from lab12 import config as C, replay as R
segs = R.read_log(C.WORK_DIR / "replay_log.jsonl")
golden, _ = R.replay(segs, lambda: R.IDMStream())
aeb, _ = R.replay(segs, lambda: R.IDMStream(aeb_ttc=1.5))
seg = 124                                                    # thay bằng số đoạn của bạn
frames = np.flatnonzero(np.abs(golden[seg] - aeb[seg]) > 1e-3)
perc = [m for m in segs[seg] if m["topic"] == "/perception"]
can = [m for m in segs[seg] if m["topic"] == "/can"]
for k in frames[:5]:
    closing = can[k]["v_ego"] - perc[k]["v_lead"]
    print(k, "gap", perc[k]["gap"], "closing", round(closing, 2), "TTC", round(perc[k]["gap"] / closing, 2),
          "lệnh cũ", round(golden[seg, k], 2), "-> mới", round(aeb[seg, k], 2))
```

Câu hỏi gợi ý (→ câu 2):
- Vì sao bản refactor không giống từng bit nhưng vẫn "đúng"? Dung sai nào là hợp lý?
- Mở một đoạn bị lệch vì AEB (chỉ số in ra màn hình): lệch ở những khung nào, và vì sao ở đúng các khung đó?
- Phát theo thời gian thật có khung trễ và khung rớt mà phát nhanh nhất không có. Vì sao?

---

## Bước 2 · Kịch bản

**Hàm cần cài:** `scenarios.ttc`, `scenarios.required_decel`, `scenarios.unavoidable`, `scenarios.mine_braking`

- `ttc`, `required_decel`: ví dụ trên slide (khoảng cách 12 m, tiến gần 5 m/s: TTC 2,4 s, giảm tốc cần thiết 1,04 m/s²).
- `unavoidable`: **tự suy ra** biên mà không bộ điều khiển nào tránh được (phanh hết cỡ sau thời gian trễ). Đây là chìa khoá để phân biệt "bất khả thi" với "bộ điều khiển thất bại".
- `mine_braking`: tìm các ca xe dẫn phanh trong log (nhớ dùng gia tốc **đã làm mượt**).

```bash
python3 -m unittest discover -s tests -k Metrics -v
python3 -m unittest discover -s tests -k Mining -v
python3 -m unittest discover -s tests -k Simulator -v      # kiểm chứng bộ mô phỏng bằng chính hàm unavoidable của bạn
python3 run_all.py --student-id <MSSV> scenarios
```

**Dấu hiệu đúng:** dòng `validation ... mismatching cells away from the frontier:` phải là **0** ở cả hai độ trễ. Nếu khác 0, hàm `unavoidable` (hoặc cách bạn hiểu biên) sai. Xem hình `evidence/scenarios_idm.png`: đường đỏ (đâm) của IDM phải nằm đúng trên đường cyan (bất khả thi).

Câu hỏi gợi ý (→ câu 3):
- Bao nhiêu % ô của lưới là bất khả thi? Độ trễ 0 → 0,6 s làm con số đó đổi bao nhiêu?
- Người lái trong log phanh mạnh nhất cỡ bao nhiêu (`human_brake_limit` trong `scenarios.json`)? Bao nhiêu % lưới đòi phanh mạnh hơn? Các chấm trắng (ca khai thác từ log) phủ vùng nào của lưới?

---

## Bước 3 · Vòng hở

**Hàm cần cài:** `models.l2_summary`

Huấn luyện hai mô hình (EgoMLP chỉ nhìn tốc độ của chính nó; PercMLP nhìn thêm khoảng cách và tốc độ xe dẫn) rồi chấm L2 trên log giữ lại: trung bình toàn bộ và trên **lát cắt** "xe dẫn sắp phanh".

```bash
python3 -m unittest discover -s tests -k OpenLoop -v
python3 run_all.py --student-id <MSSV> openloop          # khoảng 30 giây với 5 seed
```

**Dấu hiệu đúng:** lát cắt chiếm một tỷ lệ nhỏ (vài %) các cửa sổ, và L2 trên lát cắt **lớn hơn** L2 trung bình. Đó là lý do trung bình che lỗi.

---

## Bước 4 · Vòng kín

**Hàm cần cài:** `stats.wilson`

Bốn bộ điều khiển (constant-velocity, IDM, EgoMLP, PercMLP) tự lái đối đầu xe dẫn phát lại từ log, nhiều seed. Tỷ lệ va chạm kèm khoảng tin cậy Wilson mà bạn cài.

```bash
python3 -m unittest discover -s tests -k wilson -v
python3 run_all.py --student-id <MSSV> closedloop
```

Xem bảng cuối: **cặp nào đổi thứ tự** giữa L2 và va chạm? Xem hình `evidence/openloop_vs_closedloop.png`. Với mỗi mô hình học, nhìn **dải** tỷ lệ va chạm qua các seed.

Câu hỏi gợi ý (→ câu 4, 5):
- IDM có L2 thế nào so với các mô hình học, và nó đâm nhiều hay ít? Giải thích vì sao.
- EgoMLP có L2 tốt hơn constant-velocity nhưng vẫn đâm. Nó thiếu thông tin gì?
- Dải va chạm của EgoMLP giữa các seed rộng cỡ nào? Khoảng tin cậy của seed tốt nhất và xấu nhất có chồng nhau không? Nếu chỉ chạy một seed thì kết luận sẽ ra sao?

---

## Bước 5 · Tác nhân phản ứng (không viết mã)

```bash
python3 run_all.py --student-id <MSSV> agents
```

Bước này hiệu chỉnh một xe sau tự lái theo IDM với thời khoảng cách `T` khớp với người lái trong log (bạn xem bảng khoảng cách phân bố), rồi so hai thế giới trên lưới cắt vào: xe sau **phát lại** (không biết xe thử vừa phanh) và xe sau **phản ứng**.

Câu hỏi gợi ý (→ câu 6):
- `T` được chọn là bao nhiêu và vì sao nó tốt hơn một xe sau không bao giờ phản ứng?
- Với xe sau phát lại, IDM bị tính bao nhiêu % va chạm **phía sau**? Có thật không? So với constant-velocity thì IDM trông ra sao trong hai thế giới?

---

## Bước 6 · Cổng phát hành

**Hàm cần cài:** `gate.rule_closed_loop_logs` (R2), `gate.rule_scenario_grid` (R4)

Bảy quy tắc, một quy tắc rớt là **chặn**. R2 và R4 do bạn cài (hai quy tắc dạng "không kém hơn baseline"); năm quy tắc còn lại có sẵn, **đọc chúng** để hiểu cổng kiểm tra gì (`lab12/gate.py`).

```bash
python3 -m unittest discover -s tests -k Gate -v
python3 run_all.py --student-id <MSSV> gate
```

**Đừng chỉnh ngưỡng để mô hình "qua".** Ngưỡng là một lựa chọn của đội, bạn đọc nó, không đổi nó.

Câu hỏi gợi ý (→ câu 7): ứng viên nào bị chặn bởi quy tắc nào? Có hai nguyên nhân gốc khác nhau trong các quy tắc bị rớt của PercMLP: một liên quan đến **kịch bản mà log không chứa**, một liên quan đến **sai số tích luỹ** khi mô hình tự lái. Bạn nhìn ra chúng ở số liệu nào?

---

## Bước 7 · Sửa và chạy lại cổng

**Hàm cần cài:** `augment.dagger_windows`

Hai cách sửa PercMLP đã có trong mã:
1. Thêm cửa sổ huấn luyện từ **họ kịch bản cắt vào** mô phỏng (`augment.cutin_windows`, có sẵn). Nhãn là việc luật IDM làm ở đó.
2. **DAgger** (hàm bạn cài): cho mô hình tự lái trên log huấn luyện, ghi lại các trạng thái nó **tự đi vào**, gắn nhãn bằng dự báo 3 giây của IDM ở đúng các trạng thái đó, huấn luyện lại. Làm vài vòng.

```bash
python3 -m unittest discover -s tests -k Dagger -v
python3 run_all.py --student-id <MSSV> --seeds 3 fix     # khoảng 1,5 phút với 3 seed; 2,5 phút với 5 seed
```

Câu hỏi gợi ý (→ câu 7 tiếp):
- Sau khi sửa, quy tắc nào chuyển từ rớt sang qua? Vì sao chính các hàm bạn sửa chữa đúng nguyên nhân đó?
- PercMLP+ qua cổng. Nó có **tốt hơn** IDM không? Nó học từ ai? Nó có thể vượt thầy của mình không? Bạn có nên thay IDM ngay, hay làm gì khác trước?
- L2 vòng hở của PercMLP+ so với PercMLP: đổi thế nào, và điều đó nói gì về điểm vòng hở?

---

## Hoàn thành

```bash
python3 run_all.py --student-id <MSSV>        # chạy lại toàn bộ lần cuối với mã thật
python3 scripts/check_submission.py --save-verify
```

Điền `REPORT.md`, commit, push. Câu 8 (bài lab này **không** chứng minh được gì) cần bạn tự nghĩ: gợi ý đọc lại phần "Giới hạn" ở `README.md` rồi chọn những giới hạn **quan trọng nhất** với việc quyết định phát hành, kèm lý do.
