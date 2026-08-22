const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// 🌟 تخصيص رقم الحساب والسيرفر للبوت 1 (الافتراضي: 1 لبوت 1 على Render، أو عبر متغير البيئة)
const ACCOUNT_NUM = (process.env.ACCOUNT_NUMBER || '3').trim();
const COOKIE_FILE = fs.existsSync(`./cookies${ACCOUNT_NUM}.json`) 
    ? `./cookies${ACCOUNT_NUM}.json` 
    : (fs.existsSync('./cookies3.json') ? './cookies3.json' : './cookies.json');
const ACCOUNT_NAME = `الحساب (${ACCOUNT_NUM})`;
const BOT_DB_NAME = `bot${ACCOUNT_NUM}`;
const BOT_GROUP_FIELD = `bot${ACCOUNT_NUM}_group`;
const BOT_STATUS_FIELD = `bot${ACCOUNT_NUM}_status`;
const BOT_AI_FIELD = ACCOUNT_NUM === '1' ? 'ai_final_text1' : `ai_final_text${ACCOUNT_NUM}`;

// -------------------------------------------------------------------------
// 🔗 دوال الربط بلوحة التحكم المركزية 🟢 
// -------------------------------------------------------------------------

const supabase = createClient(
    'https://bmsfhqmsovicpgxxwsgi.supabase.co',
    'sb_publishable_l1IbZF35GnYYS8PamVX_kg_nTv_uyef'
);

const TEMP_DIR = './temp';

async function getBotStatus() {
    try {
        const { data, error } = await supabase
            .from('bot_counters')
            .select('status')
            .eq('bot_name', BOT_DB_NAME)
            .single();
        if (error || !data || !data.status) return 'IDLE'; 
        return data.status.toUpperCase();
    } catch (e) {
        return 'RUNNING'; // في حال حدوث خطأ شبكة عابر لا نوقف البوت فوراً
    }
}

async function updateBotLastActive(forceStatus = null) {
    try {
        const updateData = { bot_name: BOT_DB_NAME, last_active: new Date() };
        if (forceStatus) updateData.status = forceStatus;
        
        await supabase.from('bot_counters').upsert(updateData, { onConflict: 'bot_name' });
    } catch(e) {}
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

// 🟢 إرسال سجل النشر المباشر
async function logPublishEvent(post, groupName, statusMsg, aiModifiedText = null) {
    try {
        await supabase.from('bot_publish_logs').insert([{
            bot_name: BOT_DB_NAME,
            ad_id: post.id ? post.id.toString() : 'Unknown',
            ad_title: aiModifiedText || post[BOT_AI_FIELD] || post.ai_final_text || post.ad_title || 'بدون عنوان',
            group_name: groupName,
            status: statusMsg,
            published_at: new Date()
        }]);
    } catch(e) {}
}

// 🧠 دالة حساب استهلاك الذاكرة (RAM Tracker)
function getMemoryLog() {
    const memory = process.memoryUsage();
    const rssMB = (memory.rss / 1024 / 1024).toFixed(1);
    const heapMB = (memory.heapUsed / 1024 / 1024).toFixed(1);
    return `📊 [RAM: ${rssMB} MB | Heap: ${heapMB} MB]`;
}

// 🌟 تشغيل سيرفر ويب خفيف لمنع Render من إيقاف الخدمة
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send(`🚀 FB Bot Dedicated Instance - ${ACCOUNT_NAME} is running 24/7 with 10-Step Architecture!`));

app.get('/restart-bot', async (req, res) => {
    await logToDashboard(`🚨 [${ACCOUNT_NAME}] تم طلب إعادة التشغيل يدوياً من المطور!`, 'error');
    res.send(`🔄 جاري إعادة تشغيل السيرفر والبوت الخاص بـ ${ACCOUNT_NAME}...`);
    process.exit(1); 
});

app.listen(PORT, () => {
    console.log(`🌐 Web Server active on port ${PORT} for ${ACCOUNT_NAME}`);
    
    // تنبيه الاستيقاظ الذاتي كل 5 دقائق
    setInterval(async () => {
        try {
            const myServerUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`; 
            await axios.get(myServerUrl, { timeout: 10000 });
            await logToDashboard(`⏰ [Self-Ping] [${ACCOUNT_NAME}] تم تنبيه السيرفر بنجاح للحفاظ عليه مستيقظاً.`, 'info');
            await updateBotLastActive();
        } catch (e) {
            console.log(`⚠️ [Self-Ping] [${ACCOUNT_NAME}] فشل إرسال تنبيه الاستيقاظ:`, e.message);
        }
    }, 300000);
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 🟢 دالة نوم ذكية مع حماية من أخطاء الاتصال
async function smartSleep(ms) {
    const checkInterval = 5000; 
    let elapsed = 0;
    
    while (elapsed < ms) {
        try {
            let currentStatus = await getBotStatus();
            if (currentStatus === 'IDLE') {
                throw new Error('STOPPED_BY_USER');
            }
        } catch (err) {
            if (err.message === 'STOPPED_BY_USER') throw err;
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

// 🤖 دالة إعادة صياغة الإعلان بالذكاء الاصطناعي
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
        const modelsResponse = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, { timeout: 15000 });
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
                    timeout: 45000
                });

                const aiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (aiText) {
                    await logToDashboard(`✨ [AI] تم إعادة صياغة الإعلان بنجاح بواسطة (${exactModelName})!`, 'success');
                    return aiText.replace(/العنوان:/g, '').replace(/الوصف:/g, '').trim();
                }
            } catch (e) {
                continue;
            }
        }
    } catch (e) {}

    await logToDashboard(`⚠️ [AI] تعذر إعادة الصياغة بالذكاء الاصطناعي، سيتم استخدام النص الأصلي.`, 'info');
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

// 🤖 دالة تحميل الملفات
async function downloadImage(imageUrl, isVideo = false) {
    if (!imageUrl) return null;
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
    
    let ext = isVideo ? '.mp4' : '.jpg';
    const lowerUrl = imageUrl.toLowerCase();
    
    if (lowerUrl.includes('.mov')) ext = '.mov';
    else if (lowerUrl.includes('.webm')) ext = '.webm';
    else if (lowerUrl.includes('.mkv')) ext = '.mkv';
    else if (lowerUrl.includes('.avi')) ext = '.avi';
    else if (lowerUrl.includes('.mp4')) ext = '.mp4';
    else if (!isVideo && lowerUrl.includes('.png')) ext = '.png';
    else if (!isVideo && (lowerUrl.includes('.webp') || lowerUrl.includes('f-webp'))) ext = '.webp';

    const imagePath = path.join(TEMP_DIR, `ad-media-${Date.now()}${ext}`);
    
    const response = await axios({
        url: imageUrl,
        method: 'GET',
        responseType: 'stream',
        timeout: 120000
    });
    
    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(imagePath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
    
    return imagePath;
}

// 🔄 تصفير الحقول المعلقة الخاصة بهذا البوت فقط لعدم الإضرار بالبوتات الأخرى
async function resetStuckPosts() {
    await logToDashboard(`🔄 [${ACCOUNT_NAME}] جاري فحص وتصفير حقول البوت المتبقية (${BOT_GROUP_FIELD})...`, 'info');
    const updateObj = {};
    updateObj[BOT_GROUP_FIELD] = null;
    updateObj[BOT_STATUS_FIELD] = null;
    updateObj[BOT_AI_FIELD] = null;

    const { error } = await supabase
        .from('publish_queue')
        .update(updateObj)
        .not(BOT_GROUP_FIELD, 'is', null);

    if (error) {
        await logToDashboard(`⚠️ [${ACCOUNT_NAME}] تنبيه أثناء تصفير الحقول المؤقتة: ${error.message}`, 'info');
    } else {
        await logToDashboard(`✅ [${ACCOUNT_NAME}] تم تنظيف الطابور وتصفير نصوص القروبات المؤقتة للبوت.`, 'success');
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

// 🔥 الجلب الذكي للمنشور التالي
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
            if (groups.length > 0 && post[BOT_STATUS_FIELD] !== 'COMPLETED' && post.status !== 'COMPLETED') {
                return post; 
            }
        }
    }
    return null;
}

async function updatePostStatus(id, status, extra = {}) {
    const updatePayload = { ...extra };
    updatePayload[BOT_STATUS_FIELD] = status;

    const { error } = await supabase
        .from('publish_queue')
        .update(updatePayload) 
        .eq('id', id);
    if (error) await logToDashboard(`⚠️ [${ACCOUNT_NAME}] خطأ تحديث الحالة: ${error.message}`, 'error');
}

// -------------------------------------------------------------------------
// 🚀 تنفيذ المراحل الـ 10 للنشر بالمجموعة مع مراقبة حية للمراحل (Stage Watchdog)
// -------------------------------------------------------------------------

let currentStageInfo = null;
let stageWatchdogInterval = null;

function setStage(stageNumber, description) {
    currentStageInfo = {
        number: stageNumber,
        name: description,
        startedAt: Date.now(),
        lastReportedMinute: 0
    };
    logToDashboard(`⏳ [المرحلة ${stageNumber}] [${ACCOUNT_NAME}] ${description}...`, 'info');
}

function startStageWatchdog() {
    if (stageWatchdogInterval) clearInterval(stageWatchdogInterval);
    stageWatchdogInterval = setInterval(async () => {
        if (!currentStageInfo || !currentStageInfo.number) return;
        const elapsedSec = Math.floor((Date.now() - currentStageInfo.startedAt) / 1000);
        const elapsedMin = Math.floor(elapsedSec / 60);

        // إرسال تنبيه في السجل عند مضي دقيقتين (ثم كل دقيقتين: 2، 4، 6 دقائق) طالما المرحلة مستمرة
        if (elapsedMin >= 2 && elapsedMin % 2 === 0 && currentStageInfo.lastReportedMinute !== elapsedMin) {
            currentStageInfo.lastReportedMinute = elapsedMin;
            await logToDashboard(
                `⏱️ [تنبيه استمرار العمل] [${ACCOUNT_NAME}] البوت لا يزال يعمل ومستمر في [المرحلة ${currentStageInfo.number}: ${currentStageInfo.name}] منذ (${elapsedMin} دقيقة)...`,
                'info'
            );
        }
    }, 10000);
}

function stopStageWatchdog() {
    if (stageWatchdogInterval) {
        clearInterval(stageWatchdogInterval);
        stageWatchdogInterval = null;
    }
    currentStageInfo = null;
}

async function openPostBox(page) {
    // ⏳ المرحلة 3: التبديل لتبويب مناقشة إذا وجد لتخطي واجهة البيع والشراء
    setStage(3, 'فحص التبويبات والتبديل إلى (مناقشة)');
    await smartSleep(randomDelay(15, 25));

    const discussionTabs = [
        'div[role="tab"]:has-text("مناقشة")',
        'div[role="tab"]:has-text("Discussion")',
        'a[role="tab"]:has-text("مناقشة")',
        'a[role="tab"]:has-text("Discussion")',
        'text="عرض المناقشات"',
        'text="مناقشة"',
        'text="Discussion"'
    ];

    for (const tabSel of discussionTabs) {
        try {
            const tabBtn = page.locator(tabSel).first();
            if (await tabBtn.count() > 0 && await tabBtn.isVisible()) {
                await tabBtn.click({ timeout: 8000, force: true });
                await logToDashboard(`🔄 [المرحلة 3] [${ACCOUNT_NAME}] تم التبديل لتبويب (مناقشة)، ننتظر لاستقرار الواجهة...`, 'info');
                await smartSleep(randomDelay(15, 25));
                break;
            }
        } catch (e) {}
    }

    // ⏳ المرحلة 4: استكشاف ونقر مربع فتح المنشور
    setStage(4, 'البحث عن مربع النشر وفتحه');
    await smartSleep(randomDelay(12, 20));

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
                await element.click({ timeout: 10000, force: true });
                await logToDashboard(`⏳ [المرحلة 4] [${ACCOUNT_NAME}] تم النقر لفتح نافذة المنشور، ننتظر لتفتح بهدوء...`, 'info');
                await smartSleep(randomDelay(15, 25));

                const confirmBtns = ['text=موافق', 'text=فهمت', 'text=تم', 'text=Got It', 'text=OK', 'text=متابعة', 'text=أوافق', 'text=Agree', 'text=قبول', 'text=Accept', 'text=إغلاق', 'text=Close', 'text=ليس الآن', 'text=Not Now'];
                for (const cBtn of confirmBtns) {
                    try {
                        const btn = page.locator(cBtn).first();
                        if (await btn.count() > 0 && await btn.isVisible()) {
                            await btn.click({ timeout: 5000, force: true });
                            await smartSleep(randomDelay(3, 6));
                        }
                    } catch(e){}
                }

                await logToDashboard(`✅ [المرحلة 4] [${ACCOUNT_NAME}] تم فتح نافذة المنشور عبر المحدد (${selector}) بنجاح`, 'success');
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
                await dBtn.click({ timeout: 10000, force: true });
                await smartSleep(randomDelay(12, 20));
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
            await logToDashboard(`✅ [المرحلة 4] [${ACCOUNT_NAME}] تم فتح نافذة المنشور بواسطة JS Event Trigger`, 'success');
            await smartSleep(randomDelay(15, 25));
            return true;
        }
    } catch (e) {}

    return false;
}

async function pasteTextWithLines(page, postText) {
    // ⏳ المرحلة 7: التركيز على الحقل ولصق النص بمحاكاة بشرية كاملة
    setStage(7, 'التركيز على الحقل ولصق النص ومحاكاة الكتابة البشرية');
    await smartSleep(randomDelay(10, 18));

    const targetSelectors = [
        'textarea[name="xc_message"]',
        'textarea[data-sigil*="composer"]',
        'textarea',
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
            await textbox.click({ timeout: 10000, force: true });
            await smartSleep(randomDelay(3, 6));

            const tagName = await textbox.evaluate(el => el.tagName.toLowerCase());
            if (tagName === 'textarea' || tagName === 'input') {
                await textbox.fill(postText);
                await logToDashboard(`✅ [المرحلة 7] [${ACCOUNT_NAME}] تم كتابة النص داخل حقل الـ textarea بنجاح`, 'success');
                return;
            }

            await page.evaluate(async (text) => {
                await navigator.clipboard.writeText(text);
            }, postText);
            await page.keyboard.press('Control+V');
            await logToDashboard(`✅ [المرحلة 7] [${ACCOUNT_NAME}] تم لصق النص مع الحفاظ على الأسطر`, 'success');
            return;
        } catch (err) {
            await logToDashboard(`⚠️ [المرحلة 7] [${ACCOUNT_NAME}] فشل Clipboard، سيتم استخدام التعبئة البديلة insertText...`, 'info');
        }
    }

    try {
        await page.evaluate((text) => {
            const activeInput = document.querySelector('textarea, div[contenteditable="true"], div[role="textbox"]');
            if (activeInput) {
                activeInput.focus();
                activeInput.click();
                if (activeInput.tagName.toLowerCase() === 'textarea') {
                    activeInput.value = text;
                    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
                    activeInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }, postText);
        await smartSleep(randomDelay(3, 6));
        await page.keyboard.insertText(postText);
        await logToDashboard(`✅ [المرحلة 7] [${ACCOUNT_NAME}] تم إدخال النص بطريقة البديلة (insertText)`, 'success');
    } catch(e) {
        throw new Error('تعذر العثور على حقل نص صالح للكتابة داخل هذه المجموعة');
    }
}

async function publishToGroup(page, group, post, imagePath) {
    startStageWatchdog();

    try {
        // ⏳ المرحلة 1: فتح المجموعة بوضع الجوال مع فرض تبويب المناقشة
        let targetUrl = group.url || '';
        targetUrl = targetUrl.replace('www.facebook.com', 'm.facebook.com');
        if (!targetUrl.includes('m.facebook.com') && !targetUrl.includes('mbasic.facebook.com')) {
            targetUrl = targetUrl.replace('facebook.com', 'm.facebook.com');
        }
        const separator = targetUrl.includes('?') ? '&' : '?';
        targetUrl = `${targetUrl}${separator}sorting_setting=CHRONOLOGICAL`;

        setStage(1, `فتح صفحة المجموعة بوضع الجوال (${group.name}) واستقرار العناصر`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        
        const loadWait = randomDelay(25, 40);
        await logToDashboard(`⏳ [المرحلة 1] [${ACCOUNT_NAME}] تم تحميل الصفحة، ننتظر ${Math.round(loadWait/1000)} ثانية لاستقرار كل العناصر...`, 'info');
        await smartSleep(loadWait); 

        // ⏳ المرحلة 2: الفحص الأمني للجلسة والـ Checkpoint
        setStage(2, 'الفحص الأمني للجلسة والـ Checkpoint');
        if (page.url().includes('login') || page.url().includes('checkpoint')) {
            throw new Error(`انتهت جلسة تسجيل الدخول أو يوجد Checkpoint لـ ${ACCOUNT_NAME}`);
        }

        // ⏳ المرحلة 3 و 4: تبويب مناقشة وفتح مربع المنشور
        const opened = await openPostBox(page);
        if (!opened) throw new Error('لم يتم العثور على مربع النشر (قد تكون الصلاحيات مختلفة)');

        await smartSleep(randomDelay(8, 15)); 

        // ⏳ المرحلة 6: رفع الميديا والانتظار لاستقرار المعاينة
        if (imagePath) {
            const isVideoFile = imagePath.endsWith('.mp4') || imagePath.endsWith('.mov') || imagePath.endsWith('.webm') || imagePath.endsWith('.mkv') || imagePath.endsWith('.avi');
            setStage(6, `رفع الملف المرفق (${isVideoFile ? 'فيديو' : 'صورة'}) ومعاينة الرفع`);
            
            let isFileInjected = false;

            // محاولة 1: الحقن المباشر في عنصر الـ input لتفادي تعليق نافذة النظام (OS FileChooser)
            try {
                const allFileInputs = page.locator('input[type="file"]');
                const count = await allFileInputs.count();
                if (count > 0) {
                    await allFileInputs.first().setInputFiles(imagePath, { timeout: 20000 });
                    isFileInjected = true;
                    await logToDashboard(`🖼️ [المرحلة 6] [${ACCOUNT_NAME}] تم حقن مسار الملف مباشرة في الـ input بنجاح.`, 'success');
                }
            } catch (e) {}

            // محاولة 2: إذا لم يظهر الـ input إلا بعد نقر زر إضافة صورة/فيديو
            if (!isFileInjected) {
                const imageTriggerSelectors = [
                    'div[aria-label="صورة/فيديو"]',
                    'div[aria-label="Photo/video"]',
                    'svg[aria-label="صورة/فيديو"]',
                    'svg[aria-label="Photo/video"]',
                    'div:has-text("صورة/فيديو")',
                    'div:has-text("Photo/video")',
                    'div[aria-label="صورة/مقطع فيديو"]',
                    'div:has-text("صورة/مقطع فيديو")',
                    'div[role="button"]:has(input[type="file"])'
                ];

                for (const trigSel of imageTriggerSelectors) {
                    try {
                        const trigElement = page.locator(trigSel).first();
                        if (await trigElement.count() > 0 && await trigElement.isVisible()) {
                            const [fileChooser] = await Promise.all([
                                page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
                                trigElement.click({ timeout: 6000, force: true }).catch(() => {})
                            ]);

                            if (fileChooser) {
                                await fileChooser.setFiles(imagePath);
                                isFileInjected = true;
                                await logToDashboard(`🖼️ [المرحلة 6] [${ACCOUNT_NAME}] تم رفع الملف عبر معالج FileChooser بنجاح.`, 'success');
                                break;
                            }

                            await smartSleep(3000);
                            const fileInputAfter = page.locator('input[type="file"]').first();
                            if (await fileInputAfter.count() > 0) {
                                await fileInputAfter.setInputFiles(imagePath, { timeout: 15000 });
                                isFileInjected = true;
                                break;
                            }
                        }
                    } catch (e) {}
                }
            }

            if (isFileInjected) {
                const waitTime = isVideoFile ? 35000 : 20000;
                
                await logToDashboard(`🖼️ [المرحلة 6] [${ACCOUNT_NAME}] تم حقن مسار الملف، ننتظر ${waitTime/1000} ثانية لمعالجة الملف ومعاينته...`, 'success');
                await smartSleep(waitTime);
                
                // فحص تقدم معالجة ورفع الفيديو داخل واجهة فيسبوك
                try {
                    if (isVideoFile) {
                        let uploadCheckRetries = 0;
                        while (uploadCheckRetries < 24) {
                            const isStillUploading = await page.evaluate(() => {
                                const progress = document.querySelector('[role="progressbar"], .progress_bar, div[aria-valuenow]');
                                const bodyText = document.body.innerText || '';
                                return !!progress || bodyText.includes('جاري التحميل') || bodyText.includes('Uploading') || bodyText.includes('جاري معالجة الفيديو') || bodyText.includes('Processing video') || bodyText.includes('قيد المعالجة');
                            });

                            if (!isStillUploading) {
                                await logToDashboard(`✅ [المرحلة 6] [${ACCOUNT_NAME}] اكتملت معالجة ورفع الفيديو في فيسبوك بنجاح!`, 'success');
                                break;
                            }
                            await logToDashboard(`⏳ [المرحلة 6] [${ACCOUNT_NAME}] فيسبوك لا يزال يرفع/يعالج الفيديو... (فحص ${uploadCheckRetries + 1}/24)`, 'info');
                            await smartSleep(5000);
                            uploadCheckRetries++;
                        }
                    }

                    await page.waitForSelector('img[src*="blob:"], video, [aria-label*="إزالة"], [aria-label*="Remove"], [aria-label*="حذف"]', { timeout: 25000 });
                    await logToDashboard(`✅ [المرحلة 6] [${ACCOUNT_NAME}] ظهرت معاينة المرفق بنجاح في المنشور`, 'success');
                } catch (e) {
                    await logToDashboard(`⚠️ [المرحلة 6] [${ACCOUNT_NAME}] استمرار العملية بعد انتظار المعاينة...`, 'info');
                }
                
                const extraWait = randomDelay(8, 15);
                await smartSleep(extraWait); 
            } else {
                await logToDashboard(`⚠️ [المرحلة 6] [${ACCOUNT_NAME}] تعذر العثور على حقل رفع الملفات، سيتم النشر كنص فقط.`, 'info');
            }
        }
        
        await smartSleep(randomDelay(8, 15)); 

        // ⏳ المرحلة 5: تجهيز أو صياغة محتوى الذكاء الاصطناعي
        setStage(5, 'تجهيز وصياغة محتوى الإعلان بالذكاء الاصطناعي');
        let postText = post[BOT_AI_FIELD] || post.ai_final_text || '';
        
        if (!postText || postText.trim() === '') {
            await logToDashboard(`🧠 [المرحلة 5] [AI] صياغة نص جديد بالذكاء الاصطناعي لـ ${ACCOUNT_NAME} لمجموعة: ${group.name}...`, 'info');
            const aiGeneratedContent = await rewriteAdWithAI(post.ad_title, post.ad_description);
            postText = `${aiGeneratedContent}\n\n🔥 إعلان جديد على سوق الإعلانات الحديث`;

            let fbUrl = post.facebook_url || '';
            if (fbUrl.trim() !== '') {
                postText += `\n\n${fbUrl.trim()}`;
            }
            
            try {
                const aiUpdatePayload = {};
                aiUpdatePayload[BOT_AI_FIELD] = postText;
                await supabase.from('publish_queue').update(aiUpdatePayload).eq('id', post.id);
            } catch(e) {}
        } else {
            await logToDashboard(`📌 [المرحلة 5] [Supabase] تم جلب النص الجاهز لـ ${ACCOUNT_NAME}.`, 'success');
        }

        await logToDashboard(`📝 [Text] النص النهائي الذي سيتم لصقه:\n${postText}`, 'info');

        // ⏳ المرحلة 7: لصق النص ومحاكاة الكتابة البشرية
        await pasteTextWithLines(page, postText);
        
        await page.keyboard.press('Space');
        await smartSleep(1000);
        await page.keyboard.press('Backspace');
        await smartSleep(2000);

        // ⏳ المرحلة 8: انتظار تفاعل النظام مع النص والروابط وتوليد بطاقة المعاينة
        setStage(8, 'انتظار تفاعل النظام وتوليد بطاقة معاينة الروابط والنص');
        let fbUrlCheck = post.facebook_url || '';
        if (fbUrlCheck.trim() !== '' || postText.includes('facebook.com')) {
            const linkWait = randomDelay(35, 50);
            await logToDashboard(`⏳ [المرحلة 8] [${ACCOUNT_NAME}] تم إدراج رابط، ننتظر ${Math.round(linkWait/1000)} ثانية لمعاينة الرابط...`, 'info');
            await smartSleep(linkWait);
        } else {
            const textWait = randomDelay(20, 30);
            await logToDashboard(`⏳ [المرحلة 8] [${ACCOUNT_NAME}] تم لصق النص، ننتظر ${Math.round(textWait/1000)} ثانية لتفاعل النظام...`, 'info');
            await smartSleep(textWait); 
        }
        
        await smartSleep(randomDelay(8, 15)); 

        // ⏳ المرحلة 9: فحص زر النشر والضغط عليه مع كامل المحددات والمترادفات والفحص العميق
        setStage(9, 'فحص زر النشر والضغط عليه');
        
        const targetButtonSelectors = [
            // 1. محددات فيسبوك الجوال الرسمية (Mobile Web Composer Submit)
            'form[action*="composer"] button[type="submit"]',
            'form[action*="composer"] input[type="submit"]',
            'button[name="view_post"]',
            'input[name="view_post"]',
            'div[data-sigil*="composer-submit"]',
            'button[data-sigil*="composer-submit"]',
            'button[value="نشر"]',
            'button[value="Post"]',
            'button[value="مشاركة"]',
            'button[value="Share"]',
            'input[value="نشر"]',
            'input[value="Post"]',
            
            // 2. محددات الحوار والنافذة
            'div[role="dialog"] button[type="submit"]',
            'div[role="dialog"] div[role="button"][aria-label="نشر"]',
            'div[role="dialog"] div[role="button"][aria-label="Post"]',
            'div[role="dialog"] div[role="button"][aria-label="مشاركة"]',
            'div[role="dialog"] div[role="button"][aria-label="Share"]',
            'div[role="dialog"] div[role="button"]:has-text("نشر")',
            'div[role="dialog"] div[role="button"]:has-text("Post")',
            'div[role="dialog"] button:has-text("نشر")',
            'div[role="dialog"] button:has-text("Post")',
            
            // 3. أزرار الهيدر والـ Submit العامة
            'header button:has-text("نشر")',
            'header button:has-text("Post")',
            'header div[role="button"]:has-text("نشر")',
            'header div[role="button"]:has-text("Post")',
            'div[data-mcomponent="ServerHeader"] div[role="button"]',
            'button[type="submit"]:has-text("نشر")',
            'button[type="submit"]:has-text("Post")',
            'button[type="submit"]:has-text("مشاركة")',
            'button[type="submit"]:has-text("Share")',
            'div[role="button"][aria-label="نشر"]',
            'div[role="button"][aria-label="Post"]',
            'div[role="button"][aria-label="مشاركة"]',
            'div[role="button"][aria-label="Share"]',
            'div[aria-label="نشر"]',
            'div[aria-label="Post"]',
            'div[aria-label="مشاركة"]',
            'div[aria-label="Share"]',
            'div[role="button"]:has-text("نشر")',
            'div[role="button"]:has-text("Post")',
            'button:has-text("نشر")',
            'button:has-text("Post")',
            'text="نشر"',
            'text="Post"'
        ];

        let published = false;

        // المستوى 1: البحث في Playwright Locators
        let targetEl = null;
        let matchedSelector = '';

        for (const sel of targetButtonSelectors) {
            try {
                const locator = page.locator(sel);
                const count = await locator.count();
                for (let i = 0; i < count; i++) {
                    const el = locator.nth(i);
                    if (await el.isVisible()) {
                        targetEl = el;
                        matchedSelector = sel;
                        break;
                    }
                }
                if (targetEl) break;
            } catch (e) {}
        }

        if (targetEl) {
            try {
                let isDisabled = await targetEl.getAttribute('aria-disabled') || await targetEl.getAttribute('disabled');
                let retries = 0;
                const isVideoFile = imagePath && (imagePath.endsWith('.mp4') || imagePath.endsWith('.mov') || imagePath.endsWith('.webm') || imagePath.endsWith('.mkv') || imagePath.endsWith('.avi'));
                const maxRetries = isVideoFile ? 15 : 6;

                while ((isDisabled === 'true' || isDisabled === 'disabled') && retries < maxRetries) {
                    await logToDashboard(`⏳ [المرحلة 9] [${ACCOUNT_NAME}] زر النشر غير جاهز بعد (فيسبوك يجهز المرفقات/الفيديو)، ننتظر بهدوء... (محاولة ${retries + 1}/${maxRetries})`, 'info');
                    await smartSleep(4000);
                    isDisabled = await targetEl.getAttribute('aria-disabled') || await targetEl.getAttribute('disabled');
                    retries++;
                }

                await targetEl.click({ timeout: 8000, force: true, noWaitAfter: true });
                published = true;
                await logToDashboard(`🚀 [المرحلة 9] [${ACCOUNT_NAME}] تم النقر على زر النشر عبر المحدد (${matchedSelector}) بنجاح!`, 'success');
            } catch (e) {
                await logToDashboard(`⚠️ [المرحلة 9] [${ACCOUNT_NAME}] تعذر النقر المباشر على الزر (${matchedSelector})، الانتقال للفحص العميق...`, 'info');
            }
        }

        // المستوى 2: الفحص العميق الموجه لنموذج النشر في الـ DOM (Native JS Event Trigger)
        if (!published) {
            await logToDashboard(`🔍 [المرحلة 9] [${ACCOUNT_NAME}] جاري الفحص العميق في شجرة الـ DOM للعثور على زر النشر...`, 'info');
            
            published = await page.evaluate(() => {
                // 1. فحص زر الـ Submit الخاص بالكومبوزر حصراً
                const composerForm = document.querySelector('form[action*="composer"], form[data-pagelet*="Composer"], form[data-sigil*="m-composer"]');
                if (composerForm) {
                    const submitBtn = composerForm.querySelector('button[type="submit"], input[type="submit"], button[name="view_post"], input[name="view_post"], [data-sigil*="composer-submit"]');
                    if (submitBtn) {
                        submitBtn.click();
                        submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        return true;
                    }
                    if (typeof composerForm.submit === 'function') {
                        composerForm.submit();
                        return true;
                    }
                }

                // 2. فحص أزرار الـ Submit ذات الأسماء الصريحة للنشر
                const directButtons = Array.from(document.querySelectorAll(
                    '[data-sigil*="composer-submit"], button[name="view_post"], input[name="view_post"], button[value="نشر"], button[value="Post"]'
                ));
                for (const btn of directButtons) {
                    const rect = btn.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        btn.click();
                        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        return true;
                    }
                }

                // 3. فحص الأزرار التي تحتوي نص نشر أو post وتكون مرئية
                const allButtons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]'));
                for (const btn of allButtons) {
                    const txt = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                    const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
                    if (txt === 'نشر' || txt === 'post' || aria === 'نشر' || aria === 'post' || txt === 'مشاركة' || txt === 'share') {
                        const rect = btn.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            btn.click();
                            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                            return true;
                        }
                    }
                }

                return false;
            });

            if (published) {
                await logToDashboard(`🚀 [المرحلة 9] [${ACCOUNT_NAME}] تم النقر على زر النشر عبر الفحص العميق (Native JS DOM Click) بنجاح!`, 'success');
            }
        }

        // ⏳ المرحلة 10: مراقبة وتأكيد خروج المنشور واختفاء شاشة الكتابة
        setStage(10, 'متابعة رد فيسبوك وتأكيد وصول المنشور للمجموعة');
        await smartSleep(randomDelay(8, 15));

        // التحقق الحقيقي الصارم من إرسال المنشور
        const checkResult = await page.evaluate(() => {
            const bodyText = document.body.innerText || '';
            
            // تحقق حقيقي وصريح من مراجعة الأدمن (تجنب كلمة "مسؤول" العامة)
            const isPendingAdmin = 
                bodyText.includes('منشورك قيد المراجعة') ||
                bodyText.includes('تم إرسال المنشور للمسؤول') ||
                bodyText.includes('تم إرسال منشورك إلى مسؤول') ||
                bodyText.includes('بانتظار موافقة المسؤول') ||
                bodyText.includes('بانتظار الموافقة') ||
                bodyText.includes('pending admin approval') ||
                bodyText.includes('submitted to admin') ||
                bodyText.includes('post is pending');

            // فحص هل حقل الكتابة لا يزال مفتوحاً والنص داخله
            const activeInput = document.querySelector('textarea[name="xc_message"], textarea[data-sigil*="composer"], div[contenteditable="true"], div[role="textbox"]');
            const isInputStillPresent = activeInput && activeInput.offsetParent !== null && (activeInput.innerText || activeInput.value || '').trim().length > 10;

            // فحص هل رابط الصفحة الحالي لا يزال في صفحة الكومبوزر
            const isStillInComposerUrl = window.location.href.includes('/composer/') || window.location.href.includes('composer');

            return {
                isPendingAdmin,
                isInputStillPresent,
                isStillInComposerUrl
            };
        });

        if (checkResult.isPendingAdmin) {
            await logToDashboard(`✅ [المرحلة 10] [${ACCOUNT_NAME}] المنشور تم إرساله بنجاح وهو الآن (قيد مراجعة الأدمن).`, 'success');
        } else if (checkResult.isInputStillPresent || checkResult.isStillInComposerUrl) {
            // محاولة نقر أخيرة طارئة قبل إعلان الفشل
            const emergencyClicked = await page.evaluate(() => {
                const submitBtn = document.querySelector('button[name="view_post"], [data-sigil*="composer-submit"], form[action*="composer"] button[type="submit"]');
                if (submitBtn) { submitBtn.click(); return true; }
                return false;
            });

            if (emergencyClicked) {
                await smartSleep(10000);
                await logToDashboard(`🚀 [المرحلة 10] [${ACCOUNT_NAME}] تم تنفيذ نقرة الإرسال الطارئة بنجاح!`, 'success');
            } else {
                throw new Error('تعذر إرسال المنشور؛ نافذة النشر لا تزال مفتوحة ولم يتم تنفيذ أمر النشر.');
            }
        } else {
            await logToDashboard(`✅ [المرحلة 10] [${ACCOUNT_NAME}] تم تأكيد نشر المنشور بنجاح واختفاء واجهة التحرير!`, 'success');
        }

        let isUploadedVideo = imagePath && (imagePath.endsWith('.mp4') || imagePath.endsWith('.mov') || imagePath.endsWith('.webm') || imagePath.endsWith('.mkv') || imagePath.endsWith('.avi'));
        let finalWait = isUploadedVideo ? 30000 : 12000;
        await smartSleep(finalWait); 
    } finally {
        stopStageWatchdog();
    }
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
    } else if (post.video_url && post.video_url.trim() !== '') {
        mediaUrl = post.video_url.trim();
        isVideoPost = true;
        await logToDashboard(`🎥 [${ACCOUNT_NAME}] تم رصد رابط فيديو في السوبيس (video_url): ${mediaUrl}`, 'info');
    } else if (post.ad_image && post.ad_image.trim() !== '') {
        mediaUrl = post.ad_image.trim();
        const lowerImg = mediaUrl.toLowerCase();
        if (lowerImg.includes('.mp4') || lowerImg.includes('.mov') || lowerImg.includes('.webm') || lowerImg.includes('.mkv') || lowerImg.includes('.avi')) {
            isVideoPost = true;
            await logToDashboard(`🎥 [${ACCOUNT_NAME}] تم رصد فيديو عبر حقل الصورة (ad_image): ${mediaUrl}`, 'info');
        } else {
            await logToDashboard(`📸 [${ACCOUNT_NAME}] تم رصد رابط صورة في السوبيس (ad_image): ${mediaUrl}`, 'info');
        }
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

    // 🌟 إعدادات متصفح منخفضة استهلاك الذاكرة مخصصة لـ Render مع دعم معالجة الميديا
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu',
            '--no-first-run',
            '--no-service-autorun',
            '--password-store=basic',
            '--js-flags="--max-old-space-size=128"',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--mute-audio',
            '--no-zygote',
            '--disable-infobars',
            '--hide-scrollbars'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 393, height: 851 },
        isMobile: true,
        hasTouch: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
        permissions: ['clipboard-read', 'clipboard-write']
    });

    // 🌟 حظر الخطوط فقط لتسريع التصفح وتوفير الذاكرة مع السماح لحركة الميديا والفيديو
    await context.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (resourceType === 'font') {
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
            try { updatePayload[BOT_GROUP_FIELD] = JSON.stringify(targetGroup); } catch(e) {}

            const { error: updateErr } = await supabase
                .from('publish_queue')
                .update(updatePayload)
                .eq('id', post.id);

            if (updateErr) {
                await smartSleep(1000);
                continue;
            }

            await logToDashboard(`🎯 [${ACCOUNT_NAME}] تم سحب المجموعة (${targetGroup.name}) الخاصة بـ ${ACCOUNT_NAME} وحذفها من الطابور لضمان التوازي.`, 'success');

            const page = await context.newPage();
            
            page.on('dialog', async dialog => {
                try { await dialog.accept(); } catch(e) {}
            });

            page.on('filechooser', async fileChooser => {
                try {
                    if (imagePath && fs.existsSync(imagePath)) {
                        await fileChooser.setFiles(imagePath);
                    } else {
                        await fileChooser.cancel();
                    }
                } catch(e) {}
            });

            try {
                // 🚀 تشغيل النشر بالمراحل المستقلة دون مؤقت إجمالي يخنقه (مطابقة تامة للبوت 2)
                await publishToGroup(page, targetGroup, freshPost, imagePath);
                successCount++;
                
                const { data: latestPost } = await supabase.from('publish_queue').select('*').eq('id', post.id).single();
                let finalAiText = latestPost?.[BOT_AI_FIELD] || latestPost?.ai_final_text || freshPost[BOT_AI_FIELD] || freshPost.ai_final_text || freshPost.ad_title;
                
                await logPublishEvent(latestPost || freshPost, targetGroup.name, 'SUCCESS', finalAiText);
                await incrementBotCounters();

            } catch (err) {
                if (err.message === 'STOPPED_BY_USER') {
                    await page.close();
                    break;
                }

                const isCheckpoint = err.message.includes('Checkpoint') || err.message.includes('تسجيل الدخول') || err.message.includes('login');
                if (isCheckpoint) {
                    await logToDashboard(`🚨 [خطر] تم رصد تشيك بوينت! إيقاف البوت فوراً وتحويله إلى IDLE لحماية الحساب...`, 'error');
                    await updateBotLastActive('IDLE');
                    await page.close();
                    break;
                }

                failedCount++;
                failedGroups.push({ name: targetGroup.name, url: targetGroup.url, error: err.message });
                await logToDashboard(`❌ [${ACCOUNT_NAME}] فشل النشر في المجموعة: ${targetGroup.name} | السبب: ${err.message}`, 'error');
                
                const { data: latestPostFail } = await supabase.from('publish_queue').select('*').eq('id', post.id).single();
                let finalAiTextFail = latestPostFail?.[BOT_AI_FIELD] || latestPostFail?.ai_final_text || freshPost[BOT_AI_FIELD] || freshPost.ai_final_text || freshPost.ad_title;
                
                await logPublishEvent(latestPostFail || freshPost, targetGroup.name, 'FAILED', finalAiTextFail);

            } finally {
                await page.close();
                await logToDashboard(`🧹 [${ACCOUNT_NAME}] تم تدمير صفحة المجموعة وتفريغ الذاكرة.`, 'info');

                const resetPayload = {
                    success_count: successCount,
                    failed_count: failedCount,
                    error_message: JSON.stringify(failedGroups)
                };
                try {
                    resetPayload[BOT_GROUP_FIELD] = null;
                    resetPayload[BOT_AI_FIELD] = null;
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

            // ⚠️ استراحة أمان بين المجموعات عبر النوم الذكي المتقطع
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
        await updatePostStatus(post.id, 'COMPLETED', { published_at: new Date(), error_message: null, status: 'published' });
        await logToDashboard(`✅ [${ACCOUNT_NAME}] تم نشر الإعلان في المجموعات بنجاح.`, 'success');
    } else if (finalGroups.length === 0) {
        await updatePostStatus(post.id, 'FAILED', { error_message: JSON.stringify(failedGroups), status: 'failed' });
        await logToDashboard(`❌ [${ACCOUNT_NAME}] اكتملت المجموعات مع وجود إخفاقات مخزنة في الأخطاء. تم تغيير الحالة إلى (FAILED).`, 'error');
    }
}

async function start() {
    await logToDashboard(`🚀 [${ACCOUNT_NAME}] جاري تهيئة بيئة المتصفح السحابي للبوت بنظام المراحل الـ 10...`, 'info');

    await resetStuckPosts();
    await cleanOldLogs();
    setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);

    await logToDashboard(`🚀 [${ACCOUNT_NAME}] البوت جاهز تماماً ومتصل بـ Supabase...`, 'success');

    let idleLogTimer = 0; 

    while (true) {
        // 🛑 1. فحص الحد اليومي (15 مجموعة)
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
