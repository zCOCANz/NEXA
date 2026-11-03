# NEXA Finance

## Đưa lên GitHub Pages
1. Tạo thư mục `finance` trong repository `NEXA`.
2. Chép 4 tệp trong thư mục này vào `NEXA/finance/`: `index.html`, `manifest.json`, `icon-192.png`, `icon-512.png`.
3. Sau khi GitHub Pages cập nhật, mở: `https://zcocanz.github.io/NEXA/finance/`.
4. Trên iPhone mở đường dẫn bằng Safari → Chia sẻ → Thêm vào màn hình chính. Ứng dụng có biểu tượng riêng NEXA Finance.

## Firebase
- Ứng dụng dùng Firebase project hiện có `nexa-9a4a3`.
- Chỉ cho phép Gmail `nguyenthao.p080@gmail.com` ở phần kiểm tra đăng nhập trong ứng dụng.
- Dữ liệu lưu tại collection riêng `nexaFinanceUsers/{uid}`, không dùng chung collection `users` của NEXA chính.
- Trong Firestore Rules, thêm rule sau bên trong `match /databases/{database}/documents { ... }`, đồng thời bảo đảm không có rule khác cấp quyền rộng hơn cho collection này:

```javascript
match /nexaFinanceUsers/{userId} {
  allow read, write: if request.auth != null
    && request.auth.uid == userId
    && request.auth.token.email == "nguyenthao.p080@gmail.com";
}
```

- Firebase Authentication → Authorized domains cần có `zcocanz.github.io` (nếu đã dùng NEXA thì thường đã có). Google sign-in phải được bật.

## Cách tính số dư
- Số dư tài khoản = tổng thu đã ghi nhận − tổng chi đã ghi nhận.
- Thu/chi nội bộ trong Quỹ không làm thay đổi tổng thu, tổng chi hoặc số dư tài khoản.
- Tổng số dư các Quỹ được hiển thị riêng.
