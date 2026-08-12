// استدعاء مكتبة التخفي لمنع التشيك بوينت
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// 🔌 الاتصال بـ Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bmsfhqmsovicpgxxwsgi.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_l1IbZF35GnYYS8PamVX_kg_nTv_uyef';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TEMP_DIR = path.join(os.tmpdir(), 'bot3-temp-files');
const ACCOUNT_NAME = 'الحساب (3)';
const BOT_ID = 'bot3'; // المعرف الخاص بهذا البوت في جدول العدادات

// 🛑 دالة الإيقاف الفوري للجلسة والسيرفر مع تحويل الحالة إلى IDLE وإلغاء GitHub Action
async function forceKillProcess(reason = 'طلب إيقاف من المستخدم') {
    await logToDashboard(`🛑 ${reason} | جاري تحويل الحالة إلى IDLE وإنهاء الجلسة فوراً...`, 'warn');
    
    try {
        await supabase
            .from('bot_counters')
            .update({ status: 'IDLE' })
            .eq('bot_name', BOT_ID);
        await logToDashboard(`✅ تم تحويل حالة ${BOT_ID} إلى (IDLE) في قاعدة البيانات.`, 'info');
    } catch (e) {
        console.error("فشل تحديث حالة البوت إلى IDLE في قاعدة البيانات:", e.message);
    }

    if (process.env.GITHUB_ACTIONS && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID) {
        try {
            await axios.post(
                `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/cancel`,
                {},
                { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } }
            );
            await logToDashboard(`🛑 تم إرسال أمر cancel-run للـ Workflow في GitHub Actions بنجاح.`, 'info');
        } catch (e) {
            console.error("فشل إلغاء Workflow عبر GitHub API:", e.message);
        }
    }

    process.exit(0);
}

// 🧠 0. دالة حساب استهلاك الذاكرة
function getMemoryLog() {
    const memory = process.memoryUsage();
    const rssMB = (memory.rss / 1024 / 1024).toFixed(1);
    const heapMB = (memory.heapUsed / 1024 / 1024).toFixed(1);
    return `📊 [RAM: ${rssMB} MB | Heap: ${heapMB} MB]`;
}

// 🛠️ 1. دالة فحص التاريخ وتصفير العداد اليومي ومسح السجلات القديمة تلقائياً
async function checkAndResetCounter(botName) {
    try {
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
        const { data, error } = await supabase
            .from('bot_counters')
            .select('daily_count, last_reset_date')
            .eq('bot_name', botName)
            .single();

        if (error || !data) return 0;

        if (data.last_reset_date !== todayStr) {
            await logToDashboard(`🔄 يوم جديد (${todayStr})! تم تصفير عداد ${botName} ومسح سجلات المجموعات القديمة.`, 'info');
            
            await supabase.from('bot_publish_logs').delete().neq('id', 0);

            await supabase
                .from('bot_counters')
                .update({ daily_count: 0, last_reset_date: todayStr, status: 'RUNNING' })
                .eq('bot_name', botName);
            return 0;
        }

        return data.daily_count;
    } catch (e) {
        return 0;
    }
}

// 🛠️ 2. دالة تسجيل النشر الناجح وتحديث المجموعات والعدادات للبوت الثالث
async function logPublishSuccess(botName, adId, actualPostText, groupName) {
    try {
        const exactPublishTime = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Aden' }).replace(' ', 'T') + '+03:00';
        const displayTitle = actualPostText ? (actualPostText.substring(0, 120) + '...') : 'إعلان بدون عنوان';

        const { error: insertError } = await supabase
            .from('bot_publish_logs')
            .insert([{
                bot_name: botName,
                ad_id: adId,
                ad_title: displayTitle,
                group_name: groupName,
                status: 'SUCCESS',
                published_at: exactPublishTime
            }]);

        if (insertError) {
            console.error("❌ خطأ Supabase في حفظ سجل النشر:", insertError.message);
            await logToDashboard(`❌ فشل حفظ اللوج في الجدول: ${insertError.message}`, 'error');
        }

        const { data } = await supabase
            .from('bot_counters')
            .select('daily_count, total_count')
            .eq('bot_name', botName)
            .single();

        const currentDaily = (data?.daily_count || 0) + 1;
        const currentTotal = (data?.total_count || 0) + 1;

        await supabase
            .from('bot_counters')
            .update({
                daily_count: currentDaily,
                total_count: currentTotal,
                last_active: exactPublishTime,
                status: 'RUNNING'
            })
            .eq('bot_name', botName);

        await logToDashboard(`📊 [العداد] تم تسجيل نشر المجموعة (${groupName}) | العداد اليومي لـ ${botName}: [${currentDaily}]`, 'success');
    } catch (e) {
        console.error("خطأ أثناء تسجيل عملية النشر:", e);
    }
}

// 🌟 تشغيل سيرفر ويب خفيف
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send(`🚀 FB Bot Dedicated Instance - ${ACCOUNT_NAME} is running 24/7!`));

app.get('/restart-bot', async (req, res) => {
    await logToDashboard(`🚨 [${ACCOUNT_NAME}] تم طلب إعادة التشغيل يدوياً من المطور!`, 'error');
    res.send(`🔄 جاري إعادة تشغيل السيرفر للبوت الخاص بـ ${ACCOUNT_NAME}...`);
    process.exit(1); 
});

app.listen(PORT, () => {
    console.log(`🌐 Web Server active on port ${PORT} for ${ACCOUNT_NAME}`);
    setInterval(async () => {
        try {
            const myServerUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`; 
            await axios.get(myServerUrl);
        } catch (e) {
            console.log(`⚠️ [Self-Ping] [${ACCOUNT_NAME}] فشل إرسال تنبيه الاستيقاظ:`, e.message);
        }
    }, 300000);
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(minSeconds, maxSeconds) {
    const min = minSeconds * 1000;
    const max = maxSeconds * 1000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function getSetting(keyName) {
    try {
        const { data, error } = await supabase
            .from('system_settings')
            .select('value')
            .eq('key', keyName)
            .single();

        if (error || !data) return null;
        return data.value;
    } catch (e) {
        return null;
    }
}

async function logToDashboard(message, type = 'info') {
    const ramInfo = getMemoryLog();
    const fullMsg = `${message} | ${ramInfo}`;
    const consoleMsg = `[${ACCOUNT_NAME}] ${fullMsg}`;

    if (type === 'error') console.error(`❌ ${consoleMsg}`);
    else if (type === 'success') console.log(`✅ ${consoleMsg}`);
    else console.log(`📢 ${consoleMsg}`);

    try {
        const { error } = await supabase.from('bot_logs').insert([{ message: consoleMsg, log_type: type }]);
        if (error) {
            console.error(`⚠️ [Log Error]: فشل حفظ السجل في Supabase: ${error.message}`);
        }
    } catch (e) {
        console.error(`⚠️ [Log Exception]: ${e.message}`);
    }
}

async function cleanOldLogs() {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase
        .from('bot_logs')
        .delete()
        .lt('created_at', threeDaysAgo);

    if (!error) {
        await logToDashboard(`🧹 [Auto-Cleanup] تم تنظيف السجلات القديمة من قاعدة البيانات للحفاظ على المساحة.`, 'info');
    }
}

async function rewriteAdWithAI(title, description) {
    const geminiKey = await getSetting('GEMINI_KEY');

    if (!geminiKey) return `${title}\n\n${description}`;
    const promptText = `أنت خبير تسويق إلكتروني. قم بإعادة صياغة هذا الإعلان بأسلوب جذاب، جديد، ومختلف تماماً مع الحفاظ على نفس الفكرة والمعلومات الأساسية والروابط إن وجدت. اجعل العبارات طبيعية وغير مكررة.
العنوان الاصلي: ${title}
الوصف الاصلي: ${description}

أعطني النتيجة مباشرة بالتنسيق التالي:
العنوان: [العنوان الجديد]
الوصف: [الوصف الجديد]`;

    try {
        const modelsResponse = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
        const validModels = (modelsResponse.data.models || []).filter(m => 
            m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent') && m.name.includes('gemini')
        );

        if (validModels.length === 0) return `${title}\n\n${description}`;

        for (const modelObj of validModels) {
            try {
                const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/${modelObj.name}:generateContent?key=${geminiKey}`, {
                    contents: [{ parts: [{ text: promptText }] }]
                });
                const aiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (aiText) {
                    await logToDashboard(`✨ تم إعادة صياغة الإعلان بنجاح بواسطة الذكاء الاصطناعي!`, 'success');
                    return aiText.replace(/العنوان:/g, '').replace(/الوصف:/g, '').trim();
                }
            } catch (e) { continue; }
        }
    } catch (e) {}

    return `${title}\n\n${description}`;
}

async function downloadImage(imageUrl) {
    if (!imageUrl) return null;
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    
    let ext = '.jpg';
    const lowerUrl = imageUrl.toLowerCase();
    if (lowerUrl.includes('.mp4') || lowerUrl.includes('ik-video')) ext = '.mp4';
    else if (lowerUrl.includes('.mov')) ext = '.mov';
    else if (lowerUrl.includes('.webp') || lowerUrl.includes('f-webp')) ext = '.webp';
    else if (lowerUrl.includes('.png')) ext = '.png';

    const imagePath = path.join(TEMP_DIR, `ad-image-bot3-${Date.now()}${ext}`);
    const response = await axios({ url: imageUrl, method: 'GET', responseType: 'stream' });
    
    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(imagePath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
    return imagePath;
}

// 🎯 دالة إحماء الجلسة
async function warmupSession(page) {
    try {
        await logToDashboard(`☕ [Warm-up New Account Safety] تصفح أطول وتمرير عشوائي لحماية الحساب الجديد...`, 'info');
        
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(randomDelay(12, 18));

        if (page.url().includes('login') || page.url().includes('checkpoint') || page.url().includes('login.php')) {
            throw new Error('انتهت جلسة تسجيل الدخول أو يوجد Checkpoint للحساب');
        }

        await page.mouse.move(Math.floor(Math.random() * 400) + 150, Math.floor(Math.random() * 300) + 100);
        await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 350) + 200));
        await sleep(randomDelay(6, 10));
        
        await page.evaluate(() => window.scrollBy(0, -Math.floor(Math.random() * 100) - 50));
        await sleep(randomDelay(3, 5));

        await page.mouse.move(Math.floor(Math.random() * 500) + 200, Math.floor(Math.random() * 400) + 200);
        await page.evaluate(() => window.scrollBy(0, Math.floor(Math.random() * 500) + 200));
        await sleep(randomDelay(7, 12));

        await logToDashboard(`✅ تم إحماء الجلسة وتنويع السلوك للبوت الثالث بنجاح!`, 'success');
    } catch (e) {
        if (e.message.includes('Checkpoint') || e.message.includes('login')) throw e;
        await logToDashboard(`⚠️ تنبيه أثناء الإحماء: ${e.message}`, 'warn');
    }
}

async function openPostBox(page) {
    const initialWait = randomDelay(22, 28);
    await logToDashboard(`⏳ إعطاء فيسبوك مهلة ${Math.round(initialWait/1000)} ثانية لبناء الأزرار ومربع النشر...`, 'info');
    await sleep(initialWait); 

    const discussionTabs = [
        'div[role="tab"]:has-text("مناقشة")',
        'div[role="tab"]:has-text("Discussion")',
        'a[role="tab"]:has-text("مناقشة")',
        'a[role="tab"]:has-text("Discussion")',
        'a[href*="/discussion"]'
    ];

    for (const tabSel of discussionTabs) {
        try {
            const tabBtn = page.locator(tabSel).first();
            if (await tabBtn.count() > 0 && await tabBtn.isVisible()) {
                await tabBtn.click({ timeout: 5000, force: true });
                const tabWait = randomDelay(18, 25);
                await logToDashboard(`🔄 تم التبديل لتبويب (مناقشة)، ننتظر ${Math.round(tabWait/1000)} ثانية لاستقرار التبويب...`, 'info');
                await sleep(tabWait); 
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
                const box = await element.boundingBox();
                if (box) {
                    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                    await sleep(randomDelay(2, 4));
                }
                await element.click({ timeout: 6000, force: true });
                
                const postOpenWait = randomDelay(20, 26);
                await logToDashboard(`⏳ تم النقر لفتح نافذة المنشور، ننتظر ${Math.round(postOpenWait/1000)} ثانية لتفتح النافذة براحتها...`, 'info');
                await sleep(postOpenWait); 

                const confirmBtns = ['text=موافق', 'text=فهمت', 'text=تم', 'text=Got It', 'text=OK', 'text=متابعة'];
                for (const cBtn of confirmBtns) {
                    try {
                        const btn = page.locator(cBtn).first();
                        if (await btn.count() > 0 && await btn.isVisible()) {
                            await btn.click({ timeout: 3000, force: true });
                            await sleep(randomDelay(2, 5));
                        }
                    } catch(e){}
                }

                await logToDashboard(`✅ تم فتح نافذة المنشور بنجاح`, 'success');
                return true;
            }
        } catch (e) {}
    }
    return false;
}

async function pasteTextWithLines(page, postText) {
    await sleep(randomDelay(6, 9)); 

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
            await textbox.click({ timeout: 6000, force: true });
            await sleep(randomDelay(3, 5)); 
            await page.evaluate(async (text) => {
                await navigator.clipboard.writeText(text);
            }, postText);
            await page.keyboard.press('Control+V');
            await logToDashboard(`✅ تم لصق النص مع الحفاظ على الأسطر`, 'success');
            return;
        } catch (err) {
            await logToDashboard(`⚠️ فشل Clipboard، سيتم استخدام التعبئة البديلة insertText...`, 'info');
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
        await sleep(randomDelay(3, 5));
        await page.keyboard.insertText(postText);
        await logToDashboard(`✅ تم إدخال النص بطريقة البديلة (insertText)`, 'success');
    } catch(e) {
        throw new Error('تعذر العثور على حقل نص صالح للكتابة داخل هذه المجموعة');
    }
}

// 🚀 دالة النشر الفعلي للمجموعة
async function publishToGroup(page, group, post, imagePath) {
    await warmupSession(page);

    await logToDashboard(`📢 فتح رابط مجموعة البوت: ${group.name} | الرابط: ${group.url}`, 'info');
    
    await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    
    const pageLoadWait = randomDelay(40, 52);
    await logToDashboard(`⏳ تم تحميل الصفحة، ننتظر ${Math.round(pageLoadWait/1000)} ثانية كاملة لاستقرار عناصر الصفحة وبناء السكربتات...`, 'info');
    await sleep(pageLoadWait); 

    if (page.url().includes('login') || page.url().includes('checkpoint') || page.url().includes('login.php')) {
        throw new Error('انتهت جلسة تسجيل الدخول أو يوجد Checkpoint للحساب');
    }

    const opened = await openPostBox(page);
    if (!opened) throw new Error('لم يتم العثور على مربع النشر');

    await sleep(randomDelay(6, 12)); 

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
                    await trigElement.click({ timeout: 6000, force: true });
                    await sleep(randomDelay(5, 8)); 
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
            const waitTime = isVideoFile ? randomDelay(70, 90) : randomDelay(30, 40);

            await logToDashboard(`🖼️ تم حقن مسار الملف، ننتظر ${Math.round(waitTime/1000)} ثانية لرفع الملف...`, 'success');
            await sleep(waitTime);

            try {
                await page.waitForSelector('img[src*="blob:"], video, [aria-label*="إزالة"], [aria-label*="Remove"]', { timeout: 30000 });
                await logToDashboard(`✅ ظهرت معاينة المرفق بنجاح`, 'success');
            } catch (e) {}

            const previewWait = randomDelay(28, 38);
            await logToDashboard(`⏳ ننتظر ${Math.round(previewWait/1000)} ثانية إضافية لاستقرار المعاينة...`, 'info');
            await sleep(previewWait); 
        }
    }
    
    await sleep(randomDelay(6, 9)); 

    let postText = post.ai_final_text3 || '';
    
    if (!postText || postText.trim() === '') {
        await logToDashboard(`🧠 [AI] العمود ai_final_text3 فارغ، جاري صياغة نص جديد خصيصاً لمجموعة: ${group.name}...`, 'info');
        const aiGeneratedContent = await rewriteAdWithAI(post.ad_title, post.ad_description);
        postText = `${aiGeneratedContent}\n\n🔥 إعلان جديد على سوق الإعلانات الحديث`;

        let fbUrl = post.facebook_url || '';
        if (fbUrl.trim() !== '') {
            postText += `\n\n${fbUrl.trim()}`;
        }
        
        await supabase.from('publish_queue').update({ ai_final_text3: postText }).eq('id', post.id);
        await logToDashboard(`💾 [Supabase] تم حفظ النص النهائي الخاص بهذه المجموعة في عمود (ai_final_text3).`, 'success');
    } else {
        await logToDashboard(`📌 [Supabase] تم جلب النص الجاهز من عمود (ai_final_text3).`, 'success');
    }

    await logToDashboard(`📝 [Text] النص النهائي الذي سيتم لصقه:\n${postText}`, 'info');

    await pasteTextWithLines(page, postText);

    let fbUrlCheck = post.facebook_url || '';
    if (fbUrlCheck.trim() !== '' || postText.includes('facebook.com')) {
        const linkWait = randomDelay(55, 70);
        await logToDashboard(`⏳ تم إدراج رابط فيسبوك، ننتظر ${Math.round(linkWait/1000)} ثانية كاملة ليتفاعل النظام وتظهر المعاينة...`, 'info');
        await sleep(linkWait);
    } else {
        const textWait = randomDelay(30, 42);
        await logToDashboard(`⏳ تم لصق النص، ننتظر ${Math.round(textWait/1000)} ثانية ليتفاعل النظام مع النص المُدخل...`, 'info');
        await sleep(textWait); 
    }

    const publishButtons = [
        'div[role="dialog"] div[role="button"]:has-text("نشر")',
        'div[role="dialog"] div[role="button"]:has-text("Post")',
        'div[role="dialog"] div[role="button"]:has-text("Publish")',
        'div[aria-label="نشر"]',
        'div[aria-label="Post"]',
        'text=نشر', 'text=Post', 'text=Publish'
    ];

    let published = false;
    for (const btn of publishButtons) {
        try {
            const button = page.locator(btn).last();
            if (await button.count() > 0 && await button.isVisible()) {
                const btnBox = await button.boundingBox();
                if (btnBox) {
                    await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
                    await sleep(randomDelay(2, 4));
                }
                await button.click({ timeout: 8000, force: true });
                published = true;
                await logToDashboard(`🚀 تم الضغط على زر النشر النهائي`, 'success');
                break;
            }
        } catch (e) {}
    }

    if (!published) throw new Error('فشل العثور على زر النشر أو تعذر الضغط عليه');
    
    let isUploadedVideo = imagePath && (imagePath.endsWith('.mp4') || imagePath.endsWith('.mov'));
    let finalWait = isUploadedVideo ? randomDelay(70, 90) : randomDelay(40, 50);

    await logToDashboard(`⏳ انتظار استقرار النشر نهائياً لمدة ${Math.round(finalWait/1000)} ثانية لضمان إرسال المنشور...`, 'info');
    await sleep(finalWait); 
    
    // 🛡️ فحص الرابط مجدداً بعد الضغط على النشر تحسباً لأي خروج مفاجئ
    if (page.url().includes('login') || page.url().includes('checkpoint') || page.url().includes('login.php')) {
        throw new Error('انتهت جلسة تسجيل الدخول أو يوجد Checkpoint للحساب بعد النشر');
    }

    await logToDashboard(`✅ تم النشر في مجموعة البوت بنجاح تام: ${group.name}`, 'success');

    // 🌟 تسجيل عملية النشر في العدادات وسجل اليوم الحي
    logPublishSuccess(BOT_ID, post.id, postText, group.name);
}

// 🔄 دالة معالجة إعلان واحد للبوت الثالث
async function processOnePostBot3(initialPostData) {
    const currentDailyCount = await checkAndResetCounter(BOT_ID);
    if (currentDailyCount >= 5) {
        await logToDashboard(`⚠️ تم الوصول للحد الأقصى اليومي المسموح به لـ ${BOT_ID} (5 منشوراً). يتوقف البوت لحماية الحساب.`, 'info');
        await supabase.from('bot_counters').update({ status: 'MAX_LIMIT_REACHED' }).eq('bot_name', BOT_ID);
        return;
    }

    const cookiesRaw = await getSetting('FB_COOKIES_BOT3');
    if (!cookiesRaw) {
        await logToDashboard(`❌ ملف الكوكيز للبوت الثالث غير موجود في جدول system_settings!`, 'error');
        return;
    }

    // 💡 --- أطول تأخير أمان ابتدائي لضمان أنه ينطلق كـ "آخر بوت" بعد البوتين الأول والثاني ---
    const initialOffsetDelay = randomDelay(480, 720); // تأخير بين 8 إلى 12 دقيقة
    await logToDashboard(`⏳ [تنسيق التباعد] انتظار أمان مخصص للبوت الثالث والأخير لمدة ${Math.round(initialOffsetDelay / 1000 / 60)} دقائق لحماية الحساب الجديد وضمان عدم التزامن...`, 'info');
    await sleep(initialOffsetDelay);
    // ------------------------------------------------------------------------------------------

    await logToDashboard(`🚀 بدأ معالجة الإعلان (#${initialPostData.id}: ${initialPostData.ad_title})...`, 'info');

    let mediaUrl = '';
    if (initialPostData.ad_video && initialPostData.ad_video.trim() !== '') {
        mediaUrl = initialPostData.ad_video.trim();
        await logToDashboard(`🎥 تم رصد رابط فيديو (ad_video): ${mediaUrl}`, 'info');
    } else if (initialPostData.ad_image && initialPostData.ad_image.trim() !== '') {
        mediaUrl = initialPostData.ad_image.trim();
        await logToDashboard(`📸 تم رصد رابط صورة (ad_image): ${mediaUrl}`, 'info');
    }

    let imagePath = null;
    if (mediaUrl !== '') {
        try {
            imagePath = await downloadImage(mediaUrl);
            if (imagePath) await logToDashboard(`🖼️ تم تحميل الملف وحفظه محلياً: ${imagePath}`, 'success');
        } catch (e) {
            await logToDashboard(`⚠️ فشل تحميل الملف، سيتم النشر كنص فقط: ${e.message}`, 'info');
        }
    }

    // 🛠️ خيارات تشغيل متصفح آمنة خالية من أَعلام البوتات للحساب الجديد
    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-service-autorun',
            '--password-store=basic',
            '--disable-extensions',
            '--disable-default-apps',
            '--mute-audio',
            '--disable-infobars'
        ]
    };

    await logToDashboard(`⚡ تم تشغيل المتصفح بضبط أمان خاص بالحساب الجديد لمنع Checkpoint`, 'info');

    const browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        permissions: ['clipboard-read', 'clipboard-write'],
        colorScheme: 'dark',
        hasTouch: false
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
        Object.defineProperty(navigator, 'languages', { get: () => ['ar', 'ar-SA', 'en-US', 'en'] });
    });

    await context.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['font'].includes(resourceType)) {
            return route.abort();
        }
        return route.continue();
    });

    try {
        let rawCookies = JSON.parse(cookiesRaw);
        
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
        await logToDashboard(`🍪 تم حقن الكوكيز بنجاح وتأمين الجلسة!`, 'success');

        while (true) {
            // 🛑 1. فحص كروت الإيقاف الفورية المخصصة لـ bot3 حصراً
            const { data: counterStatus } = await supabase
                .from('bot_counters')
                .select('status')
                .eq('bot_name', BOT_ID)
                .single();

            const isCounterStopped = counterStatus && ['IDLE', 'STOPPED', 'PAUSED'].includes(counterStatus.status);

            const { data: freshData } = await supabase
                .from('publish_queue')
                .select('*')
                .eq('id', initialPostData.id)
                .single();

            const isQueueStopped = !freshData || ['stopped', 'paused'].includes(freshData.status);

            if (isCounterStopped || isQueueStopped) {
                await browser.close();
                await forceKillProcess('تم رصد حالة الإيقاف يدوياً من اللوحة');
            }

            // ⏭️ 2. التعامل مع زر تخطي المجموعة الحالية
            if (freshData.skip_current_group === true) {
                await logToDashboard(`⏭️ تم طلب تخطي المجموعة الحالية بطلب من المستخدم، جاري الانتقال للتالي...`, 'info');
                
                let failedGroups = [];
                try {
                    if (freshData.error_message) failedGroups = JSON.parse(freshData.error_message);
                } catch (e) {}

                let currentBotGroup = freshData.bot3_group;
                let groupName = (typeof currentBotGroup === 'object' && currentBotGroup) ? currentBotGroup.name : 'مجموعة تم تخطيها';
                
                failedGroups.push({ name: groupName, error: 'تم تخطي المجموعة يدوياً من المستخدم' });

                await supabase.from('publish_queue').update({
                    skip_current_group: false,
                    bot3_group: null,
                    ai_final_text3: null,
                    error_message: JSON.stringify(failedGroups)
                }).eq('id', initialPostData.id);

                continue;
            }

            let groups = [];
            if (Array.isArray(freshData.groups_json)) {
                groups = freshData.groups_json;
            } else if (typeof freshData.groups_json === 'string') {
                try { groups = JSON.parse(freshData.groups_json || '[]'); } catch (e) {}
            }

            let botGroup = null;
            if (typeof freshData.bot3_group === 'object' && freshData.bot3_group !== null) {
                botGroup = freshData.bot3_group;
            } else if (typeof freshData.bot3_group === 'string') {
                try { botGroup = freshData.bot3_group ? JSON.parse(freshData.bot3_group) : null; } catch (e) {}
            }

            if (groups.length === 0 && !botGroup) {
                const { data: checkAllBots } = await supabase
                    .from('publish_queue')
                    .select('bot1_group, bot2_group, bot3_group, failed_count')
                    .eq('id', initialPostData.id)
                    .single();

                const hasOtherBotGroups = checkAllBots && (checkAllBots.bot1_group || checkAllBots.bot2_group);

                if (!hasOtherBotGroups) {
                    const finalFailed = checkAllBots?.failed_count || 0;
                    const finalStatus = finalFailed > 0 ? 'failed' : 'published';

                    await logToDashboard(`🎉 اكتملت جميع المجموعات لجميع البوتات! الحالة النهائية: (${finalStatus})`, 'success');

                    await supabase.from('publish_queue').update({
                        status: finalStatus,
                        bot3_group: null,
                        ai_final_text3: null
                    }).eq('id', initialPostData.id);
                } else {
                    await logToDashboard(`🎉 اكتملت جميع المجموعات المخصصة للبوت (3)! ينتهي البوت الثالث مع استمرار البوتات الأخرى...`, 'success');
                }

                await supabase.from('bot_counters').update({ status: 'IDLE' }).eq('bot_name', BOT_ID);
                break;
            }

            let targetGroup = null;

            if (botGroup) {
                targetGroup = botGroup;
                await logToDashboard(`🎯 وُجدت مجموعة معلقة في قروب البوت (${targetGroup.name})، جاري التحقق منها...`, 'info');
            } else {
                targetGroup = groups[0];
                const remainingGroups = groups.slice(1);

                const { error: updateErr } = await supabase.from('publish_queue').update({
                    bot3_group: JSON.stringify(targetGroup),
                    groups_json: JSON.stringify(remainingGroups)
                }).eq('id', initialPostData.id);

                if (updateErr) {
                    await sleep(1000);
                    continue;
                }

                await logToDashboard(`🎯 تم سحب المجموعة (${targetGroup.name}) وحذفها من الطابور الرئيسي لضمان عدم التكرار...`, 'success');
            }

            // 💡 --- فحص التكرار ---
            const { data: logData } = await supabase
                .from('bot_publish_logs')
                .select('id')
                .eq('bot_name', BOT_ID)              
                .eq('ad_id', initialPostData.id)     
                .eq('group_name', targetGroup.name)  
                .eq('status', 'SUCCESS');            

            if (logData && logData.length > 0) {
                await logToDashboard(`🛡️ [حماية] الإعلان (#${initialPostData.id}) نُشر مسبقاً في المجموعة (${targetGroup.name}) بواسطة ${BOT_ID}! جاري حذفها والتخطي فوراً...`, 'warn');
                
                await supabase.from('publish_queue').update({ 
                    bot3_group: null, 
                    ai_final_text3: null 
                }).eq('id', initialPostData.id);

                botGroup = null; 
                await sleep(2000);
                continue; 
            }

            const page = await context.newPage();
            try {
                const publishTask = publishToGroup(page, targetGroup, freshData, imagePath);
                
                const timeoutTask = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('تجمّد مفاجئ أو بطء شديد أثناء معالجة الصفحة (Deadlock Timeout)')), 900000)
                );

                await Promise.race([publishTask, timeoutTask]);
                
                const { data: latestSuccessPost } = await supabase
                    .from('publish_queue')
                    .select('success_count')
                    .eq('id', initialPostData.id)
                    .single();

                const currentSuccessCount = latestSuccessPost?.success_count || 0;
                const newSuccessCount = currentSuccessCount + 1;
                
                botGroup = null;
                
                await supabase.from('publish_queue').update({
                    bot3_group: null,
                    ai_final_text3: null,
                    success_count: newSuccessCount
                }).eq('id', initialPostData.id);

                await logToDashboard(`🧹 تم تصفير (ai_final_text3) وقروب البوت وتحديث العداد لـ (${newSuccessCount}).`, 'success');

                const { data: checkData } = await supabase.from('publish_queue').select('groups_json').eq('id', initialPostData.id).single();
                let currentRemaining = [];
                if (Array.isArray(checkData?.groups_json)) {
                    currentRemaining = checkData.groups_json;
                } else if (typeof checkData?.groups_json === 'string') {
                    try { currentRemaining = JSON.parse(checkData.groups_json || '[]'); } catch(e){}
                }

                if (currentRemaining.length > 0) {
                    // استراحة أمان عشوائية تماماً بين 12 دقيقة و 20 دقيقة
const longBreak = randomDelay(720, 1200);
                    await logToDashboard(`⏳ استراحة أمان مخصصة للحساب الجديد لمدة ${Math.round(longBreak / 1000 / 60)} دقائق قبل المجموعة التالية...`, 'info');
                    await sleep(longBreak);
                }

            } catch (err) {
                // 👉🚨 الدمج الذكي لحماية التشيك بوينت 🚨👈
                const isCheckpoint = err.message.includes('Checkpoint') || 
                                     err.message.includes('تسجيل الدخول') || 
                                     err.message.includes('login') || 
                                     err.message.includes('FB_SESSION_INVALID');
                
                if (isCheckpoint) {
                    await logToDashboard(`🚨 [خطر] تم رصد التشيك بوينت (Checkpoint) أو خروج من الحساب! جاري إيقاف البوت لحماية الحساب...`, 'error');
                    
                    // تحديث الحالة لـ FACEBOOK_CHECKPOINT لكي تنتبه لها
                    await supabase.from('bot_counters').update({ status: 'FACEBOOK_CHECKPOINT' }).eq('bot_name', BOT_ID);
                    
                    // تفريغ القروب المعلق لكي لا يفسد الإعلان
                    await supabase.from('publish_queue').update({ bot3_group: null, ai_final_text3: null }).eq('id', initialPostData.id);
                    
                    // قتل العملية كلياً كما فعل كود ChatGPT
                    await forceKillProcess('اكتشاف Checkpoint من فيسبوك');
                    return; // الخروج التام
                }
                // 👉🚨 نهاية الدمج 🚨👈

                const { data: latestFailedPost } = await supabase
                    .from('publish_queue')
                    .select('failed_count, error_message')
                    .eq('id', initialPostData.id)
                    .single();

                const currentFailedCount = latestFailedPost?.failed_count || 0;
                const newFailedCount = currentFailedCount + 1;
                
                let failedGroups = [];
                try {
                    if (latestFailedPost?.error_message && latestFailedPost.error_message.trim() !== '' && latestFailedPost.error_message !== 'null') {
                        const parsed = JSON.parse(latestFailedPost.error_message);
                        if (Array.isArray(parsed)) failedGroups = parsed;
                    }
                } catch(e){}

                failedGroups.push({ name: targetGroup.name, url: targetGroup.url, error: err.message });

                await logToDashboard(`❌ خطأ أثناء النشر في المجموعة (${targetGroup.name}): ${err.message}`, 'error');
                
                botGroup = null;
                
                await supabase.from('publish_queue').update({ 
                    bot3_group: null,
                    ai_final_text3: null,
                    failed_count: newFailedCount,
                    error_message: JSON.stringify(failedGroups)
                }).eq('id', initialPostData.id);

                await sleep(18000);
                continue; 
            } finally {
                await page.close();
            }
        }

    } catch (err) {
        await logToDashboard(`❌ خطأ عام في البوت الثالث: ${err.message}`, 'error');
        await supabase.from('bot_counters').update({ status: 'ERROR' }).eq('bot_name', BOT_ID);
    } finally {
        await browser.close();
        if (imagePath && fs.existsSync(imagePath)) {
            try { fs.unlinkSync(imagePath); } catch {}
        }
        await logToDashboard(`🧹 اكتملت العملية وأُغلق متصفح البوت الثالث بأمان.`, 'info');
    }
}

async function resetStuckBot3Posts() {
    await logToDashboard(`🔄 جاري فحص الإعلانات العالقة (processing) للبوت الثالث لإعادتها إلى (running)...`, 'info');
    const { error } = await supabase
        .from('publish_queue')
        .update({ status: 'running' })
        .eq('status', 'processing');

    if (error) {
        await logToDashboard(`⚠️ خطأ في إعادة ضبط الإعلانات العالقة: ${error.message}`, 'error');
    }
}

async function startBot3Engine() {
    await logToDashboard(`🚀 تم تشغيل محرك البوت الثالث الذاتي بنجاح...`, 'success');
    
    await supabase.from('bot_counters').update({ status: 'RUNNING' }).eq('bot_name', BOT_ID);

    await resetStuckBot3Posts();
    await cleanOldLogs();

    while (true) {
        try {
            const { data: counterStatus } = await supabase
                .from('bot_counters')
                .select('status')
                .eq('bot_name', BOT_ID)
                .single();

            if (counterStatus && ['IDLE', 'STOPPED', 'PAUSED'].includes(counterStatus.status)) {
                await forceKillProcess('تم رصد حالة الإيقاف في المحرك الرئيسي للبوت الثالث');
            }

            const { data, error } = await supabase
                .from('publish_queue')
                .select('*')
                .order('id', { ascending: true });

            if (error) {
                await logToDashboard(`⚠️ خطأ قراءة الطابور: ${error.message}`, 'error');
                await sleep(10000);
                continue;
            }

            let postToRun = null;
            if (data && data.length > 0) {
                for (const post of data) {
                    let groups = [];
                    if (Array.isArray(post.groups_json)) {
                        groups = post.groups_json;
                    } else if (typeof post.groups_json === 'string') {
                        try { groups = JSON.parse(post.groups_json || '[]'); } catch(e){}
                    }

                    let hasBotGroup = false;
                    if (typeof post.bot3_group === 'object' && post.bot3_group !== null) {
                        hasBotGroup = true;
                    } else if (typeof post.bot3_group === 'string') {
                        try { hasBotGroup = !!JSON.parse(post.bot3_group); } catch(e){}
                    }

                    if (groups.length > 0 || hasBotGroup) {
                        postToRun = post;
                        break;
                    }
                }
            }

            if (!postToRun) {
                await logToDashboard(`🎉 اكتملت جميع المهام في الطابور، تم إنهاء الجلسة السحابية بنجاح!`, 'success');
                await supabase.from('bot_counters').update({ status: 'IDLE' }).eq('bot_name', BOT_ID);
                await forceKillProcess('لا توجد إعلانات قيد الانتظار');
            }

            await supabase.from('publish_queue').update({ status: 'processing' }).eq('id', postToRun.id);

            await processOnePostBot3(postToRun);

            await supabase.from('publish_queue').update({ status: 'stopped' }).eq('id', postToRun.id);

            const macroDelay = randomDelay(1200, 2100);
            await logToDashboard(`⏳ استراحة الإعلانات الكبرى للبوت 3: انتظار ${Math.round(macroDelay / 1000 / 60)} دقيقة...`, 'info');
            await sleep(macroDelay);

        } catch (err) {
            await logToDashboard(`❌ خطأ في محرك البوت الثالث الرئيسي: ${err.message}`, 'error');
            await supabase.from('bot_counters').update({ status: 'ERROR' }).eq('bot_name', BOT_ID);
            await sleep(10000);
        }
    }
}

module.exports = processOnePostBot3;

if (require.main === module) {
    startBot3Engine();
}
