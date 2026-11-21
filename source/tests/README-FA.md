# آزمون‌های سورس R9

## آزمون‌های Revision 9

- `test-zip.js`: آزمون بازکنندهٔ داخلی بایگانی‌ها (بخش‌های stored/deflate، یک بایگانی واقعی Info-ZIP،
  ورودی مخرب `../`، بایگانی ZIP64 و فایل غیر-ZIP)؛ **۸/۸ PASS** و بدون هیچ dependency.
- `test-sidecar-matcher.js`: هشت آزمون Node بدون dependency برای نام دقیق، تبدیل SRT به WebVTT، شماره‌ی اپیزود، فارسی/Unicode و ارقام فارسی، پوشه‌ی شلوغ، زیرپوشه‌ی `Subs`، رد موارد مبهم و رد فایل متنی غیرزیرنویس؛ **۸/۸ PASS**.
- `test-source-ui.js`: پانزده بررسی ساختاری برای حذف Preview، حفظ Reset/style، ادغام sidecar، NSIS و fallback دانلود BAT، هم‌خوانی فهرست متدهای `preload.js` با `main.js`، میان‌برهای PageDown/PageUp/Delete، حذف امن فایل، حفظ ولوم هنگام mute، کلیدهای سرعت، سازگاری بیلد بدون NSIS و بدون unzip/7-Zip، یکپارچگی لوگو/آیکون، و تضمین‌های عملکرد فهرست پخش و لایه‌های شیشه‌ای؛ **۱۵/۱۵ PASS**.
- `test-keyboard-renderer.js`: هشت آزمون سرتاسری بدون مرورگر با jsdom که `index.html` و اسکریپت‌های واقعی را اجرا می‌کند: PageDown/PageUp (با چرخش دور فهرست)، Delete (انتقال فایل در حال پخش به سبد بازیافت + ادامه با ویدیوی بعد)، حذف‌نشدن تک‌آیتم فهرست، رسم حداکثر دوباری فهرست ۳۰۰ آیتمی و عدم probe هنگام hydrate؛ **۸/۸ PASS**. jsdom اختیاری است: `npm install --no-save jsdom`؛ بدون آن آزمون با پیام SKIP رد می‌شود.
- `test-ui-smoke.js`: یک پاس تعاملی روی رابط واقعی (پخش/جست‌وجو/پنل‌ها/تنظیمات/حالت کم‌مصرف/ولوم و mute/میان‌برها/منوی راست‌کلیک/زوم/تغییر mode) که در صورت هر خطای مدیریت‌نشده شکست می‌خورد؛ **۱۲/۱۲ PASS** (jsdom اختیاری).
- `results-r9-source.json`: نتایج و محدودیت‌های محیط R9.

## سوابق Revision 8 و R7

- `results-r8-source.json`: تست‌های سورس R8 (قبل از اصلاح خطای TLS در BAT).
- `harness-round7.js`: آزمون Electron/UI تاریخی برای clipboard، About، پوستر، حذف Screenshot و منوی راست‌کلیک در desktop/touch. شناسه‌ی About آن برای سورس R9 به‌روزرسانی شده است. برای اجرای harness باید به انتهای یک کپی موقت از `main.js` افزوده شود؛ جزو build محصول نیست.
- `make-r7-fixtures.sh`: ساخت فایل‌های کوچک HEVC و subtitle با FFmpeg محیط آزمون.
- `test-r7-codecs.js` و فایل‌های `results-r7-*`: آزمون‌های تاریخی کدک و UI.

تست‌های R9 روی Linux x64 اجرا شدند. BAT و نصاب Windows روی Windows واقعی در این محیط اجرا نشده‌اند. مسیر fallback برای خطای Schannel از نظر ساختاری آزمون شد؛ اجرای خود `curl.exe --ssl-no-revoke` در ویندوز کاربر باید تأیید نهایی شود. SHA-256 pinned پس از دانلود همچنان در BAT بررسی می‌شود.
