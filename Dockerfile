# استخدام بيئة Node 22 الرسمية والصافية (بدون تعقيدات مسارات مايكروسوفت)
FROM node:22-bookworm

# تحديد مجلد العمل
WORKDIR /app

# نسخ ملفات التعاريف
COPY package*.json ./

# تثبيت المكتبات
RUN npm install

# هذا الأمر السحري ينزل متصفح الكروم مع كل مكتبات لينكس الأساسية المطلوبة له من الصفر وبدون أي تضارب!
RUN npx playwright install --with-deps chromium

# نسخ باقي كود المشروع
COPY . .

# أمر التشغيل الأساسي
CMD ["node", "--expose-gc", "publisher.js"]
