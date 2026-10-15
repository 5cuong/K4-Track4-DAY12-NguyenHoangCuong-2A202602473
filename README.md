# Lab Day 12 — Phát lại và kiểm thử vòng kín

**Cá nhân · 4 giờ · laptop hoặc Google Colab · chỉ cần Python, numpy, pandas, matplotlib · không GPU · không phải thu thập dữ liệu**

## Bài toán

Đội phát triển giao cho bạn hai bản điều khiển **bám xe** (giữ khoảng cách với xe phía trước):

- **Bản cũ:** luật IDM, viết tay.
- **Bản mới:** mạng MLP học từ log lái thật. Điểm trên log trông rất đẹp.

Bạn là kỹ sư kiểm thử. **Có nên phát hành bản mới không?** Câu trả lời phải dựa trên bằng chứng bạn tự chạy ra, không dựa trên một con số.

## Sau bài lab bạn làm được gì

1. **Phát lại** một nhật ký, so hai lần phát có dung sai, và biết phát nhanh nhất che mất lỗi gì so với phát theo thời gian thật.
2. Biến log thành **họ kịch bản có tham số**, tìm **ranh giới** thất bại thay vì đo trung bình.
3. So **vòng hở** với **vòng kín** và chỉ ra khi nào hai cách chấm xếp hạng ngược nhau.
4. Dùng **tác nhân phản ứng** thay cho phát lại và thấy kết luận đổi ra sao.
5. Viết một **cổng phát hành**, đọc lý do bị chặn từ bằng chứng, sửa, rồi chạy lại cổng.

## Dữ liệu

[OpenPAV-Trajectory](https://huggingface.co/datasets/OpenPAV/OpenPAV-trajectory), phần Argoverse 2: 9.993 cặp xe dẫn và xe theo sau (người lái), 10 Hz, mỗi cặp 7–11 giây. Script tự tải (195 MB, không cần tài khoản). Dữ liệu và `work/` **không được commit** (đã có trong `.gitignore`).

> Giấy phép: dữ liệu Argoverse 2 là CC BY-NC-SA 4.0 (dùng học tập, phi thương mại). Đừng đăng lại file dữ liệu lên repo.

## Bắt đầu (5 phút)

Đây là bài **cá nhân**: bạn lấy bộ khung về, làm trên máy của bạn, rồi đẩy mã và báo cáo lên **repo GitHub của chính bạn**. Có hai cách lấy bộ khung, chọn một.

**Cách 1 · Fork (khuyên dùng).** Bấm **Fork** ở trang repo của lớp để có bản của bạn, rồi clone bản fork đó:

```bash
git clone https://github.com/<tài-khoản-của-bạn>/K4-Track4-Replay-CloseOpenLoop.git
cd K4-Track4-Replay-CloseOpenLoop
```

**Cách 2 · Clone repo của lớp, rồi đổi nơi đẩy lên.** Tạo một repo **Public** rỗng trên GitHub của bạn, rồi:

```bash
git clone https://github.com/VinUni-AI20k/K4-Track4-Replay-CloseOpenLoop.git
cd K4-Track4-Replay-CloseOpenLoop
git remote set-url origin https://github.com/<tài-khoản-của-bạn>/<tên-repo-của-bạn>.git
git push -u origin main
```

Dù chọn cách nào, bạn chỉ `push` lên repo **của bạn**, không `push` lên repo của lớp. Sau đó:

```bash
pip install -r requirements.txt
python3 run_all.py data                  # tải và kiểm tra dữ liệu (bước 0, không cần viết mã)
python3 -m unittest discover -s tests    # lúc đầu 13 kiểm thử LỖI: đó là 10 hàm bạn phải cài
```

Bạn sẽ viết **10 hàm** đánh dấu `TODO` (tìm bằng `grep -rn "NotImplementedError" lab12/`). Mỗi hàm có docstring mô tả đúng đầu vào, đầu ra và một gợi ý. Mọi thứ còn lại (mô phỏng, mạng MLP, tải dữ liệu, vẽ hình) đã có sẵn.

| Bước | Lệnh | Hàm bạn cài | Kiểm thử |
|---|---|---|---|
| 0 | `python3 run_all.py data` | — | — |
| 1 · Phát lại | `python3 run_all.py replay` | `replay.compare_with_tol` | `-k Replay` |
| 2 · Kịch bản | `python3 run_all.py scenarios` | `scenarios.ttc`, `required_decel`, `unavoidable`, `mine_braking` | `-k Metrics -k Mining -k Simulator` |
| 3 · Vòng hở | `python3 run_all.py openloop` | `models.l2_summary` | `-k OpenLoop` |
| 4 · Vòng kín | `python3 run_all.py closedloop` | `stats.wilson` | `-k wilson` |
| 5 · Tác nhân phản ứng | `python3 run_all.py agents` | — | — |
| 6 · Cổng | `python3 run_all.py gate` | `gate.rule_closed_loop_logs`, `rule_scenario_grid` | `-k Gate` |
| 7 · Sửa | `python3 run_all.py fix` | `augment.dagger_windows` | `-k Dagger` |

Chạy kiểm thử của một bước: `python3 -m unittest discover -s tests -k Replay -v`.

**Chạy toàn bộ** khi đã cài xong (mã sinh viên quyết định cách chia dữ liệu và seed, nên **mỗi người có số liệu riêng**):

```bash
python3 run_all.py --student-id <MSSV>        # khoảng 3–4 phút trên laptop (1 luồng CPU)
python3 run_all.py --student-id <MSSV> --seeds 3   # nhanh hơn nếu máy yếu hoặc dùng Colab
python3 run_all.py --quick                    # chạy thử rất nhanh để gỡ lỗi (số liệu sẽ khác, KHÔNG dùng để nộp)
```

Mỗi bước in ra màn hình và ghi bằng chứng vào `evidence/*.json` (kèm hình `.png`). **Báo cáo của bạn phải dùng số trong các file này.**

Hướng dẫn từng bước, gợi ý và "dấu hiệu đúng" ở [`GUIDE.md`](GUIDE.md).

## Xem model của bạn lái trong mô phỏng 3D (không bắt buộc, không chấm)

Khi đã xong bước 7, bạn có thể xem chính các model bạn huấn luyện lái trong một đoạn phố 3D, thử các cảnh xe dẫn phanh gấp, xe cắt vào, log thật, và đổi xe sau giữa "phát lại" và "phản ứng":

```bash
python3 scripts/export_viz.py        # xuất model và kết quả của bạn sang viz/
python3 viz/serve.py                 # rồi mở http://localhost:8765
```

Cần chạy trên máy cá nhân (không dùng được trên Colab) và có internet. Chi tiết, gợi ý quan sát ở [`viz/README.md`](viz/README.md) và `GUIDE.md` (Bước 8). Mô phỏng này chỉ để bạn *nhìn* ra điều các con số nói; báo cáo vẫn phải dùng số trong `evidence/`.

## Nộp bài

1. Điền [`REPORT.md`](REPORT.md): họ tên, MSSV, GitHub, 8 câu hỏi (mỗi câu 4–8 dòng, **dẫn số của chính bạn**).
2. Chạy lại toàn bộ với **MSSV thật** (không phải `demo`) và **không** dùng `--quick`.
3. `python3 scripts/check_submission.py` phải không còn dòng `[FAIL]` (thêm `--save-verify` để lưu `evidence/verify.txt`).
4. `commit` và `push` lên **repo GitHub của bạn** (bản fork hoặc repo riêng), đặt chế độ **Public** để giảng viên xem được: mã (10 hàm bạn đã cài), `evidence/` và `REPORT.md`. Ít nhất **5 commit của bạn**, trải qua các bước. Không commit `data/`, `work/`.
5. Link repo của bạn là bài nộp: gửi theo kênh lớp quy định.

Thang điểm ở [`RUBRIC.md`](RUBRIC.md).

## Quy tắc

- Chỉ sửa **thân 10 hàm TODO** và `REPORT.md`. Giảng viên có thể ghi đè các file khác bằng bản gốc khi chấm, rồi chạy lại từ đầu với MSSV trong báo cáo và so với `evidence/` của bạn.
- Không sửa `tests/`, ngưỡng của cổng phát hành, hay số trong `evidence/` bằng tay.
- Không chép bài: mã sinh viên làm mỗi người một bộ số khác nhau, nên số trùng người khác là dấu hiệu rõ.
- Có thể hỏi và thảo luận ý tưởng, nhưng mã và báo cáo là của bạn.

## Chạy trên Google Colab

Mở [`lab12_colab.ipynb`](lab12_colab.ipynb) (hoặc làm tay: tải thư mục lên, `!pip -q install numpy pandas matplotlib`, `%cd` vào thư mục repo, `!python run_all.py ...`). Dùng `--seeds 3` cho nhanh. Sửa mã bằng trình soạn thảo của Colab (cây thư mục bên trái) và nhớ **tải lại `lab12/`, `evidence/` và `REPORT.md` về máy rồi commit**, vì Colab không giữ file sau khi phiên kết thúc.

## Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `NotImplementedError: TODO ...` | Hàm đó là việc của bạn: xem docstring và gợi ý trong hàm, rồi `GUIDE.md`. |
| Tải dữ liệu bị đứng hoặc lỗi mạng | Chạy lại `python3 run_all.py data` (tải lại từ đầu, không hỏng file). Kiểm tra kích thước file `data/argoverse_step3.csv` ≈ 195 MB. |
| `export_viz: ... not found` | Bạn chưa chạy bước mà thông báo nêu (nó chỉ đúng bước cần chạy). |
| `FileNotFoundError: evidence/...json` | Bạn chạy bước sau khi chưa chạy bước trước. Chạy theo thứ tự trong bảng trên. |
| Bước `fix` quá lâu | Dùng `--seeds 3`. Bước này huấn luyện lại mô hình nhiều lần (khoảng 2,5 phút với 5 seed trên laptop). |
| Số khác với bạn cùng lớp | Đúng như thiết kế: mỗi MSSV một bộ số. Hình dạng kết quả giống nhau, con số thì không. |

## Giới hạn của bài lab (hãy nhớ khi viết câu 8)

Một chiều dọc, không cảm biến, xe dẫn trong log không phản ứng với xe thử, thế giới mô phỏng là giả định của chúng ta. Bài lab dạy **phương pháp kiểm thử**, không chứng minh một hệ thống an toàn.
