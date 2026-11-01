# NEXA – Thông báo kế hoạch nền không cần Firebase Blaze

Bộ này dùng:

**Cloudflare Worker Cron → Firestore → OneSignal Push**

NEXA hiện tại của bạn lưu kế hoạch tại:

`users/{UID}` → `appData` → `tasks`

Worker này đọc đúng cấu trúc đó và dùng các trường:

- `id`
- `title`
- `date`
- `time`
- `done`
- `repeat`
- `reminderInterval`

## 1. Chuẩn bị Cloudflare

Tạo tài khoản Cloudflare, cài Wrangler:

```bash
npm install -g wrangler
wrangler login
```

Mở Terminal tại thư mục này.

## 2. Tạo Service Account cho Worker đọc Firestore

Vào Google Cloud Console của đúng project Firebase → **IAM & Admin → Service Accounts**.

Tạo Service Account mới, ví dụ:

`nexa-reminder-worker`

Cấp quyền tối thiểu phù hợp để đọc/ghi Firestore. Cách đơn giản cho cấu hình cá nhân là role:

`Cloud Datastore User`

Sau đó tạo **JSON key** và tải file JSON về.

> Không upload JSON key lên GitHub, không gửi public.

## 3. Khai báo Secrets trên Cloudflare

Trong Terminal:

```bash
wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
```

Dán toàn bộ nội dung file Service Account JSON vào.

Tiếp theo:

```bash
wrangler secret put FIREBASE_PROJECT_ID
```

Nhập Project ID Firebase của NEXA.

```bash
wrangler secret put ONESIGNAL_APP_ID
```

Nhập OneSignal App ID. Trong index.html hiện tại là:

`bc3a8dd5-f2d5-4673-a5cd-7fa34a8254e2`

Cuối cùng:

```bash
wrangler secret put ONESIGNAL_REST_API_KEY
```

Nhập REST API Key của OneSignal.

Tùy chọn để test URL `/run`:

```bash
wrangler secret put RUN_SECRET
```

## 4. Deploy

```bash
wrangler deploy
```

Worker sẽ chạy Cron mỗi phút.

## 5. Cách Worker nhắc việc

- Đến `date + time`
- Công việc phải xảy ra trong ngày theo `repeat`
- `done` phải là `false`
- Lần đầu đến giờ → gửi OneSignal
- Nếu `reminderInterval` là 10/15/30/60 phút → tiếp tục nhắc theo chu kỳ
- Nếu `Không nhắc lại` → chỉ gửi 1 lần trong ngày
- Tick hoàn thành (`done: true`) → Worker tự bỏ qua, không nhắc nữa

Trạng thái lần nhắc được lưu ở top-level `reminderState` trong document Firestore để không sửa hoặc ghi đè `appData.tasks`.

## 6. Test

Tạo công việc trong NEXA có giờ sau hiện tại 2–3 phút, ví dụ:

- Tên: `TEST PUSH NEXA`
- Ngày: hôm nay
- Giờ: sau 2–3 phút
- Nhắc lại: `10 phút`

Đảm bảo:

1. NEXA đã đăng nhập Gmail.
2. NEXA đã liên kết UID với OneSignal.
3. Thiết bị đã cấp quyền thông báo.
4. Website chạy HTTPS và OneSignal Web Push hoạt động.

Sau đó có thể đóng NEXA/trình duyệt để kiểm tra push nền.

## Lưu ý quan trọng

Cloudflare Worker cần quyền server để đọc Firestore. Firestore Rules của ứng dụng web vẫn giữ nguyên; Worker xác thực bằng Service Account nên không phụ thuộc vào Rules phía client.

Nếu OneSignal trả lỗi, chạy:

```bash
wrangler tail
```

để xem log Worker.

