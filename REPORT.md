# REPORT — Lab Day 12

| Thông tin | Giá trị |
|---|---|
| Họ và tên | Nguyễn Hoàng Cường |
| MSSV | 2A202602473 |
| GitHub | 5cuong |
| Seed chia dữ liệu / seed mô hình | 746 / 7595 (các seed mô hình: 7595, 7596, 7597) |
| Số seed huấn luyện (--seeds) | 3 |

## Kết quả cuối

L2 là trung bình open-loop trên các seed; tỷ lệ va chạm là dải closed-loop trên các seed. Số liệu lấy từ evidence/openloop.json, evidence/closedloop.json và evidence/gate.json.

| Bộ điều khiển | L2 vòng hở (m) | Va chạm vòng kín trên log (%) | Quyết định cổng |
|---|---:|---:|---|
| constant-velocity | 1.262 | 19.74 | BLOCK |
| IDM | 1.520 | 0.07 | Baseline |
| EgoMLP | 0.755 | 17.76–23.55 | BLOCK |
| PercMLP | 0.618 | 0.45–1.39 | BLOCK |
| PercMLP+ (sau khi sửa) | 0.812 | 0.24–0.35 | RELEASE |

## Câu 1 · Dữ liệu

Audit giữ lại 992,679 khung và 9,610 quỹ đạo sạch từ 9,993 quỹ đạo thô; 383 quỹ đạo trùng tuyệt đối đã bị loại.  
Tương quan giữa Acc_LV và đạo hàm vận tốc chỉ là 0.0454, nên cột gia tốc này không phản ánh đáng tin gia tốc thực.  
Pipeline thay bằng gia tốc suy ra từ Speed_LV đã làm mượt; tương quan tương ứng của xe sau là 0.9291, cho thấy cách suy ra có cơ sở hơn.  
Chia theo quỹ đạo giữ toàn bộ các khung của một chuyến trong cùng một tập, tránh rò rỉ các khung gần như trùng nhau sang cả train lẫn test.

## Câu 2 · Phát lại

Phát lại cùng mã cho 0/600 đoạn khác; refactor float32 khác từng bit ở 600/600 đoạn nhưng 0 đoạn vượt dung sai, với sai khác cực đại 0.000403 m/s².  
Thêm AEB làm 5/600 đoạn vượt dung sai (77, 240, 265, 312, 417), vì luật chỉ phanh khẩn cấp khi closing dương và TTC dưới 1.5 giây; đây là đổi hành vi có chủ đích.  
Chế độ fastest xử lý 59,840 khung mà không mất hay trễ khung, còn realtime làm rơi 577 và trả lời trễ 583 khung; 375 đoạn vượt dung sai.  
Phát theo thời gian thật bộc lộ việc giữ lệnh cũ khi xử lý không kịp deadline, điều mà chạy nhanh nhất không mô phỏng; độ trễ còn phụ thuộc phần cứng và lịch chạy.

## Câu 3 · Kịch bản

Lưới dùng tốc độ ego 14 m/s, 2,700 ô, khoảng cách 2.76–59.31 m và closing speed 0–14 m/s; bước mining tìm được 614 sự kiện phanh gấp.  
Với phanh cực đại 9 m/s², diện tích bất khả kháng tăng từ 3.63% ở trễ 0 giây lên 10.22% ở 0.6 giây, tức tăng 6.59 điểm phần trăm.  
Mô phỏng phanh hết mức khớp biên tính toán ở cả hai độ trễ: số ô lệch ngoài biên là 0/2,682 và 0/2,662.  
P99.9 độ lớn phanh người lái là 3.625 m/s²; 12.67% ô đòi hỏi hơn giới hạn phanh đó, nên logs không bao phủ hết các tình huống khó của lưới.

## Câu 4 · Vòng hở và vòng kín

Xếp hạng L2 từ tốt đến kém là PercMLP (0.618 m), EgoMLP (0.755 m), constant-velocity (1.262 m), IDM (1.520 m).  
Xếp hạng va chạm trên log từ an toàn đến kém là IDM (0.07%), PercMLP (0.45–1.39%), constant-velocity (19.74%), EgoMLP (17.76–23.55%); có các cặp đảo hạng giữa hai phép đo.  
IDM có L2 cao vì mục tiêu là luật bám xe an toàn, không bắt chước chính xác quỹ đạo tương lai của người lái; trong vòng kín nó phản ứng lại trạng thái mới ở mỗi bước.  
EgoMLP có L2 0.755 m tốt hơn constant-velocity 1.262 m nhưng va chạm trung bình 21.26%, vì lỗi dự báo nhỏ trên phân phối log có thể tích lũy khi mô hình tự đưa xe vào trạng thái chưa thấy.

## Câu 5 · Một lần chạy chưa đủ

Tỷ lệ va chạm EgoMLP là 23.55%, 22.48% và 17.76% với seed 7595, 7596 và 7597; độ trải giữa hai cực là 5.79 điểm phần trăm.  
Wilson 95% của seed 7595 là 22.04–25.14% (679/2,883); seed 7597 là 16.41–19.20% (512/2,883).  
Nếu chỉ lấy seed 7595, ta có thể báo 23.55% và bỏ qua mức thấp hơn đáng kể của seed 7597 cũng như bất định lấy mẫu.  
Vì thế cổng dùng cận Wilson xấu nhất qua các seed; một lần chạy duy nhất có thể phóng đại hoặc đánh giá thấp rủi ro và không chứng minh tính ổn định.

## Câu 6 · Tác nhân phản ứng

Hiệu chỉnh Wasserstein chọn IDM xe sau với T = 1.4 s (W1 = 0.3435), tốt hơn tác nhân không phản ứng (W1 = 0.8726); headway trung vị người lái trong log là 1.855 s.  
Ở độ trễ 0.6 s, xe sau replay gây va chạm đuôi IDM ở 70.63% lưới, trong khi xe sau phản ứng gây 0%; tỷ lệ va chạm phía trước của IDM vẫn là 10.22%.  
Với PercMLP, va chạm sau giảm từ 42.48% xuống 0% trong cùng kịch bản; điều này cho thấy replay xe sau tạo va chạm giả khi nó không thể phanh theo xe thử nghiệm.  
Thế giới phản ứng làm kết luận công bằng hơn: cần đánh giá va chạm trước/sau riêng và dùng tương tác hợp lý, thay vì quy lỗi do xe sau đứng yên về hành vi của planner.

## Câu 7 · Cổng phát hành và sửa

Trước khi sửa, PercMLP bị chặn ở R2 (cận trên xấu nhất 1.88% so với giới hạn 1.07%), R3 (cận trên 9.3% so với mức IDM cộng 5 điểm), R4 (24.56% so với giới hạn 2%) và R6 (34.8% so với 10.2% của IDM).  
R5 thực tế đạt với độ trải seed 0.5–1.4%; R1 và R7 cũng đạt, dù yêu cầu bài mô tả R5 là lỗi.  
Bước fix bổ sung 20,000 kịch bản cut-in tổng hợp và dùng 2 vòng DAgger để gán nhãn IDM trên trạng thái mô hình tự gặp, nhắm vào thiếu hụt tình huống và covariate shift.  
Sau sửa, PercMLP+ có va chạm vòng kín 0.24–0.35% qua ba seed; cận Wilson trên seed xấu nhất là 0.64%, thấp hơn giới hạn R2 là 1.07%.  
R3 đạt với cận trên lát cắt phanh 3.4% (IDM 0.6% cộng biên 5 điểm), R4 có vùng va chạm quy được cho mô hình 0.11% (giới hạn 2%), còn R6 là 10.3% so với IDM 10.2%.  
R5 dao động 0.2–0.3% và cả R1–R7 đều pass, nên gate cho RELEASE; ở tốc độ giữ lại 20 m/s, vùng va chạm tránh được của PercMLP+ còn 0.11–2.04% theo seed, trong khi IDM là 0%.

## Câu 8 · Bài lab này không chứng minh được gì

Thứ nhất, dữ liệu vẫn là log OpenPAV/Argoverse đã làm sạch; 9,610 quỹ đạo không đại diện mọi khu vực, thời tiết, loại xe hay hành vi giao thông ngoài đời.  
Thứ hai, lưới chỉ có 2,700 ô với vận tốc, khoảng cách và động lực học dọc được mô hình hóa; kết quả không kiểm tra đánh lái, cảm nhận, vật cản hay tương tác đa làn đầy đủ.  
Thứ ba, xe sau phản ứng là IDM hiệu chỉnh T = 1.4 s, không phải người lái đa dạng; giả định này làm giảm va chạm giả nhưng không chứng minh tương tác thật.  
Cuối cùng, split seed và ba seed mô hình chưa đủ chứng minh an toàn hiếm gặp hay độ bền trên phần cứng xe; cần mở rộng dữ liệu, kiểm thử nhiễu/độ trễ, mô phỏng độc lập rồi mới thử nghiệm có giám sát trên xe.
