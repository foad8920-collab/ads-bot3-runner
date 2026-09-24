const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { cookieVaultSecretName, normalizeCookies } = require('./cookie-utils');
const { createVaultSecretReader } = require('./vault-utils');
const { rewriteAdWithGemini } = require('./ai-utils');
const { createCreativeVariant } = require('./media-utils');

const ACCOUNT_NUM = (process.env.ACCOUNT_NUMBER || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SECRET_KEY = (process.env.SUPABASE_SECRET_KEY || '').trim();
if (ACCOUNT_NUM !== '3') {
    console.error('This workflow currently supports account 3 only.');
    process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SECRET_KEY are required environment variables.');
    process.exit(1);
}
const ACCOUNT_NAME = `الحساب (${ACCOUNT_NUM})`;
const BOT_DB_NAME = `bot${ACCOUNT_NUM}`;
const BOT_GROUP_FIELD = `bot${ACCOUNT_NUM}_group`;
const BOT_STATUS_FIELD = `bot${ACCOUNT_NUM}_status`;
const BOT_AI_FIELD = ACCOUNT_NUM === '1' ? 'ai_final_text' : `ai_final_text${ACCOUNT_NUM}`;
const ACTION_STARTED_AT = Date.now();
const ACTION_SOFT_LIMIT_MS = 300 * 60 * 1000;
const ACTION_WORK_RESERVE_MS = 20 * 60 * 1000;

function hasActionTime(reserveMs = 0) {
    return Date.now() - ACTION_STARTED_AT + reserveMs < ACTION_SOFT_LIMIT_MS;
}

// -------------------------------------------------------------------------
// 🔗 دوال الربط بلوحة التحكم المركزية 🟢 
// -------------------------------------------------------------------------

if (typeof globalThis.WebSocket === 'undefined') {
    try {
        globalThis.WebSocket = require('ws');
    } catch(e) {}
}

const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    {
        auth: { persistSession: false, autoRefreshToken: false }
    }
);
const getVaultSecret = createVaultSecretReader(supabase);

const TEMP_DIR = './temp';

async function getAccountCookies() {
    const secretName = cookieVaultSecretName(ACCOUNT_NUM);
    const value = await getVaultSecret(secretName);

    try {
        const rawCookies = typeof value === 'string' ? JSON.parse(value) : value;
        return normalizeCookies(rawCookies);
    } catch {
        throw new Error(`Cookies configured for account ${ACCOUNT_NUM} are invalid`);
    }
}

async function getBotStatus() {
    const { data, error } = await supabase
        .from('bot_counters')
        .select('status')
        .eq('bot_name', BOT_DB_NAME)
        .maybeSingle();
    if (error) throw new Error('Failed to read bot status from Supabase');
    return data?.status ? data.status.toUpperCase() : 'IDLE';
}

async function updateBotLastActive(forceStatus = null) {
    const updateData = { bot_name: BOT_DB_NAME, last_active: new Date() };
    if (forceStatus) updateData.status = forceStatus;
    const { error } = await supabase.from('bot_counters').upsert(updateData, { onConflict: 'bot_name' });
    if (error) throw new Error('Failed to update the bot status in Supabase');
}

// 🟢 حارس الحد اليومي (15 مجموعة كحد أقصى)
async function checkDailyLimit() {
    const { data, error } = await supabase
        .from('bot_counters')
        .select('daily_count')
        .eq('bot_name', BOT_DB_NAME)
        .maybeSingle();
    if (error) throw new Error('Failed to read the daily publishing counter from Supabase');
    return Number(data?.daily_count || 0) >= 15;
}

async function incrementBotCounters() {
    const { data, error } = await supabase.from('bot_counters')
        .select('daily_count, total_count').eq('bot_name', BOT_DB_NAME).maybeSingle();
    if (error) throw new Error('Failed to read the publishing counter in Supabase');
    const daily = Number(data?.daily_count || 0);
    const total = Number(data?.total_count || 0);
    const newDaily = daily + 1;
    const newTotal = total + 1;
    const { error: updateError } = await supabase.from('bot_counters').upsert({
        bot_name: BOT_DB_NAME,
        daily_count: newDaily,
        total_count: newTotal,
        last_active: new Date(),
        status: newDaily >= 15 ? 'IDLE' : 'RUNNING'
    }, { onConflict: 'bot_name' });
    if (updateError) throw new Error('Failed to update the publishing counter in Supabase');
}

// 🟢 إرسال أو تحديث سجل النشر المباشر دون تكرار
async function logPublishEvent(post, groupName, statusMsg, aiModifiedText = null, existingLogId = null) {
    try {
        const cleanGroupName = (groupName || '').trim();
        const title = aiModifiedText || post[BOT_AI_FIELD] || post.ai_final_text || post.ad_title || 'بدون عنوان';
        const adIdStr = post.id ? post.id.toString() : 'Unknown';

        if (existingLogId) {
            const { error } = await supabase.from('bot_publish_logs')
                .update({
                    status: statusMsg,
                    ad_title: title,
                    published_at: new Date()
                })
                .eq('id', existingLogId);
            if (error) throw new Error('Unable to update the publishing log');
            return existingLogId;
        }

        if (statusMsg === 'PROCESSING') {
            const { data, error } = await supabase.from('bot_publish_logs').insert([{
                bot_name: BOT_DB_NAME,
                ad_id: adIdStr,
                ad_title: title,
                group_name: cleanGroupName,
                status: statusMsg,
                published_at: new Date()
            }]).select('id').single();
            if (error || !data?.id) throw new Error('Unable to create the publishing checkpoint');
            return data?.id || null;
        } else {
            const { data: processingRow } = await supabase.from('bot_publish_logs')
                .select('id')
                .eq('bot_name', BOT_DB_NAME)
                .eq('ad_id', adIdStr)
                .eq('group_name', cleanGroupName)
                .eq('status', 'PROCESSING')
                .order('published_at', { ascending: false })
                .limit(1)
                .single();

            if (processingRow?.id) {
                const { error } = await supabase.from('bot_publish_logs')
                    .update({
                        status: statusMsg,
                        ad_title: title,
                        published_at: new Date()
                    })
                    .eq('id', processingRow.id);
                if (error) throw new Error('Unable to update the publishing log');
                return processingRow.id;
            } else {
                const { data, error } = await supabase.from('bot_publish_logs').insert([{
                    bot_name: BOT_DB_NAME,
                    ad_id: adIdStr,
                    ad_title: title,
                    group_name: cleanGroupName,
                    status: statusMsg,
                    published_at: new Date()
                }]).select('id').single();
                if (error || !data?.id) throw new Error('Unable to create the publishing log');
                return data?.id || null;
            }
        }
    } catch(e) {
        throw new Error('Failed to record a publishing event in Supabase');
    }
}

// 🧠 دالة حساب استهلاك الذاكرة (RAM Tracker)
function getMemoryLog() {
    const memory = process.memoryUsage();
    const rssMB = (memory.rss / 1024 / 1024).toFixed(1);
    const heapMB = (memory.heapUsed / 1024 / 1024).toFixed(1);
    return `📊 [RAM: ${rssMB} MB | Heap: ${heapMB} MB]`;
}

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
    const { data: activePosts, error: activePostsError } = await supabase
        .from('publish_queue')
        .select(`id, groups_json, failed_count, error_message, ${BOT_GROUP_FIELD}`)
        .not(BOT_GROUP_FIELD, 'is', null);

    if (activePostsError) throw new Error('Unable to recover the previous publishing checkpoint');

    for (const activePost of activePosts || []) {
        let interruptedGroup;
        try {
            interruptedGroup = JSON.parse(activePost[BOT_GROUP_FIELD]);
        } catch {
            throw new Error('A saved publishing checkpoint is invalid; refusing to discard it');
        }
        if (!interruptedGroup || typeof interruptedGroup !== 'object') {
            throw new Error('A saved publishing checkpoint is invalid; refusing to discard it');
        }

        const { data: publishLog, error: processingLogError } = await supabase
            .from('bot_publish_logs')
            .select('id, status')
            .eq('bot_name', BOT_DB_NAME)
            .eq('ad_id', String(activePost.id))
            .eq('group_name', (interruptedGroup.name || '').trim())
            .in('status', ['PROCESSING', 'SUCCESS', 'FAILED'])
            .order('published_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (processingLogError) throw new Error('Unable to reconcile an interrupted publish log');

        if (publishLog?.id && publishLog.status !== 'SUCCESS') {
            // A FAILED or PROCESSING record is not safe to retry automatically. Preserve
            // it as a visible failure so an uncertain external publish is never duplicated.
            let priorErrors = [];
            try {
                const parsedErrors = JSON.parse(activePost.error_message || '[]');
                if (Array.isArray(parsedErrors)) priorErrors = parsedErrors;
            } catch {}
            const alreadyRecorded = priorErrors.some(item =>
                (item.url && item.url === interruptedGroup.url) ||
                (item.name && item.name === interruptedGroup.name)
            );
            if (!alreadyRecorded) priorErrors.push({
                    name: interruptedGroup.name,
                    url: interruptedGroup.url,
                    error: 'The runner stopped during this group; check its publish log before retrying.'
                });
            const { error: checkpointError } = await supabase.from('publish_queue').update({
                failed_count: priorErrors.length,
                error_message: JSON.stringify(priorErrors)
            }).eq('id', activePost.id);
            if (checkpointError) throw new Error('Unable to save the interrupted group checkpoint');

            if (publishLog.status === 'PROCESSING') {
                const { error: markLogError } = await supabase.from('bot_publish_logs').update({
                    status: 'FAILED',
                    published_at: new Date()
                }).eq('id', publishLog.id);
                if (markLogError) throw new Error('Unable to close an interrupted publishing log');
            }
        } else if (!publishLog) {
            // No PROCESSING log means the group was removed from the queue before the
            // publish attempt began, so it is safe to return it to the front of the queue.
            let queuedGroups;
            try {
                queuedGroups = JSON.parse(activePost.groups_json || '[]');
            } catch {
                throw new Error('The publish queue checkpoint is invalid; refusing to discard it');
            }
            const alreadyQueued = queuedGroups.some(group =>
                (group.url && group.url === interruptedGroup.url) ||
                (group.name && group.name === interruptedGroup.name)
            );
            if (!alreadyQueued) queuedGroups.unshift(interruptedGroup);
            const { error: requeueError } = await supabase.from('publish_queue')
                .update({ groups_json: JSON.stringify(queuedGroups) })
                .eq('id', activePost.id);
            if (requeueError) throw new Error('Unable to restore an unstarted publishing checkpoint');
        }

        const clearedFields = { [BOT_GROUP_FIELD]: null, [BOT_AI_FIELD]: null };
        const { error: clearError } = await supabase.from('publish_queue')
            .update(clearedFields)
            .eq('id', activePost.id);
        if (clearError) throw new Error('Unable to clear a recovered publishing checkpoint');
    }

    const { data: danglingLogs, error: danglingLogsError } = await supabase
        .from('bot_publish_logs')
        .select('id')
        .eq('bot_name', BOT_DB_NAME)
        .eq('status', 'PROCESSING');
    if (danglingLogsError) throw new Error('Unable to check for unfinished publishing logs');
    if (danglingLogs?.length) {
        const { error: updateLogsError } = await supabase.from('bot_publish_logs')
            .update({ status: 'FAILED', published_at: new Date() })
            .eq('bot_name', BOT_DB_NAME)
            .eq('status', 'PROCESSING');
        if (updateLogsError) throw new Error('Unable to close unfinished publishing logs');
    }

    const { data: runningPosts, error: runningPostsError } = await supabase
        .from('publish_queue')
        .select(`id, groups_json, failed_count, ${BOT_STATUS_FIELD}`)
        .eq(BOT_STATUS_FIELD, 'RUNNING');
    if (runningPostsError) throw new Error('Unable to recover the previous ad status');
    for (const runningPost of runningPosts || []) {
        let groups = [];
        try { groups = JSON.parse(runningPost.groups_json || '[]'); } catch {}
        if (groups.length > 0) {
            await updatePostStatus(runningPost.id, 'IDLE');
        } else {
            const failed = Number(runningPost.failed_count || 0) > 0;
            await updatePostStatus(runningPost.id, failed ? 'FAILED' : 'COMPLETED', {
                status: failed ? 'failed' : 'published',
                ...(!failed ? { published_at: new Date(), error_message: null } : {})
            });
        }
    }

    await logToDashboard(`✅ [${ACCOUNT_NAME}] اكتملت مراجعة واستعادة نقاط التوقف والسجلات.`, 'success');
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
        await logToDashboard(`❌ [${ACCOUNT_NAME}] تعذر قراءة طابور النشر من Supabase.`, 'error');
        throw new Error('Failed to read the publish queue from Supabase');
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
    if (error) {
        await logToDashboard(`⚠️ [${ACCOUNT_NAME}] تعذر تحديث حالة الإعلان في Supabase.`, 'error');
        throw new Error('Failed to update an ad status in Supabase');
    }
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

    // 👥 فحص ونقر زر الانضمام للمجموعة إذا لم يكن الحساب منضماً بعد
    try {
        const joinBtns = [
            'div[role="button"]:has-text("الانضمام إلى المجموعة")',
            'div[role="button"]:has-text("الانضمام")',
            'div[role="button"]:has-text("انضمام")',
            'div[role="button"]:has-text("Join group")',
            'div[role="button"]:has-text("Join Group")',
            'div[role="button"]:has-text("Join")',
            'text="الانضمام إلى المجموعة"',
            'text="Join group"'
        ];
        for (const jSel of joinBtns) {
            const jBtn = page.locator(jSel).first();
            if (await jBtn.count() > 0 && await jBtn.isVisible()) {
                await jBtn.click({ timeout: 5000, force: true });
                await logToDashboard(`👥 [المرحلة 4] [${ACCOUNT_NAME}] تم طلب الانضمام للمجموعة أولاً...`, 'info');
                await smartSleep(randomDelay(5, 10));
                break;
            }
        }
    } catch(e) {}

    // ⏳ المرحلة 4: استكشاف ونقر مربع فتح المنشور
    setStage(4, 'البحث عن مربع النشر وفتحه');
    await smartSleep(randomDelay(8, 14));

    const selectors = [
        'div[data-sigil="m-feed-composer-opener"]',
        'div[data-sigil*="composer"]',
        'span:has-text("اكتب شيئًا...")',
        'span:has-text("Write something...")',
        'text="اكتب شيئًا..."',
        'text="Write something..."',
        'text="بم تفكر؟"',
        'text="What\'s on your mind?"',
        'text="إنشاء منشور عام..."',
        'text="Create a public post..."',
        'text="ماذا تبيع؟"',
        'text="What are you selling?"',
        'text="عرض عنصر للبيع"',
        'text="Sell something"',
        'text="عنصر للبيع"',
        'text="Item for sale"',
        'text="بيع شيء ما"',
        'div[role="button"]:has-text("اكتب شيئًا...")',
        'div[role="button"]:has-text("Write something...")',
        'div[role="button"]:has-text("بم تفكر؟")',
        'div[role="button"]:has-text("What\'s on your mind?")',
        'div[role="button"]:has-text("إنشاء منشور عام...")',
        'div[role="button"]:has-text("Create a public post...")',
        'div[role="button"]:has-text("ماذا تبيع")',
        'div[role="button"]:has-text("عنصر للبيع")',
        'div[role="button"]:has-text("بيع")',
        'div[role="button"]:has-text("Sell")',
        'div[role="button"]:has-text("بدء مناقشة")',
        'div[role="button"]:has-text("مناقشة")',
        'div[role="button"]:has-text("Discussion")',
        'div[aria-label*="Create a public post"]',
        'div[aria-label*="إنشاء منشور"]',
        'div[aria-label*="Write something"]',
        'div[aria-label*="اكتب شيئ"]',
        'div[role="textbox"]',
        '[contenteditable="true"]',
        'span:has-text("اكتب شيئاً...")',
        'text="اكتب شيئاً..."',
        'div[role="button"]:has-text("اكتب شيئاً...")',
        'span:has-text("اكتب")',
        'span:has-text("Write")',
        'div[role="button"]:has-text("اكتب")',
        'div[role="button"]:has-text("Write")',
        'div[role="button"]:has-text("Photo")',
        'div[role="button"]:has-text("Photos")',
        'div[role="button"]:has-text("صورة")',
        'div[role="button"]:has-text("الصور")',
        'text="Photo"',
        'text="Photos"',
        'text="صورة"',
        'text="الصور"',
        'text=/اكتب/i',
        'text=/تفكر/i',
        'text=/بم تفكر/i',
        'a[href*="/composer/"]',
        'a[href*="multi_step_composer"]',
        'a[href*="for_sale"]'
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
        'a[href*="/discussion"]', 'div[role="button"]:has-text("مناقشة")',
        'div[role="button"]:has-text("عنصر للبيع")', 'div[role="button"]:has-text("Sell")',
        'text=عرض عنصر للبيع', 'text=Sell something'
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
            const elements = Array.from(document.querySelectorAll('div[role="button"], span, div, a, [data-sigil*="composer"]'));
            const target = elements.find(el => {
                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
                return (
                    txt.includes('اكتب شيئ') || 
                    txt.includes('write something') || 
                    txt.includes('بم تفكر') || 
                    txt.includes("what's on your mind") || 
                    txt.includes('إنشاء منشور') || 
                    txt.includes('create a public post') || 
                    txt.includes('ماذا تبيع') || 
                    txt.includes('عنصر للبيع') || 
                    txt.includes('sell something') || 
                    txt.includes('بدء مناقشة') || 
                    txt.includes('مناقشة') || 
                    aria.includes('اكتب') || 
                    aria.includes('write') || 
                    aria.includes('إنشاء منشور') || 
                    aria.includes('create a post') || 
                    aria.includes('create a public post')
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
    // ⏳ المرحلة 7: التركيز على الحقل ولصق النص ومحاكاة الكتابة البشرية
    setStage(7, 'التركيز على الحقل ولصق النص ومحاكاة الكتابة البشرية');
    await smartSleep(randomDelay(4, 8));

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
            await smartSleep(1500);

            const tagName = await textbox.evaluate(el => el.tagName.toLowerCase());
            if (tagName === 'textarea' || tagName === 'input') {
                await textbox.fill(postText);
                await logToDashboard(`✅ [المرحلة 7] [${ACCOUNT_NAME}] تم كتابة النص داخل حقل الـ textarea بنجاح`, 'success');
                return;
            }

            await page.keyboard.insertText(postText);
            await logToDashboard(`✅ [المرحلة 7] [${ACCOUNT_NAME}] تم إدخال النص مع الحفاظ على الأسطر بنجاح`, 'success');
            return;
        } catch (err) {
            await logToDashboard(`⚠️ [المرحلة 7] [${ACCOUNT_NAME}] تنبيه أثناء إدخال النص، محاولة بالـ DOM المباشر...`, 'info');
        }
    }

    try {
        await page.evaluate((text) => {
            const activeInput = document.querySelector('textarea, div[contenteditable="true"], div[role="textbox"]');
            if (activeInput) {
                activeInput.focus();
                if (activeInput.tagName.toLowerCase() === 'textarea') {
                    activeInput.value = text;
                    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
                    activeInput.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    document.execCommand('insertText', false, text);
                }
            }
        }, postText);
        await logToDashboard(`✅ [المرحلة 7] [${ACCOUNT_NAME}] تم إدخال النص بطريقة البديلة (DOM Trigger)`, 'success');
    } catch(e) {
        throw new Error('تعذر العثور على حقل نص صالح للكتابة داخل هذه المجموعة');
    }
}

async function publishToGroup(page, group, post, imagePath, geminiApiKey) {
    startStageWatchdog();

    try {
        // ⏳ المرحلة 1: فتح المجموعة بوضع الجوال مع التحقق الصارم من الرابط
        let targetUrl = (group.url || group.link || group.href || '').trim();

        if (!targetUrl || targetUrl === 'undefined' || targetUrl === 'null') {
            setStage(1, `البحث عن المجموعة باسمها (${group.name})`);
            const searchUrl = `https://m.facebook.com/search/groups/?q=${encodeURIComponent(group.name)}`;
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
            await smartSleep(randomDelay(4, 8));

            try {
                const groupLink = await page.$('a[href*="/groups/"]');
                if (groupLink) {
                    const href = await groupLink.getAttribute('href');
                    if (href) {
                        targetUrl = href.startsWith('http') ? href : `https://m.facebook.com${href}`;
                    }
                }
            } catch(e) {}
        }

        if (!targetUrl || !targetUrl.includes('facebook.com')) {
            throw new Error(`تعذر العثور على رابط صالح لمجموعة: "${group.name}"`);
        }

        targetUrl = targetUrl.replace('www.facebook.com', 'm.facebook.com');
        if (!targetUrl.includes('m.facebook.com') && !targetUrl.includes('mbasic.facebook.com')) {
            targetUrl = targetUrl.replace('facebook.com', 'm.facebook.com');
        }
        const separator = targetUrl.includes('?') ? '&' : '?';
        targetUrl = `${targetUrl}${separator}sorting_setting=CHRONOLOGICAL`;

        setStage(1, `فتح صفحة المجموعة بوضع الجوال (${group.name}) واستقرار العناصر`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        
        const loadWait = randomDelay(25, 38);
        await logToDashboard(`⏳ [المرحلة 1] [${ACCOUNT_NAME}] تم تحميل الصفحة، ننتظر ${Math.round(loadWait/1000)} ثانية لاستقرار كل العناصر...`, 'info');
        await smartSleep(loadWait); 

        // ⏳ المرحلة 2: الفحص الأمني للجلسة واستقرار الحساب
        setStage(2, 'الفحص الأمني للجلسة واستقرار الحساب');
        await logToDashboard(`✅ [المرحلة 2] [${ACCOUNT_NAME}] تم تأكيد استقرار الجلسة والانتقال لفتح المنشور`, 'success');

        // ⏳ المرحلة 3 و 4: تبويب مناقشة وفتح مربع المنشور
        const opened = await openPostBox(page);
        if (!opened) throw new Error('لم يتم العثور على مربع النشر (قد تكون الصلاحيات مختلفة)');

        await smartSleep(randomDelay(8, 14)); 

        // ⏳ المرحلة 5: تجهيز وصياغة محتوى الذكاء الاصطناعي
        setStage(5, 'تجهيز وصياغة محتوى الإعلان بالذكاء الاصطناعي');
        await logToDashboard(`🧠 [المرحلة 5] إعادة صياغة الإعلان والتحقق منه لهذه المجموعة.`, 'info');
        const generatedText = await rewriteAdWithGemini(post.ad_title, post.ad_description, {
            apiKey: geminiApiKey,
            log: (message) => logToDashboard(message, message.startsWith('Gemini rewrite accepted') ? 'success' : 'info')
        });
        let postText = generatedText;
        const fbUrl = String(post.facebook_url || '').trim();
        if (fbUrl && !postText.includes(fbUrl)) postText += `\n\n${fbUrl}`;

        // ⏳ المرحلة 6: رفع الميديا ومعاينة الملف
        if (imagePath) {
            const isVideoFile = imagePath.endsWith('.mp4') || imagePath.endsWith('.mov') || imagePath.endsWith('.webm') || imagePath.endsWith('.mkv') || imagePath.endsWith('.avi');
            setStage(6, `رفع الملف المرفق (${isVideoFile ? 'فيديو' : 'صورة'}) ومعاينة الرفع`);
            
            let isFileInjected = false;

            // محاولة 1: الحقن المباشر في عنصر الـ input
            try {
                const allFileInputs = page.locator('input[type="file"]');
                const count = await allFileInputs.count();
                if (count > 0) {
                    await allFileInputs.first().setInputFiles(imagePath, { timeout: 12000 });
                    isFileInjected = true;
                    await logToDashboard(`🖼️ [المرحلة 6] [${ACCOUNT_NAME}] تم حقن مسار الملف مباشرة في الـ input بنجاح.`, 'success');
                }
            } catch (e) {}

            // محاولة 2: إذا لم يظهر الـ input إلا بعد نقر زر إضافة صورة/فيديو
            if (!isFileInjected) {
                const imageTriggerSelectors = [
                    'div[aria-label="صورة/فيديو"]',
                    'div[aria-label="Photo/video"]',
                    'div[aria-label="صورة"]',
                    'div[aria-label="Photo"]',
                    'div[aria-label="Photos"]',
                    'div[aria-label="الصور"]',
                    'svg[aria-label="صورة/فيديو"]',
                    'svg[aria-label="Photo/video"]',
                    'div:has-text("صورة/فيديو")',
                    'div:has-text("Photo/video")',
                    'div:has-text("صورة")',
                    'div:has-text("الصور")',
                    'div:has-text("Photo")',
                    'div:has-text("Photos")',
                    'span:has-text("Photo")',
                    'span:has-text("Photos")',
                    'span:has-text("صورة")',
                    'div[role="button"]:has(input[type="file"])',
                    '[data-sigil*="photo"]',
                    '[data-sigil*="camera"]'
                ];

                for (const trigSel of imageTriggerSelectors) {
                    try {
                        const trigElement = page.locator(trigSel).first();
                        if (await trigElement.count() > 0 && await trigElement.isVisible()) {
                            const [fileChooser] = await Promise.all([
                                page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
                                trigElement.click({ timeout: 4000, force: true }).catch(() => {})
                            ]);

                            if (fileChooser) {
                                await fileChooser.setFiles(imagePath);
                                isFileInjected = true;
                                await logToDashboard(`🖼️ [المرحلة 6] [${ACCOUNT_NAME}] تم رفع الملف عبر معالج FileChooser بنجاح.`, 'success');
                                break;
                            }

                            await smartSleep(1500);
                            const fileInputAfter = page.locator('input[type="file"]').first();
                            if (await fileInputAfter.count() > 0) {
                                await fileInputAfter.setInputFiles(imagePath, { timeout: 8000 });
                                isFileInjected = true;
                                break;
                            }
                        }
                    } catch (e) {}
                }
            }

            if (isFileInjected) {
                const waitTime = isVideoFile ? 20000 : 5000;
                await logToDashboard(`🖼️ [المرحلة 6] [${ACCOUNT_NAME}] تم إرفاق الملف، ننتظر ${waitTime/1000} ثوانٍ لمعاينة الصورة...`, 'success');
                await smartSleep(waitTime);
            } else {
                await logToDashboard(`⚠️ [المرحلة 6] [${ACCOUNT_NAME}] تعذر العثور على حقل رفع الملفات، سيتم النشر كنص فقط.`, 'info');
            }
        }

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

        // 🟢 خطوة حاسمة: تنشيط فوري لمحرر فيسبوك بالسبيس وإطلاق الـ Events لتفعيل زر النشر فوراً
        await logToDashboard(`⌨️ [المرحلة 9] [${ACCOUNT_NAME}] تنشيط محرر فيسبوك بالسبيس لتفعيل زر النشر...`, 'info');
        try {
            await page.evaluate(() => {
                const editor = document.querySelector('textarea, [contenteditable="true"], div[role="textbox"]');
                if (editor) {
                    editor.focus();
                    editor.dispatchEvent(new Event('input', { bubbles: true }));
                    editor.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            await page.keyboard.press('Space');
            await smartSleep(400);
            await page.keyboard.press('Backspace');
            await smartSleep(1500);
        } catch (e) {}
        
        const targetButtonSelectors = [
            // 1. محددات فيسبوك الجوال الرسمية (Mobile Web Composer Submit)
            'form[action*="composer"] button[type="submit"]',
            'form[action*="composer"] input[type="submit"]',
            'button[name="view_post"]',
            'input[name="view_post"]',
            'div[data-sigil*="composer-submit"]',
            'button[data-sigil*="composer-submit"]',
            'button[data-sigil*="submit"]',
            'div[data-sigil*="submit"]',
            'button[value="نشر"]',
            'button[value="Post"]',
            'button[value="POST"]',
            'button[value="مشاركة"]',
            'button[value="Share"]',
            'input[value="نشر"]',
            'input[value="Post"]',
            'input[value="POST"]',
            
            // 2. محددات الحوار والنافذة والهيدر
            'div[role="dialog"] button[type="submit"]',
            'div[role="dialog"] div[role="button"][aria-label="نشر"]',
            'div[role="dialog"] div[role="button"][aria-label="Post"]',
            'div[role="dialog"] div[role="button"][aria-label="POST"]',
            'div[role="dialog"] div[role="button"][aria-label="مشاركة"]',
            'div[role="dialog"] div[role="button"][aria-label="Share"]',
            'div[role="dialog"] div[role="button"]:has-text("نشر")',
            'div[role="dialog"] div[role="button"]:has-text("Post")',
            'div[role="dialog"] div[role="button"]:has-text("POST")',
            'div[role="dialog"] button:has-text("نشر")',
            'div[role="dialog"] button:has-text("Post")',
            'div[role="dialog"] button:has-text("POST")',
            'header button:has-text("نشر")',
            'header button:has-text("Post")',
            'header button:has-text("POST")',
            'header div[role="button"]:has-text("نشر")',
            'header div[role="button"]:has-text("Post")',
            'header div[role="button"]:has-text("POST")',
            'div[data-mcomponent="ServerHeader"] div[role="button"]',
            'button[type="submit"]:has-text("نشر")',
            'button[type="submit"]:has-text("Post")',
            'button[type="submit"]:has-text("POST")',
            'button[type="submit"]:has-text("مشاركة")',
            'button[type="submit"]:has-text("Share")',
            'div[role="button"][aria-label="نشر"]',
            'div[role="button"][aria-label="Post"]',
            'div[role="button"][aria-label="POST"]',
            'div[role="button"][aria-label="مشاركة"]',
            'div[role="button"][aria-label="Share"]',
            'div[aria-label="نشر"]',
            'div[aria-label="Post"]',
            'div[aria-label="POST"]',
            'div[aria-label="مشاركة"]',
            'div[aria-label="Share"]',
            'div[role="button"]:has-text("نشر")',
            'div[role="button"]:has-text("Post")',
            'div[role="button"]:has-text("POST")',
            'button:has-text("نشر")',
            'button:has-text("Post")',
            'button:has-text("POST")',
            'text="نشر"',
            'text="Post"',
            'text="POST"'
        ];

        let published = false;

        // المستوى 1: الفحص الفوري المباشر بالـ DOM والنقر الفوري في أجزاء من الثانية
        try {
            published = await page.evaluate(() => {
                // أ) فحص أي زر داخل نموذج الكومبوزر
                const composerForm = document.querySelector('form[action*="composer"], form[data-pagelet*="Composer"], form[data-sigil*="m-composer"], form[data-sigil*="composer"]');
                if (composerForm) {
                    const submitBtn = composerForm.querySelector('button[type="submit"], input[type="submit"], button[name="view_post"], input[name="view_post"], [data-sigil*="composer-submit"]');
                    if (submitBtn) {
                        submitBtn.removeAttribute('disabled');
                        submitBtn.setAttribute('aria-disabled', 'false');
                        submitBtn.click();
                        submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        return true;
                    }
                    if (typeof composerForm.submit === 'function') {
                        composerForm.submit();
                        return true;
                    }
                }

                // ب) فحص أزرار الـ Submit والمحددات الصريحة
                const targetSelectors = [
                    '[data-sigil*="composer-submit"]',
                    '[data-sigil*="submit"]',
                    'button[name="view_post"]',
                    'input[name="view_post"]',
                    'button[value="نشر"]',
                    'button[value="Post"]',
                    'button[value="POST"]',
                    'button[value="مشاركة"]',
                    'button[value="Share"]',
                    'input[value="نشر"]',
                    'input[value="Post"]',
                    'input[value="POST"]',
                    'button[type="submit"]',
                    'input[type="submit"]',
                    'div[role="dialog"] button',
                    'header button',
                    'header div[role="button"]',
                    'div[data-mcomponent="ServerHeader"] div[role="button"]'
                ];

                for (const sel of targetSelectors) {
                    const els = Array.from(document.querySelectorAll(sel));
                    for (const el of els) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            el.removeAttribute('disabled');
                            el.setAttribute('aria-disabled', 'false');
                            el.click();
                            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                            return true;
                        }
                    }
                }

                // ج) فحص كل الأزرار بالـ Text والـ Aria-Label
                const allBtns = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"], input[type="button"], input[type="submit"]'));
                for (const btn of allBtns) {
                    const txt = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                    const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
                    const val = (btn.getAttribute('value') || '').trim().toLowerCase();

                    const isPostBtn = 
                        txt === 'نشر' || txt === 'post' || txt === 'مشاركة' || txt === 'share' || txt === 'publish' ||
                        aria === 'نشر' || aria === 'post' || aria === 'مشاركة' || aria === 'share' || aria.includes('نشر') || aria.includes('post') ||
                        val === 'نشر' || val === 'post';

                    if (isPostBtn) {
                        const rect = btn.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            btn.removeAttribute('disabled');
                            btn.setAttribute('aria-disabled', 'false');
                            btn.click();
                            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                            return true;
                        }
                    }
                }

                return false;
            });

            if (published) {
                await logToDashboard(`🚀 [المرحلة 9] [${ACCOUNT_NAME}] تم النقر على زر النشر بنجاح عبر (Direct DOM Trigger)!`, 'success');
            }
        } catch (e) {}

        // المستوى 2: فحص عبر Playwright Locators السريعة في حال لم ينقر الـ DOM
        if (!published) {
            for (const sel of targetButtonSelectors) {
                try {
                    const locator = page.locator(sel).first();
                    if (await locator.count() > 0 && await locator.isVisible()) {
                        await locator.click({ timeout: 4000, force: true, noWaitAfter: true });
                        published = true;
                        await logToDashboard(`🚀 [المرحلة 9] [${ACCOUNT_NAME}] تم النقر على زر النشر عبر المحدد (${sel}) بنجاح!`, 'success');
                        break;
                    }
                } catch (e) {}
            }
        }

        // ⏳ المرحلة 10: مراقبة وتأكيد خروج المنشور واختفاء شاشة الكتابة
        setStage(10, 'متابعة رد فيسبوك وتأكيد وصول المنشور للمجموعة');
        
        let isPublishedConfirmed = false;
        for (let checkAttempt = 0; checkAttempt < 6; checkAttempt++) {
            await smartSleep(4000);
            const checkResult = await page.evaluate(() => {
                const bodyText = document.body.innerText || '';
                
                const isPendingAdmin = 
                    bodyText.includes('منشورك قيد المراجعة') ||
                    bodyText.includes('تم إرسال المنشور للمسؤول') ||
                    bodyText.includes('تم إرسال منشورك إلى مسؤول') ||
                    bodyText.includes('بانتظار موافقة المسؤول') ||
                    bodyText.includes('بانتظار الموافقة') ||
                    bodyText.includes('pending admin approval') ||
                    bodyText.includes('submitted to admin') ||
                    bodyText.includes('post is pending');

                const activeInput = document.querySelector('textarea[name="xc_message"], textarea[data-sigil*="composer"], div[contenteditable="true"], div[role="textbox"]');
                const isInputStillPresent = activeInput && activeInput.offsetParent !== null && (activeInput.innerText || activeInput.value || '').trim().length > 10;
                const isStillInComposerUrl = window.location.href.includes('/composer/');

                return {
                    isPendingAdmin,
                    isInputStillPresent,
                    isStillInComposerUrl
                };
            });

            if (checkResult.isPendingAdmin) {
                await logToDashboard(`✅ [المرحلة 10] [${ACCOUNT_NAME}] المنشور تم إرساله بنجاح وهو الآن (قيد مراجعة الأدمن).`, 'success');
                isPublishedConfirmed = true;
                break;
            } else if (!checkResult.isInputStillPresent && !checkResult.isStillInComposerUrl) {
                await logToDashboard(`✅ [المرحلة 10] [${ACCOUNT_NAME}] تم تأكيد نشر المنشور بنجاح واختفاء واجهة التحرير!`, 'success');
                isPublishedConfirmed = true;
                break;
            }
        }

        if (!isPublishedConfirmed) {
            // محاولة نقر أخيرة طارئة قبل إعلان الفشل
            const emergencyClicked = await page.evaluate(() => {
                const submitBtn = document.querySelector('button[name="view_post"], [data-sigil*="composer-submit"], form[action*="composer"] button[type="submit"], button[value="نشر"], button[value="Post"], button[value="POST"]');
                if (submitBtn) { submitBtn.click(); return true; }
                return false;
            });

            if (emergencyClicked) {
                await smartSleep(8000);
                await logToDashboard(`🚀 [المرحلة 10] [${ACCOUNT_NAME}] تم تنفيذ نقرة الإرسال بنجاح!`, 'success');
            } else {
                await logToDashboard(`⚠️ [المرحلة 10] [${ACCOUNT_NAME}] تم النقر على النشر وإنهاء المعالجة.`, 'info');
            }
        }

        let isUploadedVideo = imagePath && (imagePath.endsWith('.mp4') || imagePath.endsWith('.mov') || imagePath.endsWith('.webm') || imagePath.endsWith('.mkv') || imagePath.endsWith('.avi'));
        let finalWait = isUploadedVideo ? 25000 : 8000;
        await smartSleep(finalWait); 
    } finally {
        stopStageWatchdog();
    }
}

async function processOnePost(post, accountCookies, geminiApiKey) {
    await logToDashboard(`🔥 [${ACCOUNT_NAME}] بدأ معالجة الإعلان: ${post.ad_title}`, 'info');
    
    await updatePostStatus(post.id, 'RUNNING', { started_at: new Date() });
    await updateBotLastActive('RUNNING');

    let mediaUrl = '';
    let isVideoPost = false; 

    if (post.ad_video && post.ad_video.trim() !== '') {
        mediaUrl = post.ad_video.trim();
        isVideoPost = true; 
        await logToDashboard(`🎥 [${ACCOUNT_NAME}] تم رصد فيديو في حقل الإعلان.`, 'info');
    } else if (post.video_url && post.video_url.trim() !== '') {
        mediaUrl = post.video_url.trim();
        isVideoPost = true; 
        await logToDashboard(`🎥 [${ACCOUNT_NAME}] تم رصد فيديو في حقل الإعلان.`, 'info');
    } else if (post.ad_image && post.ad_image.trim() !== '') {
        mediaUrl = post.ad_image.trim();
        const lowerImg = mediaUrl.toLowerCase();
        if (lowerImg.includes('.mp4') || lowerImg.includes('.mov') || lowerImg.includes('.webm') || lowerImg.includes('.mkv') || lowerImg.includes('.avi')) {
            isVideoPost = true; 
            await logToDashboard(`🎥 [${ACCOUNT_NAME}] تم رصد فيديو في حقل الإعلان.`, 'info');
        } else {
            await logToDashboard(`📸 [${ACCOUNT_NAME}] تم رصد صورة في حقل الإعلان.`, 'info');
        }
    }

    let imagePath = null;
    let originalImagePath = null;
    let creativeImagePath = null;
    const removeTemporaryMedia = () => {
        for (const filePath of new Set([imagePath, originalImagePath, creativeImagePath].filter(Boolean))) {
            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
        }
    };
    if (mediaUrl !== '') {
        try {
            originalImagePath = await downloadImage(mediaUrl, isVideoPost);
            imagePath = originalImagePath;
            if (!isVideoPost) {
                try {
                    creativeImagePath = await createCreativeVariant(originalImagePath);
                    if (creativeImagePath) {
                        imagePath = creativeImagePath;
                        await logToDashboard(`🖼️ [${ACCOUNT_NAME}] تم تجهيز نسخة صورة بإطار هامشي بسيط؛ الأصل محفوظ دون تغيير.`, 'info');
                    }
                } catch {
                    await logToDashboard(`⚠️ [${ACCOUNT_NAME}] تعذرت معالجة الصورة؛ سيُستخدم الأصل كما هو.`, 'info');
                }
            }
            if (imagePath) await logToDashboard(`🖼️ [${ACCOUNT_NAME}] تم تحميل ملف الوسائط المؤقت وتجهيزه.`, 'success');
        } catch (err) {
            await logToDashboard(`⚠️ [${ACCOUNT_NAME}] تعذر تحميل الوسيط؛ سيستمر النشر بالنص فقط.`, 'info');
        }
    } else {
        await logToDashboard(`ℹ️ [${ACCOUNT_NAME}] الإعلان لا يحتوي على ملف مرفوع. سيعتمد النشر على النص والروابط فقط.`, 'info');
    }

    // Browser settings for media processing on the GitHub-hosted runner.
    let browser;
    try {
        browser = await chromium.launch({
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
    } catch (error) {
        removeTemporaryMedia();
        throw error;
    }

    let context;
    try {
        context = await browser.newContext({
            viewport: { width: 393, height: 851 },
            isMobile: true,
            hasTouch: true,
            userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
            permissions: ['clipboard-read', 'clipboard-write']
        });

        await context.route('**/*', (route) => {
            const resourceType = route.request().resourceType();
            if (resourceType === 'font') return route.abort();
            return route.continue();
        });
        await context.addCookies(accountCookies);
        await logToDashboard(`✅ [${ACCOUNT_NAME}] تم إعداد جلسة المتصفح من كوكيز Supabase.`, 'success');
    } catch (error) {
        if (context) await context.close().catch(() => {});
        await browser.close().catch(() => {});
        removeTemporaryMedia();
        throw new Error('Unable to prepare the browser session from Supabase cookies');
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
    let stoppedByUser = false;

    try {
        while (true) {
            if (!hasActionTime(ACTION_WORK_RESERVE_MS)) {
                await logToDashboard(`⏱️ [${ACCOUNT_NAME}] انتهت نافذة التشغيل الآمنة؛ تم حفظ نقطة التوقف.`, 'info');
                stoppedByUser = true;
                break;
            }

            // 🛑 1. فحص الحد اليومي (15 مجموعة)
            const limitReached = await checkDailyLimit();
            if (limitReached) {
                await logToDashboard(`🛑 [${ACCOUNT_NAME}] تم الوصول للحد الأقصى اليومي (15 مجموعة). جاري إيقاف البوت وتحويله إلى IDLE...`, 'error');
                await updateBotLastActive('IDLE');
                stoppedByUser = true;
                break;
            }

            // 🛑 2. الاستشعار الديناميكي لحالة اللوحة (IDLE) قبل كل مجموعة
            let currentStatus = await getBotStatus();
            if (currentStatus === 'IDLE') {
                await logToDashboard(`🛑 [${ACCOUNT_NAME}] تم رصد أمر إيقاف (IDLE) من اللوحة، جاري الانسحاب...`, 'info');
                stoppedByUser = true;
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

            let currentLogId = null;
            const initialAiTitle = freshPost[BOT_AI_FIELD] || freshPost.ai_final_text || freshPost.ad_title;
            try {
                // 🚀 إرسال حالة (جاري النشر) لتظهر برتقالية في لوحة التحكم
                currentLogId = await logPublishEvent(freshPost, targetGroup.name, 'PROCESSING', initialAiTitle);

                // 🚀 تشغيل النشر بالمراحل المستقلة دون مؤقت إجمالي يخنقه (مطابقة تامة للبوت 2)
                await publishToGroup(page, targetGroup, freshPost, imagePath, geminiApiKey);
                successCount++;
                
                const { data: latestPost } = await supabase.from('publish_queue').select('*').eq('id', post.id).single();
                let finalAiText = latestPost?.[BOT_AI_FIELD] || latestPost?.ai_final_text || freshPost[BOT_AI_FIELD] || freshPost.ai_final_text || freshPost.ad_title;
                
                await logPublishEvent(latestPost || freshPost, targetGroup.name, 'SUCCESS', finalAiText, currentLogId);
                await incrementBotCounters();

            } catch (err) {
                if (err.message === 'STOPPED_BY_USER') {
                    stoppedByUser = true;
                    failedCount++;
                    failedGroups.push({
                        name: targetGroup.name,
                        url: targetGroup.url,
                        error: 'Stop requested while publishing; verify the Facebook group before retrying.'
                    });
                    await logPublishEvent(freshPost, targetGroup.name, 'FAILED', initialAiTitle, currentLogId);
                    break;
                }

                if (!currentLogId) {
                    const { data: queuedPost, error: queuedPostError } = await supabase
                        .from('publish_queue').select('groups_json').eq('id', post.id).single();
                    if (queuedPostError) throw new Error('Unable to restore the group after checkpoint logging failed');
                    let queuedGroups = [];
                    try { queuedGroups = JSON.parse(queuedPost.groups_json || '[]'); } catch {}
                    const isQueued = queuedGroups.some(group =>
                        (group.url && group.url === targetGroup.url) ||
                        (group.name && group.name === targetGroup.name)
                    );
                    if (!isQueued) queuedGroups.unshift(targetGroup);
                    const { error: restoreError } = await supabase.from('publish_queue')
                        .update({ groups_json: JSON.stringify(queuedGroups) }).eq('id', post.id);
                    if (restoreError) throw new Error('Unable to restore the group after checkpoint logging failed');
                    throw new Error('Publishing stopped because its Supabase checkpoint could not be saved');
                }

                const isFatalCheckpoint = err.message && err.message.startsWith('FATAL_CHECKPOINT_OR_LOGIN_EXPIRED');
                if (isFatalCheckpoint) {
                    await logToDashboard(`🚨 [${ACCOUNT_NAME}] مشكلة تسجيل دخول أو نقطة تحقق؛ تم إيقاف الدفعة وتحويلها إلى IDLE.`, 'error');
                    await updateBotLastActive('IDLE');
                    await logPublishEvent(freshPost, targetGroup.name, 'FAILED', initialAiTitle, currentLogId);
                    stoppedByUser = true;
                    break;
                }

                failedCount++;
                const safePublishError = 'Publishing step failed; review the browser and dashboard logs.';
                failedGroups.push({ name: targetGroup.name, url: targetGroup.url, error: safePublishError });
                await logToDashboard(`❌ [${ACCOUNT_NAME}] فشل النشر في المجموعة: ${targetGroup.name}.`, 'error');
                
                const { data: latestPostFail } = await supabase.from('publish_queue').select('*').eq('id', post.id).single();
                let finalAiTextFail = latestPostFail?.[BOT_AI_FIELD] || latestPostFail?.ai_final_text || freshPost[BOT_AI_FIELD] || freshPost.ai_final_text || freshPost.ad_title;
                
                await logPublishEvent(latestPostFail || freshPost, targetGroup.name, 'FAILED', finalAiTextFail, currentLogId);

            } finally {
                await page.close();
                await logToDashboard(`🧹 [${ACCOUNT_NAME}] تم تدمير صفحة المجموعة وتفريغ الذاكرة.`, 'info');

                // دمج الأخطاء مع أي أخطاء سابقة مسجلة لضمان عدم ضياع أي مجموعة إطلاقاً
                let currentAllErrors = [...failedGroups];
                try {
                    const { data: latestRow } = await supabase.from('publish_queue').select('error_message').eq('id', post.id).single();
                    if (latestRow && latestRow.error_message) {
                        const parsed = JSON.parse(latestRow.error_message);
                        if (Array.isArray(parsed)) {
                            parsed.forEach(p => {
                                if (!currentAllErrors.some(c => (c.name && c.name === p.name) || (c.url && c.url === p.url))) {
                                    currentAllErrors.push(p);
                                }
                            });
                        }
                    }
                } catch(e){}

                const resetPayload = {
                    success_count: successCount,
                    failed_count: currentAllErrors.length,
                    error_message: JSON.stringify(currentAllErrors)
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
                if (e.message === 'STOPPED_BY_USER') {
                    stoppedByUser = true;
                    break;
                }
            }
        }
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        removeTemporaryMedia();
        await logToDashboard(`🧹 [${ACCOUNT_NAME}] تم إغلاق المتصفح وتفريغ الذاكرة بنجاح!`, 'success');
    }

    const { data: finalPost } = await supabase.from('publish_queue').select('groups_json').eq('id', post.id).single();
    let finalGroups = [];
    try { finalGroups = JSON.parse(finalPost.groups_json || '[]'); } catch(e){}

    if (stoppedByUser && finalGroups.length > 0) {
        await updatePostStatus(post.id, 'IDLE');
        await updateBotLastActive('IDLE');
    } else if (finalGroups.length === 0 && failedCount === 0) {
        await updatePostStatus(post.id, 'COMPLETED', { published_at: new Date(), error_message: null, status: 'published' });
        await logToDashboard(`✅ [${ACCOUNT_NAME}] تم نشر الإعلان في المجموعات بنجاح.`, 'success');
    } else if (finalGroups.length === 0) {
        await updatePostStatus(post.id, 'FAILED', { error_message: JSON.stringify(failedGroups), status: 'failed' });
        await logToDashboard(`❌ [${ACCOUNT_NAME}] اكتملت المجموعات مع وجود إخفاقات مخزنة في الأخطاء. تم تغيير الحالة إلى (FAILED).`, 'error');
    }
}

async function start() {
    let cleanupTimer;
    try {
        await logToDashboard(`🚀 [${ACCOUNT_NAME}] بدء تشغيل دفعة النشر عند الطلب.`, 'info');

        let currentStatus = await getBotStatus();
        if (currentStatus === 'IDLE') {
            await logToDashboard(`ℹ️ [${ACCOUNT_NAME}] الحالة IDLE؛ لا توجد دفعة نشطة لإنهائها.`, 'info');
            await updateBotLastActive('IDLE');
            return;
        }

        if (await checkDailyLimit()) {
            await logToDashboard(`🛑 [${ACCOUNT_NAME}] تم بلوغ حد 15 مجموعة لهذا اليوم.`, 'info');
            await updateBotLastActive('IDLE');
            return;
        }

        await resetStuckPosts();
        const accountCookies = await getAccountCookies();
        const geminiApiKey = await getVaultSecret('GEMINI_API_KEY');
        await cleanOldLogs();
        cleanupTimer = setInterval(() => {
            cleanOldLogs().catch(() => {});
        }, 24 * 60 * 60 * 1000);

        await logToDashboard(`✅ [${ACCOUNT_NAME}] الاتصال بالطابور جاهز.`, 'success');

        while (true) {
            currentStatus = await getBotStatus();
            if (currentStatus === 'IDLE') {
                await logToDashboard(`🛑 [${ACCOUNT_NAME}] وصل أمر الإيقاف من لوحة التحكم.`, 'info');
                await updateBotLastActive('IDLE');
                return;
            }

            if (await checkDailyLimit()) {
                await logToDashboard(`🛑 [${ACCOUNT_NAME}] اكتمل حد 15 مجموعة؛ أنهاء دفعة التشغيل.`, 'info');
                await updateBotLastActive('IDLE');
                return;
            }

            const post = await getNextPendingPost();
            if (!post) {
                await logToDashboard(`✅ [${ACCOUNT_NAME}] انتهى طابور الإعلانات المتاحة.`, 'success');
                await updateBotLastActive('IDLE');
                return;
            }

            await processOnePost(post, accountCookies, geminiApiKey);

            if (await checkDailyLimit()) {
                await logToDashboard(`🛑 [${ACCOUNT_NAME}] اكتمل حد 15 مجموعة؛ تم إنهاء الدفعة بنجاح.`, 'success');
                await updateBotLastActive('IDLE');
                return;
            }

            if ((await getBotStatus()) === 'IDLE') {
                await updateBotLastActive('IDLE');
                return;
            }

            if (!(await getNextPendingPost())) {
                await logToDashboard(`✅ [${ACCOUNT_NAME}] انتهى طابور الإعلانات المتاحة.`, 'success');
                await updateBotLastActive('IDLE');
                return;
            }

            const delay = randomDelay(1200, 2400); // Keep the existing 20-40 minute interval.
            if (!hasActionTime(delay + ACTION_WORK_RESERVE_MS)) {
                await logToDashboard(`⏱️ [${ACCOUNT_NAME}] سيتم استكمال الإعلان التالي في تشغيل لاحق؛ نقطة التوقف محفوظة.`, 'info');
                await updateBotLastActive('IDLE');
                return;
            }
            await logToDashboard(`⏳ [${ACCOUNT_NAME}] استراحة بين الإعلانين: ${Math.round(delay / 1000 / 60)} دقيقة.`, 'info');
            try {
                await smartSleep(delay);
            } catch (error) {
                if (error.message !== 'STOPPED_BY_USER') throw error;
                await updateBotLastActive('IDLE');
                return;
            }
        }
    } catch (error) {
        const safeCookieErrors = new Set([
            `No cookies are configured in Supabase for account ${ACCOUNT_NUM}`,
            `Cookies configured for account ${ACCOUNT_NUM} are invalid`,
            'Unable to read this account\'s cookies from Supabase'
        ]);
        const safeDetail = safeCookieErrors.has(error.message)
            ? error.message
            : 'Unexpected runner error';
        await logToDashboard(`❌ [${ACCOUNT_NAME}] ${safeDetail}; سيتم تحويل الحالة إلى IDLE.`, 'error');
        try { await updateBotLastActive('IDLE'); } catch {}
        throw error;
    } finally {
        if (cleanupTimer) clearInterval(cleanupTimer);
    }
}

async function cleanupRun() {
    let recoveryFailure = null;
    try {
        await resetStuckPosts();
    } catch {
        recoveryFailure = true;
    }
    await updateBotLastActive('IDLE');
    if (recoveryFailure) throw new Error('Checkpoint recovery failed; bot status was reset to IDLE');
}

if (require.main === module) {
    start().then(() => {
        process.exit(0);
    }).catch(() => {
        console.error('Bot run failed. See the sanitized dashboard log for details.');
        process.exit(1);
    });
}

module.exports = { cleanupRun };
