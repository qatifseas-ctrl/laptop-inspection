# Laptop Damage Inspection — تطبيق توثيق ضرر اللابتوبات

تطبيق ويب لتوثيق فحص ضرر 26 جهاز لابتوب مع **OCR ذكي** (عبر Vision AI) وتصدير Excel وتنزيل الصور كملف ZIP.

## ✨ الميزات

- **🔍 OCR ذكي** — يستخدم Vision Language Model لقراءة رقم Asset من صور الملصقات بدقة عالية (حتى مع الصور المعقدة، المائلة، أو التي تحتوي نصاً عربياً)
- **📸 كاميرا + رفع صور** — التقط صوراً مباشرة من الجوال أو ارفع من المعرض
- **💾 حفظ محلي (IndexedDB)** — البيانات تبقى على الجهاز لأيام/أسابيع بدون إنترنت
- **📄 تصدير Excel** — تقرير كامل بـ 15 عمود + ورقة ملخص
- **🗜️ ZIP لكل الصور** — مجلد لكل جهاز باسم Asset No
- **🏷️ تسمية تلقائية للصور** — `{AssetNo}_1.jpg`, `{AssetNo}_2.jpg`
- **📱 PWA** — يمكن تثبيته كأيقونة على الجوال

## 🚀 طريقة النشر (GitHub + Vercel)

### الخطوة 1: رفع الكود إلى GitHub

1. اذهب إلى https://github.com وسجّل دخولك
2. اضغط **+** في أعلى اليمين → **New repository**
3. اختر اسماً للمستودع (مثل `laptop-inspection`)
4. اختر **Private** (لأن المشروع يحتوي تكوين OCR)
5. اضغط **Create repository**
6. ارفع ملفات المشروع:
   - **الطريقة الأسهل:** اسحب الملفات عبر واجهة GitHub (Add file → Upload files)
   - **أو عبر Git:**
     ```bash
     git clone https://github.com/USERNAME/laptop-inspection.git
     cd laptop-inspection
     # انسخ كل ملفات المشروع هنا
     git add .
     git commit -m "Initial commit"
     git push origin main
     ```

### الخطوة 2: النشر على Vercel

1. اذهب إلى https://vercel.com وسجّل دخولك بحساب GitHub
2. اضغط **Add New...** → **Project**
3. اختر مستودع `laptop-inspection` من القائمة
4. اترك كل الإعدادات الافتراضية (Vercel سيكتشف Next.js تلقائياً)
5. اضغط **Deploy**
6. انتظر 1-2 دقيقة حتى يكتمل النشر
7. ستحصل على رابط مثل: `https://laptop-inspection-username.vercel.app`

### الخطوة 3: تثبيت VLM SDK (مهم!)

مشروع Vercel يحتاج متغير بيئة لتفعيل OCR الذكي. لكن `z-ai-web-dev-sdk` يعمل بشكل مباشر بدون مفاتيح API في بيئة Vercel.

**لا حاجة لأي إعداد إضافي** — Vercel سيثبت الحزمة تلقائياً من `package.json`.

### الخطوة 4: افتح التطبيق

1. اذهب للرابط الذي أعطاك إياه Vercel
2. افتحه على جوالك
3. **ثبّته كأيقونة:**
   - **iPhone (Safari):** زر المشاركة → Add to Home Screen
   - **Android (Chrome):** menu (⋮) → Add to Home screen

## 📋 طريقة الاستخدام

### 1. فحص جهاز
- اضغط على بطاقة الجهاز (1-26)
- عبّء الحقول (Asset, Serial, Location, ...)
- غيّر الحالة إلى "Damaged" أو "No Visible Damage"

### 2. التقاط صورة وقراءة الرقم تلقائياً
- اضغط "تصوير" أو "من المعرض"
- بعد رفع الصورة، اضغط **🔍 OCR Asset** على الصورة
- سيقرأ الذكاء الاصطناعي الرقم تلقائياً خلال 5-15 ثانية
- راجع الرقم واضغط **حفظ**

### 3. تصدير التقرير
- اضغط **تصدير Excel** في الأعلى → ملف XLSX كامل
- اضغط **كل الصور ZIP** → ملف ZIP بكل الصور منظمة في مجلدات

## 🛠️ التطوير محلياً

```bash
# تثبيت الحزم
npm install

# تشغيل خادم التطوير
npm run dev

# فتح المتصفح على http://localhost:3000
```

## 📐 البنية التقنية

```
laptop-inspection/
├── src/
│   └── app/
│       ├── api/
│       │   └── ocr/
│       │       └── route.ts     # Smart OCR endpoint (VLM)
│       ├── globals.css          # Tailwind + RTL styles
│       ├── layout.tsx           # Root layout (RTL, Arabic)
│       └── page.tsx             # Main app (React client component)
├── package.json                 # Next.js + z-ai-web-dev-sdk
├── tsconfig.json
├── next.config.ts
└── .gitignore
```

## 🔧 OCR الذكي — كيف يعمل

عند الضغط على "🔍 OCR Asset":
1. الصورة تُرسل إلى `/api/ocr` كـ base64
2. الـ API يستخدم `z-ai-web-dev-sdk` لاستدعاء Vision Language Model
3. الـ VLM يحلل الصورة (يفهم النص العربي والإنجليزي، يصحح الميلان، يتجاهل الباركود)
4. يستخرج رقم Asset (نمط `EX91X + 8 أرقام`)
5. يُرجع النتيجة للتطبيق

**ملاحظة:** يتطلب OCR الذكي اتصال إنترنت. باقي الميزات تعمل أوفلاين.

## 🔒 الخصوصية

- كل بيانات الفحص محفوظة محلياً على جهازك (IndexedDB)
- الصور تُرسل فقط لـ OCR الذكي (للقراءة) ثم تُحفظ محلياً
- لا تُخزَّن أي بيانات على خوادم Vercel بعد معالجة OCR

## 📞 الدعم

إذا واجهت مشاكل:
1. تأكد أنك على رابط Vercel (ليس GitHub Pages — الأخير لا يدعم API Routes)
2. تأكد أن `z-ai-web-dev-sdk` موجود في `package.json`
3. راجع logs من Vercel Dashboard → Deployments → Click on deployment → Logs

## 📝 الرخصة

هذا المشروع للاستخدام الشخصي/الداخلي.
