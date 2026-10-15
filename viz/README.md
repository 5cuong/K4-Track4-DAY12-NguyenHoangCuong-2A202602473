# viz — xem model của bạn lái trong mô phỏng 3D

Phần **không bắt buộc và không chấm điểm**, dành cho khi bạn đã xong bước 7. Nó đặt các model **bạn đã huấn luyện** (EgoMLP, PercMLP, PercMLP+) và luật IDM vào xe đỏ trong một đoạn phố 3D, rồi cho chúng lái cùng các cảnh của bài lab. Nhìn thấy xe đâm hay không đâm giúp bạn hiểu vì sao các con số ở `evidence/` lại như vậy.

## Chạy

```bash
python3 run_all.py --student-id <MSSV>      # nếu chưa chạy đủ các bước 3, 4, 6, 7
python3 scripts/export_viz.py               # xuất model và kết quả CỦA BẠN sang viz/
python3 viz/serve.py                        # rồi mở http://localhost:8765
```

Cần internet (trang nạp thư viện three.js từ cdnjs) và trình duyệt hiện đại. Chưa thử trên điện thoại. `lab_models.js` và `lab_data.js` do bạn tự sinh nên không được commit (đã có trong `.gitignore`).

Nếu `export_viz.py` báo thiếu gì, nó nói rõ phải chạy bước nào. Nếu trang hiện thông báo "chưa nạp được dữ liệu", bạn chưa chạy `export_viz.py` hoặc đã chạy ở thư mục khác.

## Trong trang

- **Bộ điều khiển và seed:** chọn IDM, constant-velocity, EgoMLP, PercMLP hay PercMLP+, và một trong các seed bạn đã huấn luyện. Cảnh 3D hiển thị bộ đang chọn; bảng so cả năm bộ cùng lúc (với model học là một hàng cho mọi seed, ví dụ "2 / 5 seed").
- **Ba cảnh:** *xe dẫn phanh gấp*; *xe cắt vào* (khoảng cách và tốc độ tiến gần chỉnh được, giống lưới của bước 2); *log thật* (xe dẫn lái theo tốc độ của một quỹ đạo Argoverse; 2 giây đầu xe ta lặp lại người lái rồi bộ điều khiển cầm lái, giống bước 4).
- **Xe sau:** *phát lại* (không phản ứng) hay *phản ứng* (IDM, trễ 0,6 s), giống bước 5. Với xe sau phát lại, xe đó đâm xuyên qua xe ta rồi trông như xe phía trước, nên va chạm phía trước xảy ra *sau* cú đâm giả đó không được tính.
- **Nút "Chạy cả … log"** chạy cả năm bộ trên toàn bộ log đã xuất (mô phỏng 3D, nhiều log hơn một lần xem nhưng ít hơn bước 4 của bài lab).
- **Bảng cổng** ở cuối là quyết định `evidence/gate.json` của bạn: rê chuột lên dấu ✓ hoặc ✗ để xem số đo.

## Gợi ý để quan sát (có thể đưa vào câu 4 và 7 của báo cáo)

1. Cảnh xe dẫn phanh gấp, kéo mức phanh từ 3 lên 9 m/s²: bộ nào bắt đầu đâm ở mức nào? EgoMLP khác PercMLP ở điểm nào về thứ mà nó nhìn thấy?
2. Đổi seed của EgoMLP: xe có đâm ở mọi seed không? Việc này nói gì về một lần chạy?
3. Cảnh xe cắt vào, tăng tốc độ tiến gần: PercMLP và PercMLP+ khác nhau từ đâu? Điều đó khớp với quy tắc nào của cổng bị rớt và được sửa ở bước 7?
4. Đổi xe sau sang "phát lại": bộ điều khiển an toàn nào bỗng bị "đâm"? Vì sao đó không phải lỗi của nó?

## Lưu ý khi đọc kết quả

- Đây là mô phỏng 3D với vật lý riêng, không phải mô phỏng 1 chiều của bài lab, và chỉ có một số kịch bản. **Con số không so trực tiếp với `evidence/`**, nhưng hình dạng kết quả nên khớp.
- Mô hình của bài lab chỉ biết bám xe. Đèn đỏ và người qua đường do một lớp luật IDM xử lý, vì log không có hai thứ đó.
- Các file `index.html`, `app.js`, `sim.js` là của giảng viên: đừng sửa, sẽ bị ghi đè khi cập nhật.
