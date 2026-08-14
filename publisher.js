// 🌟 السحر هنا: حل مشكلة اختفاء المتصفح من السيرفر نهائياً (الحقن وقت التشغيل)
process.env.PLAYWRIGHT_BROWSERS_PATH = '/tmp/pw-browsers';
const { execSync } = require('child_process');
try {
    console.log("🚀 [النظام] جاري تجهيز المتصفح في مسار آمن لتجاوز أخطاء مسح Railway...");
    execSync('npx playwright install chromium', { stdio: 'inherit' });
    console.log("✅ [النظام] المتصفح جاهز ومحمي من الحذف 100%!");
} catch (e) {
    console.log("⚠️ [النظام] تنبيه أثناء تجهيز المتصفح:", e.message);
}

// -------------------------------------------------------------------------

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
 
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// 🌟 تخصيص رقم الحساب والسيرفر الثاني (الافتراضي: 2)
const ACCOUNT_NUM = process.env.ACCOUNT_NUMBER || '2';
const COOKIE_FILE = fs.existsSync(`./cookies${ACCOUNT_NUM}.json`) ? `./cookies${ACCOUNT_NUM}.json` : './cookies2.json';
const ACCOUNT_NAME = `الحساب (${ACCOUNT_NUM})`;
const BOT_DB_NAME = `bot${ACCOUNT_NUM}`; // 🟢 استخراج اسم البوت (bot2) لمطابقة جداول اللوحة

// -------------------------------------------------------------------------
// 🔗 دوال الربط بلوحة التحكم المركزية 🟢 
// -------------------------------------------------------------------------

async function getBotStatus() {
    const { data, error } = await supabase
        .from('bot_counters')
        .select('status')
        .eq('bot_name', BOT_DB_NAME)
        .single();
    if (error || !data || !data.status) return 'IDLE'; 
    return data.status.toUpperCase();
}

async function updateBotLastActive(forceStatus = null) {
    const updateData = { bot_name: BOT_DB_NAME, last_active: new Date() };
    if (forceStatus) updateData.status = forceStatus;
    
    await supabase.from('bot_counters').upsert(updateData, { onConflict: 'bot_name' });
}

// 🟢 حارس الحد اليومي (15 مجموعة كحد أقصى)
async function checkDailyLimit() {
    try {
        const { data, error } = await supabase
            .from('bot_counters')
            .select('daily_count')
            .eq('bot_name', BOT_DB_NAME)
            .single();
        if (data && data.daily_count >= 15) {
            return true;
        }
    } catch(e) {}
    return false;
}

async function incrementBotCounters() {
    try {
        const { data, error } = await supabase.from('bot_counters').select('daily_count, total_count').eq('bot_name', BOT_DB_NAME).single();
        let daily = (data && data.daily_count) ? data.daily_count : 0;
        let total = (data && data.total_count) ? data.total_count : 0;
        
        const newDaily = daily + 1;
        const newTotal = total + 1;
        const targetStatus = newDaily >= 15 ? 'IDLE' : 'RUNNING';

        await supabase.from('bot_counters').upsert({
            bot_name: BOT_DB_NAME,
            daily_count: newDaily,
            total_count: newTotal,
            last_active: new Date(),
            status: targetStatus
        }, { onConflict: 'bot_name' });
    } catch(e) {}
}

// 🟢 إرسال سجل النشر المباشر مع اعتماد النص المعدل بواسطة جوجل AI حصراً في حقل ad_title
async function logPublishEvent(post, groupName, statusMsg, aiModifiedText = null) {
    try {
        await supabase.from('bot_publish_logs').insert([{
            bot_name: BOT_DB_NAME,
            ad_id: post.id ? post.id.toString() : 'Unknown',
            ad_title: aiModifiedText || post.ai_final_text2 || post.ai_final_text || post.ad_title || 'بدون عنوان',
            group_name: groupName,
            status: statusMsg, // SUCCESS أو FAILED
            published_at: new Date()
        }]);
    } catch(e) {}
}
// -------------------------------------------------------------------------

// 🧠 0. دالة حساب استهلاك الذاكرة (RAM Tracker)
function getMemoryLog() {
    const memory = process.memoryUsage();
    const rssMB = (memory.rss / 1024 / 1024).toFixed(1);
    const heapMB = (memory.heapUsed / 1024 / 1024).toFixed(1);
    return `📊 [RAM: ${rssMB} MB | Heap: ${heapMB} MB]`;
}

// 🌟 1. تشغيل سيرفر ويب خفيف لمنع الخمول
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send(`🚀 FB Bot Dedicated Instance - ${ACCOUNT_NAME} is running 24/7!`));

// زر طوارئ: لإعادة تشغيل السيرفر وتفريغ الذاكرة فوراً يدوياً عند الحاجة
app.get('/restart-bot', async (req, res) => {
    await logToDashboard(`🚨 [${ACCOUNT_NAME}] تم طلب إعادة التشغيل يدوياً من المطور!`, 'error');
    res.send(`🔄 جاري إعادة تشغيل السيرفر والبوت الخاص بـ ${ACCOUNT_NAME}...`);
    process.exit(1); 
});

app.listen(PORT, () => {
    console.log(`🌐 Web Server active on port ${PORT} for ${ACCOUNT_NAME}`);
    
    // 🌟 2. دالة التنبيه (Self-Ping) تعمل في الخلفية بشكل مستقل لمنع خمول السيرفر
    setInterval(async () => {
        try {
            const myServerUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`; 
            await axios.get(myServerUrl);
            await logToDashboard(`⏰ [Self-Ping] [${ACCOUNT_NAME}] تم تنبيه السيرفر بنجاح للحفاظ عليه مستيقظاً.`, 'info');
            
            // 🟢 إرسال نبضة للوحة التحكم ليعلم النظام أن السيرفر حي
            await updateBotLastActive();
        } catch (e) {
            console.log(`⚠️ [Self-Ping] [${ACCOUNT_NAME}] فشل إرسال تنبيه الاستيقاظ:`, e.message);
        }
    }, 300000); // تنبيه كل 5 دقائق
});
 
const supabase = createClient(
    'https://bmsfhqmsovicpgxxwsgi.supabase.co',
    'sb_publishable_l1IbZF35GnYYS8PamVX_kg_nTv_uyef'
);

const TEMP_DIR = './temp';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 🟢 دالة نوم ذكية تفحص أمر الإيقاف (IDLE) كل 5 ثوانٍ أثناء أي فترة انتظار لمنع التعليق
async function smartSleep(ms) {
    const checkInterval = 5000; 
    let elapsed = 0;
    
    while (elapsed < ms) {
        let currentStatus = await getBotStatus();
        if (currentStatus === 'IDLE') {
            throw new Error('STOPPED_BY_USER');
        }
        await sleep(checkInterval);
        elapsed += checkInterval;
    }
}

function randomDelay(minSeconds, maxSeconds) {
    const min = minSeconds * 1000;
    const max = maxSeconds * 1000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 🤖 دالة إعادة صياغة الإعلان
async function rewriteAdWithAI(title, description) {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    
    if (!apiKey) {
        await logToDashboard(`⚠️ [AI] لم يتم العثور على مفتاح GEMINI_API_KEY في متغيرات البيئة.`, 'info');
        return `${title}\n\n${description}`;
    }

    const promptText = `أنت خبير تسويق إلكتروني. قم بإعادة صياغة هذا الإعلان بأسلوب جذاب، جديد، ومختلف تماماً مع الحفاظ على نفس الفكرة والمعلومات الأساسية والروابط إن وجدت. اجعل العبارات طبيعية وغير مكررة.
العنوان الاصلي: ${title}
الوصف الاصلي: ${description}

أعطني النتيجة مباشرة بالتنسيق التالي:
العنوان: [العنوان الجديد]
الوصف: [الوصف الجديد]`;

    try {
        const modelsResponse = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const validModels = (modelsResponse.data.models || []).filter(m => 
            m.supportedGenerationMethods && 
            m.supportedGenerationMethods.includes('generateContent') &&
            m.name.includes('gemini')
        );

        if (validModels.length === 0) {
            await logToDashboard(`⚠️ [AI] مفتاحك لا يحتوي على أي نماذج تدعم توليد النصوص حالياً.`, 'info');
            return `${title}\n\n${description}`;
        }

        for (const modelObj of validModels) {
            const exactModelName = modelObj.name;
            
            try {
                await logToDashboard(`🧠 [AI] جاري محاولة الاتصال بالنموذج: ${exactModelName}...`, 'info');

                const response = await axios({
                    method: 'post',
                    url: `https://generativelanguage.googleapis.com/v1beta/${exactModelName}:generateContent?key=${apiKey}`,
                    headers: { 'Content-Type': 'application/json' },
                    data: { contents: [{ parts: [{ text: promptText }] }] },
                    timeout: 60000
                });

                const aiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (aiText) {
                    await logToDashboard(`✨ [AI] تم إعادة صياغة الإعلان بنجاح بواسطة (${exactModelName})!`, 'success');
                    return aiText.replace(/العنوان:/g, '').replace(/الوصف:/g, '').trim();
                }
            } catch (e) {
                const errorMessage = e.response?.data?.error?.message || e.message;
                console.error(`⚠️ [AI Error - ${exactModelName}]: ${errorMessage}`);
                continue;
            }
        }
    } catch (e) {
        console.error(`⚠️ [AI API Error]: فشل جلب قائمة النماذج. السبب: ${e.message}`);
    }

    await logToDashboard(`⚠️ [AI] تعذر إعادة الصياغة بالذكاء الاصطناعي بعد تجربة كل النماذج، سيتم استخدام النص الأصلي.`, 'info');
    return `${title}\n\n${description}`;
}

async function logToDashboard(message, type = 'info') {
    const ramInfo = getMemoryLog();
    const fullMessage = `${message} | ${ramInfo}`;

    if (type === 'error') console.error(`❌ [ERROR] ${fullMessage}`);
    else if (type === 'success') console.log(`✅ [SUCCESS] ${fullMessage}`);
    else console.log(`📢 [INFO] ${fullMessage}`);

    try {
        await supabase.from('bot_logs').insert([{ message: fullMessage, log_type: type }]);
    } catch (e) {}
}

// 🤖 دالة تحميل الملفات (معدلة لضمان عدم تحويل الفيديو إلى صورة)
async function downloadImage(imageUrl, isVideo = false) {
    if (!imageUrl) return null;
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
    
    // 💡 السر هنا: إذا كان المصدر هو حقل ad_video، الامتداد سيكون .mp4 حصراً
    let ext = isVideo ? '.mp4' : '.jpg';
    
    const lowerUrl = imageUrl.toLowerCase();
    if (lowerUrl.includes('.mov')) ext = '.mov';
    else if (!isVideo && lowerUrl.includes('.png')) ext = '.png';
    else if (!isVideo && (lowerUrl.includes('.webp') || lowerUrl.includes('f-webp'))) ext = '.webp';

    const imagePath = path.join(TEMP_DIR, `ad-media-${Date.now()}${ext}`);
    
    const response = await axios({
        url: imageUrl,
        method: 'GET',
        responseType: 'stream'
    });
    
    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(imagePath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
    
    return imagePath;
}

async function resetStuckPosts() {
    await logToDashboard(`🔄 [${ACCOUNT_NAME}] جاري فحص وتصفير حقول البوت الثاني المتبقية (bot2_group)...`, 'info');
    const { error } = await supabase
        .from('publish_queue')
        // 🟢 التعديل: تصفير حالة البوت الثاني أيضاً (bot2_status)
        .update({ bot2_group: null, ai_final_text2: null, bot2_status: null })
        .not('bot2_group', 'is', null);

    if (error) {
        await logToDashboard(`⚠️ [${ACCOUNT_NAME}] تنبيه أثناء تصفير الحقول المؤقتة: ${error.message}`, 'info');
    } else {
        await logToDashboard(`✅ [${ACCOUNT_NAME}] تم تنظيف الطابور وتصفير نصوص القروبات المؤقتة للبوت الثاني.`, 'success');
    }
}

async function cleanOldLogs() {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    
    const { error } = await supabase
        .from('bot_logs')
        .delete()
        .lt('created_at', threeDaysAgo);

    if (!error) {
        await logToDashboard(`🧹 [Auto-Cleanup] [${ACCOUNT_NAME}] تم تنظيف السجلات القديمة من قاعدة البيانات للحفاظ على المساحة.`, 'info');
    }
}

// 🔥 الجلب الذكي للبوت الثاني: يعتمد على عمود المجموعات الرئيسي (groups_json) فقط
async function getNextPendingPost() {
    const { data, error } = await supabase
        .from('publish_queue')
        .select('*')
        .order('created_at', { ascending: true });

    if (error) {
        await logToDashboard(`❌ [${ACCOUNT_NAME}] خطأ في جلب الطلب: ${error.message}`, 'error');
        return null;
    }

    if (data && data.length > 0) {
        for (const post of data) {
            let groups = [];
            try { groups = JSON.parse(post.groups_json || '[]'); } catch(e) {}
            // الاعتماد فقط على وجود مجموعات متبقية، وأن البوت لم يكمل هذا الإعلان بعد
            if (groups.length > 0 && post.bot2_status !== 'COMPLETED') {
                return post; 
            }
        }
    }
    return null;
}

// 🟢 التعديل الدقيق لحماية العمود الرئيسي: التحديث هنا يطال bot2_status الخاص البوت الثاني فقط
async function updatePostStatus(id, status, extra = {}) {
    const { error } = await supabase
        .from('publish_queue')
        .update({ bot2_status: status, ...extra }) // 🟢 استخدام bot2_status
        .eq('id', id);
    if (error) await logToDashboard(`⚠️ [${ACCOUNT_NAME}] خطأ تحديث الحالة: ${error.message}`, 'error');
}

async function openPostBox(page) {
    await logToDashboard(`⏳ [${ACCOUNT_NAME}] إعطاء فيسبوك مهلة لبناء الأزرار ومربع النشر...`, 'info');
    // زيادة وقت بناء الصفحة الأولي ليكون بين 15 إلى 25 ثانية
    const app_sleep_time = randomDelay(15, 25);
    await smartSleep(app_sleep_time); 

    const discussionTabs = [
        'div[role="tab"]:has-text("مناقشة")',
        'div[role="tab"]:has-text("Discussion")',
        'a[role="tab"]:has-text("مناقشة")',
        'a[role="tab"]:has-text("Discussion")'
    ];

    for (const tabSel of discussionTabs) {
        try {
            const tabBtn = page.locator(tabSel).first();
            if (await tabBtn.count() > 0 && await tabBtn.isVisible()) {
                await tabBtn.click({ timeout: 4000, force: true });
                await logToDashboard(`🔄 [${ACCOUNT_NAME}] تم التبديل لتبويب (مناقشة)...`, 'info');
                await smartSleep(randomDelay(12, 18)); 
                break;
            }
        } catch (e) {}
    }

    const selectors = [
        'span:has-text("اكتب شيئًا...")',
        'span:has-text("Write something...")',
        'text="اكتب شيئًا..."',
        'text="Write something..."',
        'text="بم تفكر؟"',
        'text="What\'s on your mind?"',
        'text="إنشاء منشور عام..."',
        'text="Create a public post..."',
        'div[role="button"]:has-text("اكتب شيئًا...")',
        'div[role="button"]:has-text("Write something...")',
        'div[role="button"]:has-text("بم تفكر؟")',
        'div[role="button"]:has-text("What\'s on your mind?")',
        'div[role="button"]:has-text("إنشاء منشور عام...")',
        'div[role="textbox"]',
        'span:has-text("اكتب شيئاً...")',
        'text="اكتب شيئاً..."',
        'div[role="button"]:has-text("اكتب شيئاً...")',
        'span:has-text("اكتب")',
        'span:has-text("Write")',
        'div[role="button"]:has-text("اكتب")',
        'div[role="button"]:has-text("Write")',
        'div[role="button"]:has-text("بم تفكر")',
        'div[role="button"]:has-text("تفكر")',
        'text=/اكتب/i',
        'text=/تفكر/i',
        'text=/بم تفكر/i'
    ];

    for (const selector of selectors) {
        try {
            const element = page.locator(selector).first();
            if (await element.count() > 0 && await element.isVisible()) {
                await element.click({ timeout: 5000, force: true });
                await logToDashboard(`⏳ [${ACCOUNT_NAME}] تم النقر لفتح نافذة المنشور...`, 'info');
                await smartSleep(randomDelay(12, 18)); 

                const confirmBtns = ['text=موافق', 'text=فهمت', 'text=تم', 'text=Got It', 'text=OK', 'text=متابعة'];
                for (const cBtn of confirmBtns) {
                    try {
                        const btn = page.locator(cBtn).first();
                        if (await btn.count() > 0 && await btn.isVisible()) {
                            await btn.click({ timeout: 3000, force: true });
                            await smartSleep(randomDelay(3, 5));
                        }
                    } catch(e){}
                }

                await logToDashboard(`✅ [${ACCOUNT_NAME}] تم فتح نافذة المنشور عبر المحدد (${selector})`, 'success');
                return true;
            }
        } catch (e) {}
    }

    const discussionBtns = [
        'text=بدء مناقشة', 'text=Start Discussion', 'text=مناقشة', 'text=Discussion',
        'a[href*="/discussion"]', 'div[role="button"]:has-text("مناقشة")'
    ];
    for (const dSel of discussionBtns) {
        try {
            const dBtn = page.locator(dSel).first();
            if (await dBtn.count() > 0 && await dBtn.isVisible()) {
                await dBtn.click({ timeout: 5000, force: true });
                await smartSleep(randomDelay(5, 8));
                return true;
            }
        } catch (e) {}
    }

    try {
        const openedByJS = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('div[role="button"], span, div, a'));
            const target = elements.find(el => {
                const txt = (el.innerText || el.textContent || '').trim();
                return (
                    txt.includes('اكتب شيئًا') || 
                    txt.includes('Write something') || 
                    txt.includes('بم تفكر') || 
                    txt.includes("What's on your mind") ||
                    txt.includes('إنشاء منشور')
                );
            });
            if (target) {
                target.click();
                return true;
            }
            return false;
        });

        if (openedByJS) {
            await logToDashboard(`✅ [${ACCOUNT_NAME}] تم فتح نافذة المنشور بواسطة JS Event Trigger`, 'success');
            await smartSleep(randomDelay(10, 15));
            return true;
        }
    } catch (e) {}

    return false;
}

async function pasteTextWithLines(page, postText) {
    await smartSleep(randomDelay(6, 10)); 

    const targetSelectors = [
        'div[role="dialog"] div[role="textbox"]',
        'div[role="dialog"] [contenteditable="true"]',
        'div[role="dialog"] [aria-label*="اكتب"]',
        'div[role="dialog"] [aria-label*="Write"]',
        'div[role="dialog"] [aria-label*="بم تفكر"]',
        'div[role="dialog"] [aria-label*="What\'s on your mind"]',
        'div[aria-label*="اكتب شيئاً"]',
        'div[aria-label*="Write something"]',
        'div[contenteditable="true"]',
        'div[role="textbox"]'
    ];

    let textbox = null;
    for (const sel of targetSelectors) {
        try {
            const element = page.locator(sel).first();
            if (await element.count() > 0 && await element.isVisible()) {
                textbox = element;
                break;
            }
        } catch (e) {}
    }

    if (textbox) {
        try {
            await textbox.click({ timeout: 5000, force: true });
            await smartSleep(randomDelay(3, 6)); 
            await page.evaluate(async (text) => {
                await navigator.clipboard.writeText(text);
            }, postText);
            await page.keyboard.press('Control+V');
            await logToDashboard(`✅ [${ACCOUNT_NAME}] تم لصق النص مع الحفاظ على الأسطر`, 'success');
            return;
        } catch (err) {
            await logToDashboard(`⚠️ [${ACCOUNT_NAME}] فشل Clipboard، سيتم استخدام التعبئة البديلة insertText...`, 'info');
        }
    }

    try {
        await page.evaluate(() => {
            const activeInput = document.querySelector('div[role="dialog"] div[contenteditable="true"], div[role="dialog"] div[role="textbox"]');
            if (activeInput) {
                activeInput.focus();
                activeInput.click();
            }
        });
        await smartSleep(randomDelay(3, 5));
        await page.keyboard.insertText(postText);
        await logToDashboard(`✅ [${ACCOUNT_NAME}] تم إدخال النص بطريقة البديلة (insertText)`, 'success');
    } catch(e) {
        throw new Error('تعذر العثور على حقل نص صالح للكتابة داخل هذه المجموعة');
    }
}

async function publishToGroup(page, group, post, imagePath) {
    await logToDashboard(`📢 [${ACCOUNT_NAME}] فتح المجموعة: ${group.name} | الرابط: ${group.url}`, 'info');
    
    await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    const loadWait = randomDelay(20, 35);
    await logToDashboard(`⏳ [${ACCOUNT_NAME}] تم تحميل الصفحة، ننتظر ${Math.round(loadWait/1000)} ثانية لاستقرار الصفحة...`, 'info');
    await smartSleep(loadWait); 

    if (page.url().includes('login') || page.url().includes('checkpoint')) {
        throw new Error(`انتهت جلسة تسجيل الدخول أو يوجد Checkpoint لـ ${ACCOUNT_NAME}`);
    }

    const opened = await openPostBox(page);
    if (!opened) throw new Error('لم يتم العثور على مربع النشر (قد تكون الصلاحيات مختلفة)');

    await smartSleep(randomDelay(5, 10)); 

    // 1️⃣ رفع الصورة ومعاينتها
    if (imagePath) {
        const imageTriggerSelectors = [
            'div[aria-label="صورة/فيديو"]',
            'div[aria-label="Photo/video"]',
            'svg[aria-label="صورة/فيديو"]',
            'svg[aria-label="Photo/video"]',
            'div:has-text("صورة/فيديو")',
            'div:has-text("Photo/video")',
            'div[role="button"]:has(input[type="file"])'
        ];

        for (const trigSel of imageTriggerSelectors) {
            try {
                const trigElement = page.locator(trigSel).first();
                if (await trigElement.count() > 0 && await trigElement.isVisible()) {
                    await trigElement.click({ timeout: 5000 }); 
                    await smartSleep(randomDelay(4, 7)); 
                    break;
                }
            } catch (e) {}
        }

        let isFileInjected = false;
        try {
            const dialogFileInput = page.locator('div[role="dialog"] input[type="file"]').first();
            if (await dialogFileInput.count() > 0) {
                await dialogFileInput.setInputFiles(imagePath);
                isFileInjected = true;
            } else {
                const allFileInputs = page.locator('input[type="file"]');
                const count = await allFileInputs.count();
                if (count > 0) {
                    await allFileInputs.nth(count - 1).setInputFiles(imagePath);
                    isFileInjected = true;
                }
            }
        } catch (e) {}

        if (isFileInjected) {
            const isVideoFile = imagePath.endsWith('.mp4') || imagePath.endsWith('.mov');
            const waitTime = isVideoFile ? 65000 : 35000;
            
            await logToDashboard(`🖼️ [${ACCOUNT_NAME}] تم إدراج الملف، ننتظر ${waitTime/1000} ثانية لرفع الملف وبدء الاستقرار...`, 'success');
            await smartSleep(waitTime);
            
            try {
                await page.waitForSelector('img[src*="blob:"], video, [aria-label*="إزالة"], [aria-label*="Remove"]', { timeout: 25000 });
                await logToDashboard(`✅ [${ACCOUNT_NAME}] ظهرت معاينة المرفق بنجاح في المنشور`, 'success');
            } catch (e) {
                await logToDashboard(`⚠️ [${ACCOUNT_NAME}] استمرار الانتظار لمعاينة المرفق للاحتياط...`, 'info');
            }
            
            const extraWait = randomDelay(20, 30);
            await logToDashboard(`⏳ [${ACCOUNT_NAME}] ننتظر ${Math.round(extraWait/1000)} ثانية إضافية لاستقرار المعاينة...`, 'info');
            await smartSleep(extraWait); 
        } else {
            await logToDashboard(`⚠️ [${ACCOUNT_NAME}] تعذر العثور على حقل الـ input الصحيح للرفع`, 'error');
        }
    }
    
    await smartSleep(randomDelay(6, 10)); 

    let postText = post.ai_final_text2 || post.ai_final_text || '';
    
    if (!postText || postText.trim() === '') {
        await logToDashboard(`🧠 [AI] جاري صياغة نص جديد للبوت الثاني خصيصاً لمجموعة: ${group.name}...`, 'info');
        const aiGeneratedContent = await rewriteAdWithAI(post.ad_title, post.ad_description);
        postText = `${aiGeneratedContent}\n\n🔥 إعلان جديد على سوق الإعلانات الحديث`;

        let fbUrl = post.facebook_url || '';
        if (fbUrl.trim() !== '') {
            postText += `\n\n${fbUrl.trim()}`;
        }
        
        try {
            await supabase.from('publish_queue').update({ ai_final_text2: postText }).eq('id', post.id);
        } catch(e) {}
    } else {
        await logToDashboard(`📌 [Supabase] تم جلب النص الجاهز للبوت الثاني.`, 'success');
    }

    await logToDashboard(`📝 [Text] النص النهائي الذي سيتم لصقه:\n${postText}`, 'info');

    await pasteTextWithLines(page, postText);
    
    await page.keyboard.press('Space');
    await smartSleep(500);
    await page.keyboard.press('Backspace');
    await smartSleep(1000);

    let fbUrlCheck = post.facebook_url || '';
    if (fbUrlCheck.trim() !== '' || postText.includes('facebook.com')) {
        const linkWait = randomDelay(30, 45);
        await logToDashboard(`⏳ [${ACCOUNT_NAME}] تم إدراج رابط، ننتظر ${Math.round(linkWait/1000)} ثانية ليتفاعل النظام وتظهر المعاينة...`, 'info');
        await smartSleep(linkWait);
    } else {
        const textWait = randomDelay(20, 30);
        await logToDashboard(`⏳ [${ACCOUNT_NAME}] تم لصق النص، ننتظر ${Math.round(textWait/1000)} ثانية...`, 'info');
        await smartSleep(textWait); 
    }
    
    await smartSleep(randomDelay(7, 12)); 

    const publishButtons = [
        'div[role="dialog"] div[role="button"][aria-label="نشر"]',
        'div[role="dialog"] div[role="button"][aria-label="Post"]',
        'div[role="dialog"] div[role="button"]:has-text("نشر")',
        'div[role="dialog"] div[role="button"]:has-text("Post")',
        'div[aria-label="نشر"]',
        'div[aria-label="Post"]',
        'text=نشر', 'text=Post', 'text=Publish'
    ];

    let published = false;
    for (const btn of publishButtons) {
        try {
            const button = page.locator(btn).first();
            if (await button.count() > 0 && await button.isVisible()) {
                let isDisabled = await button.getAttribute('aria-disabled');
                let retries = 0;
                while (isDisabled === 'true' && retries < 6) { 
                    await logToDashboard(`⏳ [${ACCOUNT_NAME}] زر النشر غير مفعل (رمادي)، ننتظر معالجة فيسبوك... (محاولة ${retries + 1}/6)`, 'info');
                    await smartSleep(5000);
                    isDisabled = await button.getAttribute('aria-disabled');
                    retries++;
                }

                if (isDisabled === 'true') {
                    throw new Error('زر النشر استمر معطلاً (رمادي) لفترة طويلة، قد يكون هناك نقص في الحقول أو مشكلة في الملف.');
                }

                await button.click({ timeout: 10000 });
                published = true;
                await logToDashboard(`🚀 [${ACCOUNT_NAME}] تم النقر على زر النشر بطريقة شرعية!`, 'success');
                break;
            }
        } catch (e) {
            if (e.message.includes('زر النشر استمر معطلاً')) {
                throw e; 
            }
        }
    }

    if (!published) throw new Error('فشل العثور على زر النشر، أو أن الزر غير موجود بالصفحة.');
    
    await logToDashboard(`⏳ [${ACCOUNT_NAME}] انتظار إغلاق نافذة النشر من قبل فيسبوك لتأكيد وصول المنشور...`, 'info');
    try {
        await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 60000 });
        await logToDashboard(`✅ [${ACCOUNT_NAME}] اختفت نافذة النشر بنجاح! المنشور الآن في المجموعة.`, 'success');
    } catch (e) {
        throw new Error('تم النقر على النشر لكن نافذة فيسبوك لم تُغلق!');
    }

    let isUploadedVideo = imagePath && (imagePath.endsWith('.mp4') || imagePath.endsWith('.mov'));
    let finalWait = isUploadedVideo ? 15000 : 10000;
    await smartSleep(finalWait); 
}

async function processOnePost(post) {
    await logToDashboard(`🔥 [${ACCOUNT_NAME}] بدأ معالجة الإعلان: ${post.ad_title}`, 'info');
    
    await updatePostStatus(post.id, 'RUNNING', { started_at: new Date() });
    await updateBotLastActive('RUNNING');

    let mediaUrl = '';
    let isVideoPost = false; 

    if (post.ad_video && post.ad_video.trim() !== '') {
        mediaUrl = post.ad_video.trim();
        isVideoPost = true; 
        await logToDashboard(`🎥 [${ACCOUNT_NAME}] تم رصد رابط فيديو في السوبيس (ad_video): ${mediaUrl}`, 'info');
    } else if (post.ad_image && post.ad_image.trim() !== '') {
        mediaUrl = post.ad_image.trim();
        await logToDashboard(`📸 [${ACCOUNT_NAME}] تم رصد رابط صورة في السوبيس (ad_image): ${mediaUrl}`, 'info');
    }

    let imagePath = null;
    if (mediaUrl !== '') {
        try {
            imagePath = await downloadImage(mediaUrl, isVideoPost);
            if (imagePath) await logToDashboard(`🖼️ [${ACCOUNT_NAME}] تم تحميل الملف بنجاح: ${imagePath}`, 'success');
        } catch (err) {
            await logToDashboard(`⚠️ [${ACCOUNT_NAME}] فشل تحميل الملف، سيتم النشر كنص فقط: ${err.message}`, 'info');
        }
    } else {
        await logToDashboard(`ℹ️ [${ACCOUNT_NAME}] الإعلان لا يحتوي على ملف مرفوع. سيعتمد النشر على النص والروابط فقط.`, 'info');
    }

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-service-autorun',
            '--password-store=basic',
            '--single-process',
            '--js-flags="--max-old-space-size=128"',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--mute-audio',
            '--no-zygote',
            '--disable-accelerated-video-decode',
            '--disable-infobars',
            '--hide-scrollbars'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        permissions: ['clipboard-read', 'clipboard-write']
    });

    await context.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['font', 'stylesheet', 'media'].includes(resourceType)) {
            return route.abort();
        }
        return route.continue();
    });

    if (fs.existsSync(COOKIE_FILE)) {
        try {
            await logToDashboard(`🍪 [${ACCOUNT_NAME}] جاري قراءة وتنسيق الكوكيز للحساب السحابي (${COOKIE_FILE})...`, 'info');
            const cookiesString = fs.readFileSync(COOKIE_FILE, 'utf8');
            let rawCookies = JSON.parse(cookiesString);
            
            const formattedCookies = rawCookies.map(cookie => {
                const c = { ...cookie };
                if (typeof c.sameSite === 'string') {
                    const lower = c.sameSite.toLowerCase();
                    if (lower === 'lax') c.sameSite = 'Lax';
                    else if (lower === 'strict') c.sameSite = 'Strict';
                    else if (lower === 'none' || lower === 'no_restriction') c.sameSite = 'None';
                    else delete c.sameSite;
                } else delete c.sameSite;

                if (c.expirationDate && !c.expires) c.expires = c.expirationDate;
                delete c.id; delete c.storeId; delete c.hostOnly;
                return c;
            });

            await context.addCookies(formattedCookies);
            await logToDashboard(`✅ [${ACCOUNT_NAME}] تم حقن الكوكيز بنجاح وتأمين الجلسة!`, 'success');
        } catch (e) {
            await logToDashboard(`❌ [${ACCOUNT_NAME}] خطأ في معالجة الكوكيز: ${e.message}`, 'error');
        }
    } else {
        await logToDashboard(`⚠️ تنبيه: ملف الكوكيز (${COOKIE_FILE}) غير موجود.`, 'info');
    }

    let successCount = post.success_count || 0;
    let failedCount = post.failed_count || 0;
    
    let failedGroups = [];
    try {
        if (post.error_message && post.error_message.trim() !== '' && post.error_message !== 'null') {
            const parsedError = JSON.parse(post.error_message);
            if (Array.isArray(parsedError)) {
                failedGroups = parsedError;
            }
        }
    } catch (e) {}

    let remainingGroups = [];

    try {
        while (true) {
            
            // 🛑 1. فحص الحد اليومي (15 مجموعة)
            const limitReached = await checkDailyLimit();
            if (limitReached) {
                await logToDashboard(`🛑 [${ACCOUNT_NAME}] تم الوصول للحد الأقصى اليومي (15 مجموعة). جاري إيقاف البوت وتحويله إلى IDLE...`, 'error');
                await updateBotLastActive('IDLE');
                break;
            }

            // 🛑 2. الاستشعار الديناميكي لحالة اللوحة (IDLE) قبل كل مجموعة
            let currentStatus = await getBotStatus();
            if (currentStatus === 'IDLE') {
                await logToDashboard(`🛑 [${ACCOUNT_NAME}] تم رصد أمر إيقاف (IDLE) من اللوحة، جاري الانسحاب...`, 'info');
                break;
            }

            const { data: freshPost, error: fetchErr } = await supabase
                .from('publish_queue')
                .select('*')
                .eq('id', post.id)
                .single();

            if (fetchErr || !freshPost) break;

            try { 
                remainingGroups = JSON.parse(freshPost.groups_json || '[]'); 
            } catch {
                remainingGroups = [];
            }

            if (remainingGroups.length === 0) {
                await logToDashboard(`✅ [${ACCOUNT_NAME}] انتهت جميع المجموعات لهذا الإعلان.`, 'success');
                break;
            }

            const targetGroup = remainingGroups[0];
            const newRemaining = remainingGroups.slice(1);

            const updatePayload = {
                groups_json: JSON.stringify(newRemaining)
            };
            try { updatePayload.bot2_group = JSON.stringify(targetGroup); } catch(e) {}

            const { error: updateErr } = await supabase
                .from('publish_queue')
                .update(updatePayload)
                .eq('id', post.id);

            if (updateErr) {
                await smartSleep(1000);
                continue;
            }

            await logToDashboard(`🎯 [${ACCOUNT_NAME}] تم سحب المجموعة (${targetGroup.name}) الخاصة بـ البوت 2 وحذفها من الطابور لضمان التوازي.`, 'success');

            const page = await context.newPage();
            
            page.on('dialog', async dialog => {
                try { await dialog.accept(); } catch(e) {}
            });

            try {
                const publishTask = publishToGroup(page, targetGroup, freshPost, imagePath);
                const timeoutTask = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('تجمّد مفاجئ أثناء معالجة الصفحة (Timeout)')), 360000)
                );

                await Promise.race([publishTask, timeoutTask]);
                successCount++;
                
                // جلب أحدث بيانات الإعلان لضمان توفر النص المعدل بالـ AI لتسجيله في ad_title في جدول bot_publish_logs
                const { data: latestPost } = await supabase.from('publish_queue').select('*').eq('id', post.id).single();
                let finalAiText = latestPost?.ai_final_text2 || latestPost?.ai_final_text || freshPost.ai_final_text2 || freshPost.ai_final_text || freshPost.ad_title;
                
                await logPublishEvent(latestPost || freshPost, targetGroup.name, 'SUCCESS', finalAiText);
                await incrementBotCounters();

            } catch (err) {
                if (err.message === 'STOPPED_BY_USER') {
                    await page.close();
                    break;
                }

                const isCheckpoint = err.message.includes('Checkpoint') || err.message.includes('تسجيل الدخول') || err.message.includes('login');
                if (isCheckpoint) {
                    await logToDashboard(`🚨 [خطر] تم رصد تشيك بوينت! جاري إيقاف السيرفر لحماية الحساب...`, 'error');
                    process.exit(0);
                }

                failedCount++;
                failedGroups.push({ name: targetGroup.name, url: targetGroup.url, error: err.message });
                await logToDashboard(`❌ [${ACCOUNT_NAME}] فشل النشر في المجموعة: ${targetGroup.name} | السبب: ${err.message}`, 'error');
                
                const { data: latestPostFail } = await supabase.from('publish_queue').select('*').eq('id', post.id).single();
                let finalAiTextFail = latestPostFail?.ai_final_text2 || latestPostFail?.ai_final_text || freshPost.ai_final_text2 || freshPost.ai_final_text || freshPost.ad_title;
                
                await logPublishEvent(latestPostFail || freshPost, targetGroup.name, 'FAILED', finalAiTextFail);

            } finally {
                await page.close();
                await logToDashboard(`🧹 [${ACCOUNT_NAME}] تم تدمير صفحة المجموعة.`, 'info');

                const resetPayload = {
                    success_count: successCount,
                    failed_count: failedCount,
                    error_message: JSON.stringify(failedGroups)
                };
                try {
                    resetPayload.bot2_group = null;
                    resetPayload.ai_final_text2 = null;
                } catch(e) {}

                await supabase
                    .from('publish_queue')
                    .update(resetPayload)
                    .eq('id', post.id);
            
                await logToDashboard(`💾 [${ACCOUNT_NAME}] تم حفظ نقطة التوقف وتحديث الإحصائيات والأخطاء.`, 'info');
            }

            const { data: checkData } = await supabase.from('publish_queue').select('groups_json').eq('id', post.id).single();
            let checkRemaining = [];
            try { checkRemaining = JSON.parse(checkData.groups_json || '[]'); } catch(e){}

            if (checkRemaining.length === 0) break;

            // ⚠️ التغيير: الانتظار بين كل مجموعة ومجموعة عبر النوم الذكي المتقطع
            const delay = randomDelay(420, 720); // 7 إلى 12 دقيقة
            await logToDashboard(`⏳ [${ACCOUNT_NAME}] استراحة أمان: انتظار ${Math.round(delay / 1000 / 60)} دقيقة قبل المجموعة التالية...`, 'info');
            try {
                await smartSleep(delay);
            } catch (e) {
                if (e.message === 'STOPPED_BY_USER') break;
            }
        }
    } finally {
        await context.close();
        await browser.close();
        await logToDashboard(`🧹 [${ACCOUNT_NAME}] تم إغلاق المتصفح وتفريغ الذاكرة بنجاح!`, 'success');
    }

    if (imagePath && fs.existsSync(imagePath)) {
        try { fs.unlinkSync(imagePath); } catch {}
    }

    const { data: finalPost } = await supabase.from('publish_queue').select('groups_json').eq('id', post.id).single();
    let finalGroups = [];
    try { finalGroups = JSON.parse(finalPost.groups_json || '[]'); } catch(e){}

    if (finalGroups.length === 0 && failedCount === 0) {
        await updatePostStatus(post.id, 'COMPLETED', { published_at: new Date(), error_message: null });
        await logToDashboard(`✅ [${ACCOUNT_NAME}] تم نشر الإعلان في المجموعات بنجاح.`, 'success');
    } else if (finalGroups.length === 0) {
        await updatePostStatus(post.id, 'FAILED', { error_message: JSON.stringify(failedGroups) });
        await logToDashboard(`❌ [${ACCOUNT_NAME}] اكتملت المجموعات مع وجود إخفاقات مخزنة في الأخطاء. تم تغيير الحالة إلى (FAILED).`, 'error');
    }
}

async function start() {
    await logToDashboard(`🚀 [${ACCOUNT_NAME}] جاري تهيئة بيئة المتصفح السحابي للبوت الثاني...`, 'info');

    await resetStuckPosts();
    await cleanOldLogs();
    setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);

    await logToDashboard(`🚀 [${ACCOUNT_NAME}] البوت جاهز تماماً ومتصل بـ Supabase...`, 'success');

    let idleLogTimer = 0; 

    while (true) {
        // 🛑 1. فحص الحد اليومي (15 مجموعة) أولاً
        const limitReached = await checkDailyLimit();
        if (limitReached) {
            idleLogTimer++;
            if (idleLogTimer >= 10) {
                await logToDashboard(`💤 [${ACCOUNT_NAME}] البوت وصل للحد الأقصى اليومي (15 مجموعة). بانتظار تصفير العداد لليوم التالي...`, 'info');
                idleLogTimer = 0;
            }
            await updateBotLastActive('IDLE');
            await sleep(30000); 
            continue;
        }

        // 🛑 2. فحص مستمر لحالة (IDLE) في وضع الانتظار
        let currentStatus = await getBotStatus();
        
        if (currentStatus === 'IDLE') {
            await updateBotLastActive('IDLE'); 
            idleLogTimer++;
            if (idleLogTimer >= 10) {
                await logToDashboard(`💤 [${ACCOUNT_NAME}] البوت في حالة (IDLE). ننتظر أمر تشغيل من لوحة التحكم...`, 'info');
                idleLogTimer = 0;
            }
            await sleep(30000); 
            continue;
        }

        const post = await getNextPendingPost();
        if (!post) {
            idleLogTimer++;
            if (idleLogTimer >= 10) {
                await logToDashboard(`💤 [${ACCOUNT_NAME}] البوت مستيقظ ويبحث عن إعلانات في الطابور... لا يوجد شيء حالياً.`, 'info');
                idleLogTimer = 0;
            }
            await updateBotLastActive('IDLE');
            await sleep(30000); 
            continue;
        }
        idleLogTimer = 0; 

        await processOnePost(post);

        // الانتظار بين إعلان كامل (بمجموعاته) وإعلان جديد
        const delay = randomDelay(1200, 2400); // 20 إلى 40 دقيقة
        await logToDashboard(`⏳ [${ACCOUNT_NAME}] استراحة الإعلانات الكبرى: انتظار ${Math.round(delay / 1000 / 60)} دقيقة...`, 'info');
        try {
            await smartSleep(delay);
        } catch (e) {
            if (e.message === 'STOPPED_BY_USER') continue;
        }
    }
}

start().catch(async (err) => {
    console.error(err);
    try {
        const emergencySupabase = createClient('https://bmsfhqmsovicpgxxwsgi.supabase.co', 'sb_publishable_l1IbZF35GnYYS8PamVX_kg_nTv_uyef');
        await emergencySupabase.from('bot_logs').insert([{ message: `❌ [${ACCOUNT_NAME}] توقف البوت بسبب خطأ غير متوقع: ${err.message}`, log_type: 'error' }]);
    } catch(e){}
});
