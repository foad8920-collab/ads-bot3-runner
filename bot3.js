const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ============================================================
// 🔌 Supabase
// ============================================================

const SUPABASE_URL =
    process.env.SUPABASE_URL ||
    'https://bmsfhqmsovicpgxxwsgi.supabase.co';

const SUPABASE_KEY =
    process.env.SUPABASE_KEY ||
    'sb_publishable_l1IbZF35GnYYS8PamVX_kg_nTv_uyef';

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error(
        '❌ SUPABASE_URL أو SUPABASE_KEY غير موجود في Environment Variables'
    );

    process.exit(1);
}

const supabase =
    createClient(
        SUPABASE_URL,
        SUPABASE_KEY
    );

// ============================================================
// ⚙️ إعدادات Bot3
// ============================================================

const TEMP_DIR =
    path.join(
        os.tmpdir(),
        'bot3-temp-files'
    );

const ACCOUNT_NAME =
    'الحساب (3)';

const BOT_ID =
    'bot3';

const MAX_DAILY_POSTS =
    15;

// ============================================================
// 🧠 أدوات عامة
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(minSeconds, maxSeconds) {

    const min =
        minSeconds * 1000;

    const max =
        maxSeconds * 1000;

    return Math.floor(
        Math.random() * (max - min + 1)
    ) + min;
}

function getMemoryLog() {

    const memory =
        process.memoryUsage();

    const rssMB =
        (memory.rss / 1024 / 1024)
            .toFixed(1);

    const heapMB =
        (memory.heapUsed / 1024 / 1024)
            .toFixed(1);

    return `📊 [RAM: ${rssMB} MB | Heap: ${heapMB} MB]`;
}

// ============================================================
// 📝 Dashboard Logging
// ============================================================

async function logToDashboard(
    message,
    type = 'info'
) {

    const ramInfo =
        getMemoryLog();

    const fullMsg =
        `${message} | ${ramInfo}`;

    const consoleMsg =
        `[${ACCOUNT_NAME}] ${fullMsg}`;

    if (type === 'error') {

        console.error(
            `❌ ${consoleMsg}`
        );

    }
    else if (type === 'success') {

        console.log(
            `✅ ${consoleMsg}`
        );

    }
    else if (type === 'warn') {

        console.warn(
            `⚠️ ${consoleMsg}`
        );

    }
    else {

        console.log(
            `📢 ${consoleMsg}`
        );
    }

    try {

        const { error } =
            await supabase
                .from('bot_logs')
                .insert([
                    {
                        message: consoleMsg,
                        log_type: type
                    }
                ]);

        if (error) {

            console.error(
                `⚠️ [Log Error]: ${error.message}`
            );

        }

    }
    catch (e) {

        console.error(
            `⚠️ [Log Exception]: ${e.message}`
        );

    }
}

// ============================================================
// ⚙️ قراءة System Setting
// ============================================================

async function getSetting(keyName) {

    try {

        const { data, error } =
            await supabase
                .from('system_settings')
                .select('value')
                .eq('key', keyName)
                .single();

        if (error || !data) {

            return null;

        }

        return data.value;

    }
    catch (e) {

        return null;

    }
}

// ============================================================
// 🛑 إيقاف البوت
// ============================================================

async function forceKillProcess(
    reason = 'طلب إيقاف من المستخدم'
) {

    await logToDashboard(
        `🛑 ${reason} | جاري تحويل الحالة إلى IDLE وإنهاء الجلسة...`,
        'warn'
    );

    try {

        await supabase
            .from('bot_counters')
            .update({
                status: 'IDLE'
            })
            .eq(
                'bot_name',
                BOT_ID
            );

    }
    catch (e) {

        console.error(
            'فشل تحديث حالة البوت:',
            e.message
        );

    }

    // إلغاء GitHub Action إذا كان التشغيل من GitHub Actions
    if (
        process.env.GITHUB_ACTIONS &&
        process.env.GITHUB_TOKEN &&
        process.env.GITHUB_REPOSITORY &&
        process.env.GITHUB_RUN_ID
    ) {

        try {

            await axios.post(
                `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/cancel`,
                {},
                {
                    headers: {
                        Authorization:
                            `token ${process.env.GITHUB_TOKEN}`
                    }
                }
            );

            await logToDashboard(
                '🛑 تم إرسال أمر إلغاء Workflow إلى GitHub Actions.',
                'info'
            );

        }
        catch (e) {

            console.error(
                'فشل إلغاء Workflow:',
                e.message
            );

        }
    }

    process.exit(0);
}

// ============================================================
// 🧹 تنظيف سجلات Dashboard القديمة
// ============================================================

async function cleanOldLogs() {

    try {

        const threeDaysAgo =
            new Date(
                Date.now() -
                3 * 24 * 60 * 60 * 1000
            ).toISOString();

        const { error } =
            await supabase
                .from('bot_logs')
                .delete()
                .lt(
                    'created_at',
                    threeDaysAgo
                );

        if (!error) {

            await logToDashboard(
                '🧹 تم تنظيف سجلات Dashboard القديمة.',
                'info'
            );

        }

    }
    catch (e) {

        console.error(
            'خطأ تنظيف السجلات:',
            e.message
        );

    }
}

// ============================================================
// 📅 عداد اليوم
// ============================================================

async function checkAndResetCounter(
    botName
) {

    try {

        const todayStr =
            new Date()
                .toLocaleDateString(
                    'en-CA',
                    {
                        timeZone:
                            'Asia/Riyadh'
                    }
                );

        const {
            data,
            error
        } =
            await supabase
                .from('bot_counters')
                .select(
                    'daily_count,last_reset_date'
                )
                .eq(
                    'bot_name',
                    botName
                )
                .single();

        if (error || !data) {

            return 0;

        }

        if (
            data.last_reset_date !==
            todayStr
        ) {

            await logToDashboard(
                `🔄 يوم جديد (${todayStr}) للبوت ${botName}. تصفير العداد اليومي فقط.`,
                'info'
            );

            await supabase
                .from('bot_counters')
                .update({
                    daily_count: 0,
                    last_reset_date:
                        todayStr,
                    status: 'RUNNING'
                })
                .eq(
                    'bot_name',
                    botName
                );

            return 0;
        }

        return data.daily_count || 0;

    }
    catch (e) {

        await logToDashboard(
            `⚠️ تعذر قراءة عداد اليوم: ${e.message}`,
            'warn'
        );

        return 0;
    }
}

// ============================================================
// 📊 تسجيل النشر الناجح
// ============================================================

async function logPublishSuccess(
    botName,
    adId,
    actualPostText,
    groupName
) {

    try {

        const exactPublishTime =
            new Date()
                .toLocaleString(
                    'sv-SE',
                    {
                        timeZone:
                            'Asia/Riyadh'
                    }
                )
                .replace(
                    ' ',
                    'T'
                );

        const displayTitle =
            actualPostText
                ? actualPostText.substring(
                    0,
                    120
                ) + '...'
                : 'إعلان بدون عنوان';

        const {
            error: insertError
        } =
            await supabase
                .from('bot_publish_logs')
                .insert([
                    {
                        bot_name:
                            botName,

                        ad_id:
                            adId,

                        ad_title:
                            displayTitle,

                        group_name:
                            groupName,

                        status:
                            'SUCCESS',

                        published_at:
                            exactPublishTime
                    }
                ]);

        if (insertError) {

            console.error(
                '❌ خطأ حفظ سجل النشر:',
                insertError.message
            );

            throw new Error(
                `فشل تسجيل النشر في bot_publish_logs: ${insertError.message}`
            );
        }

        const {
            data,
            error
        } =
            await supabase
                .from('bot_counters')
                .select(
                    'daily_count,total_count'
                )
                .eq(
                    'bot_name',
                    botName
                )
                .single();

        if (error) {

            throw new Error(
                `فشل قراءة عداد البوت: ${error.message}`
            );
        }

        const currentDaily =
            (data?.daily_count || 0) + 1;

        const currentTotal =
            (data?.total_count || 0) + 1;

        const {
            error: counterError
        } =
            await supabase
                .from('bot_counters')
                .update({
                    daily_count:
                        currentDaily,

                    total_count:
                        currentTotal,

                    last_active:
                        exactPublishTime,

                    status:
                        'RUNNING'
                })
                .eq(
                    'bot_name',
                    botName
                );

        if (counterError) {

            throw new Error(
                `فشل تحديث عداد البوت: ${counterError.message}`
            );
        }

        await logToDashboard(
            `📊 [العداد] تم تسجيل نشر المجموعة (${groupName}) | اليوم: ${currentDaily}`,
            'success'
        );

    }
    catch (e) {

        console.error(
            'خطأ أثناء تسجيل النشر:',
            e.message
        );

        throw e;
    }
}

// ============================================================
// 🤖 إعادة صياغة الإعلان بواسطة Gemini
// ============================================================

async function rewriteAdWithAI(
    title,
    description
) {

    const geminiKey =
        await getSetting(
            'GEMINI_KEY'
        );

    if (!geminiKey) {

        return `${title}\n\n${description}`;

    }

    const promptText = `
أنت خبير تسويق إلكتروني.

قم بإعادة صياغة الإعلان بأسلوب جذاب وطبيعي مع الحفاظ على:

- نفس الفكرة.
- نفس المعلومات الأساسية.
- الروابط إن وجدت.
- عدم اختراع معلومات جديدة.

العنوان الأصلي:
${title}

الوصف الأصلي:
${description}

أعطني النتيجة مباشرة.
`;

    try {

        const modelsResponse =
            await axios.get(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`,
                {
                    timeout: 30000
                }
            );

        const validModels =
            (modelsResponse.data.models || [])
                .filter(
                    model =>
                        model.supportedGenerationMethods &&
                        model.supportedGenerationMethods.includes(
                            'generateContent'
                        ) &&
                        model.name.includes(
                            'gemini'
                        )
                );

        if (
            validModels.length === 0
        ) {

            return `${title}\n\n${description}`;

        }

        for (
            const modelObj
            of validModels
        ) {

            try {

                const response =
                    await axios.post(
                        `https://generativelanguage.googleapis.com/v1beta/${modelObj.name}:generateContent?key=${geminiKey}`,
                        {
                            contents: [
                                {
                                    parts: [
                                        {
                                            text:
                                                promptText
                                        }
                                    ]
                                }
                            ]
                        },
                        {
                            timeout: 60000
                        }
                    );

                const aiText =
                    response.data
                        ?.candidates?.[0]
                        ?.content?.parts?.[0]
                        ?.text;

                if (aiText) {

                    await logToDashboard(
                        '✨ تمت إعادة صياغة الإعلان بواسطة AI.',
                        'success'
                    );

                    return aiText.trim();
                }

            }
            catch (e) {

                continue;

            }
        }

    }
    catch (e) {

        await logToDashboard(
            `⚠️ فشل الاتصال بـ Gemini: ${e.message}`,
            'warn'
        );

    }

    return `${title}\n\n${description}`;
}

// ============================================================
// 🖼️ تحميل الصورة / الفيديو
// ============================================================

async function downloadImage(
    imageUrl
) {

    if (!imageUrl) {

        return null;

    }

    if (
        !fs.existsSync(
            TEMP_DIR
        )
    ) {

        fs.mkdirSync(
            TEMP_DIR,
            {
                recursive: true
            }
        );

    }

    let ext = '.jpg';

    const lowerUrl =
        imageUrl.toLowerCase();

    if (
        lowerUrl.includes('.mp4') ||
        lowerUrl.includes('ik-video')
    ) {

        ext = '.mp4';

    }
    else if (
        lowerUrl.includes('.mov')
    ) {

        ext = '.mov';

    }
    else if (
        lowerUrl.includes('.webp') ||
        lowerUrl.includes('f-webp')
    ) {

        ext = '.webp';

    }
    else if (
        lowerUrl.includes('.png')
    ) {

        ext = '.png';

    }

    const imagePath =
        path.join(
            TEMP_DIR,
            `ad-image-bot3-${Date.now()}${ext}`
        );

    const response =
        await axios({
            url:
                imageUrl,

            method:
                'GET',

            responseType:
                'stream',

            timeout:
                120000
        });

    await new Promise(
        (resolve, reject) => {

            const writer =
                fs.createWriteStream(
                    imagePath
                );

            response.data.pipe(
                writer
            );

            writer.on(
                'finish',
                resolve
            );

            writer.on(
                'error',
                reject
            );

        }
    );

    return imagePath;
}

// ============================================================
// 🔐 فحص جلسة Facebook
// ============================================================

async function checkFacebookSession(
    page
) {

    const currentUrl =
        page.url();

    if (
        currentUrl.includes(
            '/login'
        ) ||
        currentUrl.includes(
            'checkpoint'
        ) ||
        currentUrl.includes(
            'login.php'
        )
    ) {

        return {
            valid: false,
            reason:
                'Facebook Login / Checkpoint'
        };

    }

    return {
        valid: true,
        reason: null
    };
}

// ============================================================
// 🌐 تهيئة جلسة Facebook
// ============================================================

async function initializeFacebookSession(
    page
) {

    await logToDashboard(
        '🌐 جاري تهيئة جلسة Facebook مرة واحدة قبل بدء النشر...',
        'info'
    );

    await page.goto(
        'https://www.facebook.com/',
        {
            waitUntil:
                'domcontentloaded',

            timeout:
                60000
        }
    );

    await sleep(
        randomDelay(
            10,
            15
        )
    );

    const session =
        await checkFacebookSession(
            page
        );

    if (!session.valid) {

        throw new Error(
            `FB_SESSION_INVALID: ${session.reason}`
        );

    }

    await logToDashboard(
        `✅ جلسة Facebook جاهزة. URL: ${page.url()}`,
        'success'
    );
}

// ============================================================
// 📝 فتح مربع النشر
// ============================================================

async function openPostBox(
    page
) {

    const initialWait =
        randomDelay(
            10,
            16
        );

    await logToDashboard(
        `⏳ انتظار ${Math.round(initialWait / 1000)} ثانية لتحميل صفحة المجموعة...`,
        'info'
    );

    await sleep(
        initialWait
    );

    const discussionTabs = [

        'div[role="tab"]:has-text("مناقشة")',
        'div[role="tab"]:has-text("Discussion")',
        'a[role="tab"]:has-text("مناقشة")',
        'a[role="tab"]:has-text("Discussion")',
        'a[href*="/discussion"]'

    ];

    for (
        const tabSel
        of discussionTabs
    ) {

        try {

            const tabBtn =
                page
                    .locator(
                        tabSel
                    )
                    .first();

            if (
                await tabBtn.count() > 0 &&
                await tabBtn.isVisible()
            ) {

                await tabBtn.click({
                    timeout:
                        5000,

                    force:
                        true
                });

                await sleep(
                    randomDelay(
                        8,
                        14
                    )
                );

                break;
            }

        }
        catch (e) {}

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

        'div[role="textbox"]',

        'span:has-text("اكتب شيئاً...")',
        'text="اكتب شيئاً..."',

        'span:has-text("اكتب")',
        'span:has-text("Write")',

        'div[role="button"]:has-text("اكتب")',
        'div[role="button"]:has-text("Write")',

        'div[role="button"]:has-text("بم تفكر")',
        'div[role="button"]:has-text("تفكر")'

    ];

    for (
        const selector
        of selectors
    ) {

        try {

            const element =
                page
                    .locator(
                        selector
                    )
                    .first();

            if (
                await element.count() > 0 &&
                await element.isVisible()
            ) {

                const box =
                    await element.boundingBox();

                if (box) {

                    await page.mouse.move(
                        box.x +
                            box.width / 2,

                        box.y +
                            box.height / 2
                    );

                    await sleep(
                        randomDelay(
                            1,
                            2
                        )
                    );
                }

                await element.click({
                    timeout:
                        8000,

                    force:
                        true
                });

                await sleep(
                    randomDelay(
                        8,
                        14
                    )
                );

                const confirmBtns = [

                    'text=موافق',
                    'text=فهمت',
                    'text=تم',
                    'text=Got It',
                    'text=OK',
                    'text=متابعة'

                ];

                for (
                    const cBtn
                    of confirmBtns
                ) {

                    try {

                        const btn =
                            page
                                .locator(
                                    cBtn
                                )
                                .first();

                        if (
                            await btn.count() > 0 &&
                            await btn.isVisible()
                        ) {

                            await btn.click({
                                timeout:
                                    3000,

                                force:
                                    true
                            });

                            await sleep(
                                randomDelay(
                                    1,
                                    3
                                )
                            );

                        }

                    }
                    catch (e) {}

                }

                await logToDashboard(
                    '✅ تم فتح نافذة المنشور.',
                    'success'
                );

                return true;
            }

        }
        catch (e) {}

    }

    return false;
}

// ============================================================
// ✍️ إدخال النص
// ============================================================

async function pasteTextWithLines(
    page,
    postText
) {

    await sleep(
        randomDelay(
            3,
            5
        )
    );

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

    for (
        const sel
        of targetSelectors
    ) {

        try {

            const element =
                page
                    .locator(
                        sel
                    )
                    .first();

            if (
                await element.count() > 0 &&
                await element.isVisible()
            ) {

                textbox =
                    element;

                break;
            }

        }
        catch (e) {}

    }

    if (!textbox) {

        throw new Error(
            'تعذر العثور على مربع النص'
        );

    }

    await textbox.click({
        timeout:
            8000,

        force:
            true
    });

    await sleep(
        randomDelay(
            2,
            4
        )
    );

    try {

        await page.evaluate(
            async text => {

                await navigator.clipboard
                    .writeText(
                        text
                    );

            },
            postText
        );

        await page.keyboard.press(
            'Control+V'
        );

        await logToDashboard(
            '✅ تم إدخال نص الإعلان عبر Clipboard.',
            'success'
        );

        return;

    }
    catch (e) {

        await logToDashboard(
            '⚠️ Clipboard لم يعمل، استخدام الإدخال البديل.',
            'warn'
        );

    }

    await page.keyboard.insertText(
        postText
    );

    await logToDashboard(
        '✅ تم إدخال النص بطريقة insertText.',
        'success'
    );
}

// ============================================================
// 🚀 النشر في المجموعة
// ============================================================

async function publishToGroup(
    page,
    group,
    post,
    imagePath
) {

    await logToDashboard(
        `📢 فتح المجموعة: ${group.name}`,
        'info'
    );

    await page.goto(
        group.url,
        {
            waitUntil:
                'domcontentloaded',

            timeout:
                60000
        }
    );

    await sleep(
        randomDelay(
            12,
            20
        )
    );

    const session =
        await checkFacebookSession(
            page
        );

    if (!session.valid) {

        throw new Error(
            `FB_SESSION_INVALID: ${session.reason}`
        );

    }

    const opened =
        await openPostBox(
            page
        );

    if (!opened) {

        throw new Error(
            'لم يتم العثور على مربع النشر'
        );

    }

    await sleep(
        randomDelay(
            3,
            6
        )
    );

    // ========================================================
    // 🖼️ الصورة / الفيديو
    // ========================================================

    if (imagePath) {

        const imageTriggerSelectors = [

            'div[aria-label="صورة/فيديو"]',
            'div[aria-label="Photo/video"]',
            'svg[aria-label="صورة/فيديو"]',
            'svg[aria-label="Photo/video"]',
            'div[role="button"]:has(input[type="file"])'

        ];

        for (
            const trigSel
            of imageTriggerSelectors
        ) {

            try {

                const trigElement =
                    page
                        .locator(
                            trigSel
                        )
                        .first();

                if (
                    await trigElement.count() > 0 &&
                    await trigElement.isVisible()
                ) {

                    await trigElement.click({
                        timeout:
                            6000,

                        force:
                            true
                    });

                    await sleep(
                        randomDelay(
                            3,
                            5
                        )
                    );

                    break;
                }

            }
            catch (e) {}

        }

        let isFileInjected =
            false;

        try {

            const dialogFileInput =
                page
                    .locator(
                        'div[role="dialog"] input[type="file"]'
                    )
                    .first();

            if (
                await dialogFileInput.count() > 0
            ) {

                await dialogFileInput
                    .setInputFiles(
                        imagePath
                    );

                isFileInjected =
                    true;

            }
            else {

                const allFileInputs =
                    page.locator(
                        'input[type="file"]'
                    );

                const count =
                    await allFileInputs.count();

                if (count > 0) {

                    await allFileInputs
                        .nth(
                            count - 1
                        )
                        .setInputFiles(
                            imagePath
                        );

                    isFileInjected =
                        true;
                }
            }

        }
        catch (e) {

            await logToDashboard(
                `⚠️ تعذر إرفاق الملف: ${e.message}`,
                'warn'
            );

        }

        if (isFileInjected) {

            const isVideoFile =
                imagePath.endsWith(
                    '.mp4'
                ) ||
                imagePath.endsWith(
                    '.mov'
                );

            const waitTime =
                isVideoFile
                    ? randomDelay(
                        50,
                        70
                    )
                    : randomDelay(
                        20,
                        30
                    );

            await logToDashboard(
                `🖼️ تم إرفاق الملف، انتظار ${Math.round(waitTime / 1000)} ثانية...`,
                'info'
            );

            await sleep(
                waitTime
            );

            try {

                await page.waitForSelector(
                    'img[src*="blob:"], video, [aria-label*="إزالة"], [aria-label*="Remove"]',
                    {
                        timeout:
                            30000
                    }
                );

                await logToDashboard(
                    '✅ ظهرت معاينة الملف.',
                    'success'
                );

            }
            catch (e) {

                await logToDashboard(
                    '⚠️ لم يتم العثور على عنصر المعاينة، سنكمل بحذر.',
                    'warn'
                );

            }

            await sleep(
                randomDelay(
                    8,
                    15
                )
            );
        }
    }

    // ========================================================
    // 📝 النص
    // ========================================================

    let postText =
        post.ai_final_text3 ||
        '';

    if (
        !postText ||
        postText.trim() === ''
    ) {

        await logToDashboard(
            '🧠 ai_final_text3 فارغ، إنشاء نص جديد.',
            'info'
        );

        const aiGeneratedContent =
            await rewriteAdWithAI(
                post.ad_title,
                post.ad_description
            );

        postText =
            `${aiGeneratedContent}\n\n🔥 إعلان جديد على سوق الإعلانات الحديث`;

        const fbUrl =
            post.facebook_url ||
            '';

        if (
            fbUrl.trim() !== ''
        ) {

            postText +=
                `\n\n${fbUrl.trim()}`;
        }

        const {
            error
        } =
            await supabase
                .from('publish_queue')
                .update({
                    ai_final_text3:
                        postText
                })
                .eq(
                    'id',
                    post.id
                );

        if (error) {

            await logToDashboard(
                `⚠️ تعذر حفظ ai_final_text3: ${error.message}`,
                'warn'
            );

        }
    }

    await logToDashboard(
        `📝 النص النهائي:\n${postText}`,
        'info'
    );

    await pasteTextWithLines(
        page,
        postText
    );

    const fbUrlCheck =
        post.facebook_url ||
        '';

    if (
        fbUrlCheck.trim() !== '' ||
        postText.includes(
            'facebook.com'
        )
    ) {

        await sleep(
            randomDelay(
                20,
                30
            )
        );

    }
    else {

        await sleep(
            randomDelay(
                10,
                18
            )
        );

    }

    // ========================================================
    // 🚀 زر النشر
    // ========================================================

    const publishButtons = [

        'div[role="dialog"] div[role="button"]:has-text("نشر")',
        'div[role="dialog"] div[role="button"]:has-text("Post")',
        'div[role="dialog"] div[role="button"]:has-text("Publish")',

        'div[aria-label="نشر"]',
        'div[aria-label="Post"]',

        'text=نشر',
        'text=Post',
        'text=Publish'

    ];

    let published =
        false;

    for (
        const btn
        of publishButtons
    ) {

        try {

            const button =
                page
                    .locator(
                        btn
                    )
                    .last();

            if (
                await button.count() > 0 &&
                await button.isVisible()
            ) {

                await button.scrollIntoViewIfNeeded();

                await sleep(
                    randomDelay(
                        1,
                        2
                    )
                );

                await button.click({
                    timeout:
                        8000,

                    force:
                        true
                });

                published =
                    true;

                await logToDashboard(
                    '🚀 تم الضغط على زر النشر.',
                    'success'
                );

                break;
            }

        }
        catch (e) {}

    }

    if (!published) {

        throw new Error(
            'فشل العثور على زر النشر'
        );

    }

    // ========================================================
    // ⏳ انتظار النشر
    // ========================================================

    const isUploadedVideo =
        imagePath &&
        (
            imagePath.endsWith(
                '.mp4'
            ) ||
            imagePath.endsWith(
                '.mov'
            )
        );

    const finalWait =
        isUploadedVideo
            ? randomDelay(
                50,
                70
            )
            : randomDelay(
                25,
                40
            );

    await logToDashboard(
        `⏳ انتظار اكتمال عملية النشر ${Math.round(finalWait / 1000)} ثانية...`,
        'info'
    );

    await sleep(
        finalWait
    );

    const afterPublishSession =
        await checkFacebookSession(
            page
        );

    if (
        !afterPublishSession.valid
    ) {

        throw new Error(
            `FB_SESSION_INVALID_AFTER_POST: ${afterPublishSession.reason}`
        );

    }

    await logToDashboard(
        `✅ انتهت عملية النشر في المجموعة: ${group.name}`,
        'success'
    );

    await logPublishSuccess(
        BOT_ID,
        post.id,
        postText,
        group.name
    );
}

// ============================================================
// 🔄 معالجة إعلان Bot3
// ============================================================

async function processOnePostBot3(
    initialPostData
) {

    let browser =
        null;

    let page =
        null;

    let imagePath =
        null;

    let normalCompletion =
        false;

    try {

        const currentDailyCount =
            await checkAndResetCounter(
                BOT_ID
            );

        if (
            currentDailyCount >=
            MAX_DAILY_POSTS
        ) {

            await logToDashboard(
                `⚠️ وصل ${BOT_ID} إلى الحد اليومي ${MAX_DAILY_POSTS}.`,
                'warn'
            );

            await supabase
                .from('bot_counters')
                .update({
                    status:
                        'MAX_LIMIT_REACHED'
                })
                .eq(
                    'bot_name',
                    BOT_ID
                );

            return {
                completed:
                    false,

                reason:
                    'MAX_LIMIT_REACHED'
            };
        }

        // ====================================================
        // 🍪 Cookies Bot3 من system_settings
        // ====================================================

        const cookiesRaw =
            await getSetting(
                'FB_COOKIES_BOT3'
            );

        if (!cookiesRaw) {

            await logToDashboard(
                '❌ FB_COOKIES_BOT3 غير موجود في system_settings.',
                'error'
            );

            await supabase
                .from('bot_counters')
                .update({
                    status:
                        'ERROR'
                })
                .eq(
                    'bot_name',
                    BOT_ID
                );

            return {
                completed:
                    false,

                reason:
                    'COOKIES_MISSING'
            };
        }

        // ====================================================
        // ⏳ تأخير بداية Bot3
        // ====================================================

        const initialOffsetDelay =
            randomDelay(
                480,
                720
            );

        await logToDashboard(
            `⏳ تأخير بداية البوت 3: ${Math.round(initialOffsetDelay / 60000)} دقائق.`,
            'info'
        );

        await sleep(
            initialOffsetDelay
        );

        await logToDashboard(
            `🚀 بدأ الإعلان #${initialPostData.id}: ${initialPostData.ad_title}`,
            'info'
        );

        // ====================================================
        // 🖼️ تحميل الوسائط
        // ====================================================

        let mediaUrl =
            '';

        if (
            initialPostData.ad_video &&
            initialPostData.ad_video.trim() !== ''
        ) {

            mediaUrl =
                initialPostData.ad_video.trim();

        }
        else if (
            initialPostData.ad_image &&
            initialPostData.ad_image.trim() !== ''
        ) {

            mediaUrl =
                initialPostData.ad_image.trim();

        }

        if (
            mediaUrl !== ''
        ) {

            try {

                imagePath =
                    await downloadImage(
                        mediaUrl
                    );

                if (imagePath) {

                    await logToDashboard(
                        `🖼️ تم تحميل الملف: ${imagePath}`,
                        'success'
                    );

                }

            }
            catch (e) {

                await logToDashboard(
                    `⚠️ فشل تحميل الملف: ${e.message}`,
                    'warn'
                );

            }
        }

        // ====================================================
        // 🌐 تشغيل Chromium
        // ====================================================

        const launchOptions = {

            headless:
                true,

            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-service-autorun',
                '--password-store=basic',
                '--disable-extensions',
                '--disable-default-apps',
                '--mute-audio'
            ]
        };

        await logToDashboard(
            '🌐 تشغيل Chromium بإعدادات قياسية ومستقرة.',
            'info'
        );

        browser =
            await chromium.launch(
                launchOptions
            );

        const context =
            await browser.newContext({

                viewport: {
                    width:
                        1280,

                    height:
                        800
                },

                timezoneId:
                    'Asia/Riyadh',

                locale:
                    'ar-SA',

                permissions: [
                    'clipboard-read',
                    'clipboard-write'
                ],

                hasTouch:
                    false
            });

        // ====================================================
        // 🚫 لا يوجد تزوير لبصمة المتصفح
        // ====================================================

        await context.route(
            '**/*',
            async route => {

                const resourceType =
                    route.request()
                        .resourceType();

                if (
                    resourceType ===
                    'font'
                ) {

                    await route.abort();

                    return;
                }

                await route.continue();
            }
        );

        // ====================================================
        // 🍪 تجهيز Cookies
        // ====================================================

        let rawCookies;

        try {

            rawCookies =
                JSON.parse(
                    cookiesRaw
                );

        }
        catch (e) {

            throw new Error(
                `FB_COOKIES_BOT3 ليست JSON صحيحة: ${e.message}`
            );

        }

        if (
            !Array.isArray(
                rawCookies
            )
        ) {

            throw new Error(
                'FB_COOKIES_BOT3 يجب أن تكون Array من Cookies.'
            );

        }

        const formattedCookies =
            rawCookies
                .map(cookie => {

                    const c = {
                        ...cookie
                    };

                    if (
                        typeof c.sameSite ===
                        'string'
                    ) {

                        const lower =
                            c.sameSite
                                .toLowerCase();

                        if (
                            lower ===
                            'lax'
                        ) {

                            c.sameSite =
                                'Lax';

                        }
                        else if (
                            lower ===
                            'strict'
                        ) {

                            c.sameSite =
                                'Strict';

                        }
                        else if (
                            lower ===
                                'none' ||
                            lower ===
                                'no_restriction'
                        ) {

                            c.sameSite =
                                'None';

                        }
                        else {

                            delete c.sameSite;

                        }

                    }
                    else {

                        delete c.sameSite;

                    }

                    if (
                        c.expirationDate &&
                        !c.expires
                    ) {

                        c.expires =
                            c.expirationDate;
                    }

                    delete c.id;
                    delete c.storeId;
                    delete c.hostOnly;

                    return c;

                });

        await context.addCookies(
            formattedCookies
        );

        await logToDashboard(
            `🍪 تم تحميل ${formattedCookies.length} Cookie الخاصة بالبوت 3.`,
            'success'
        );

        // ====================================================
        // 📄 صفحة واحدة للإعلان
        // ====================================================

        page =
            await context.newPage();

        // ====================================================
        // 🌐 تهيئة الجلسة
        // ====================================================

        await initializeFacebookSession(
            page
        );

        // ====================================================
        // 🔁 حلقة المجموعات
        // ====================================================

        while (true) {

            // -----------------------------------------------
            // 🛑 فحص حالة Bot3
            // -----------------------------------------------

            const {
                data:
                    counterStatus,
                error:
                    counterStatusError
            } =
                await supabase
                    .from('bot_counters')
                    .select(
                        'status'
                    )
                    .eq(
                        'bot_name',
                        BOT_ID
                    )
                    .single();

            if (
                counterStatusError
            ) {

                await logToDashboard(
                    `⚠️ تعذر قراءة حالة Bot3: ${counterStatusError.message}`,
                    'warn'
                );

            }

            const isCounterStopped =
                counterStatus &&
                [
                    'IDLE',
                    'STOPPED',
                    'PAUSED'
                ].includes(
                    counterStatus.status
                );

            if (
                isCounterStopped
            ) {

                await logToDashboard(
                    `🛑 تم اكتشاف حالة ${counterStatus.status} للبوت 3.`,
                    'warn'
                );

                normalCompletion =
                    false;

                break;
            }

            // -----------------------------------------------
            // 📦 قراءة آخر نسخة من الإعلان
            // -----------------------------------------------

            const {
                data:
                    freshData,
                error:
                    freshDataError
            } =
                await supabase
                    .from('publish_queue')
                    .select('*')
                    .eq(
                        'id',
                        initialPostData.id
                    )
                    .single();

            if (
                freshDataError ||
                !freshData
            ) {

                await logToDashboard(
                    '⚠️ لم يعد الإعلان موجودًا في publish_queue.',
                    'warn'
                );

                break;
            }

            const isQueueStopped =
                [
                    'stopped',
                    'paused',
                    'cancelled'
                ].includes(
                    freshData.status
                );

            if (
                isQueueStopped
            ) {

                await logToDashboard(
                    `🛑 حالة الإعلان أصبحت ${freshData.status}.`,
                    'warn'
                );

                break;
            }

            // -----------------------------------------------
            // ⏭️ تخطي المجموعة
            // -----------------------------------------------

            if (
                freshData.skip_current_group ===
                true
            ) {

                await logToDashboard(
                    '⏭️ تم طلب تخطي المجموعة الحالية.',
                    'info'
                );

                let failedGroups =
                    [];

                try {

                    if (
                        freshData.error_message
                    ) {

                        failedGroups =
                            JSON.parse(
                                freshData.error_message
                            );

                        if (
                            !Array.isArray(
                                failedGroups
                            )
                        ) {

                            failedGroups =
                                [];
                        }
                    }

                }
                catch (e) {

                    failedGroups =
                        [];
                }

                let currentBotGroup =
                    freshData.bot3_group;

                let groupName =
                    (
                        typeof currentBotGroup ===
                        'object' &&
                        currentBotGroup
                    )
                        ? currentBotGroup.name
                        : 'مجموعة تم تخطيها';

                failedGroups.push({

                    name:
                        groupName,

                    error:
                        'تم تخطي المجموعة يدوياً'

                });

                await supabase
                    .from('publish_queue')
                    .update({

                        skip_current_group:
                            false,

                        bot3_group:
                            null,

                        ai_final_text3:
                            null,

                        error_message:
                            JSON.stringify(
                                failedGroups
                            )

                    })
                    .eq(
                        'id',
                        initialPostData.id
                    );

                continue;
            }

            // -----------------------------------------------
            // 📦 قراءة المجموعات
            // -----------------------------------------------

            let groups =
                [];

            if (
                Array.isArray(
                    freshData.groups_json
                )
            ) {

                groups =
                    freshData.groups_json;

            }
            else if (
                typeof freshData.groups_json ===
                'string'
            ) {

                try {

                    groups =
                        JSON.parse(
                            freshData.groups_json ||
                            '[]'
                        );

                }
                catch (e) {

                    groups =
                        [];
                }
            }

            // -----------------------------------------------
            // 🎯 المجموعة المعلقة
            // -----------------------------------------------

            let botGroup =
                null;

            if (
                typeof freshData.bot3_group ===
                    'object' &&
                freshData.bot3_group !==
                    null
            ) {

                botGroup =
                    freshData.bot3_group;

            }
            else if (
                typeof freshData.bot3_group ===
                'string'
            ) {

                try {

                    botGroup =
                        freshData.bot3_group
                            ? JSON.parse(
                                freshData.bot3_group
                            )
                            : null;

                }
                catch (e) {

                    botGroup =
                        null;
                }
            }

            // -----------------------------------------------
            // 🏁 لا توجد مجموعات
            // -----------------------------------------------

            if (
                groups.length === 0 &&
                !botGroup
            ) {

                const {
                    data:
                        checkAllBots
                } =
                    await supabase
                        .from('publish_queue')
                        .select(
                            'bot1_group,bot2_group,bot3_group,failed_count'
                        )
                        .eq(
                            'id',
                            initialPostData.id
                        )
                        .single();

                const hasOtherBotGroups =
                    checkAllBots &&
                    (
                        checkAllBots.bot1_group ||
                        checkAllBots.bot2_group
                    );

                if (
                    !hasOtherBotGroups
                ) {

                    const finalFailed =
                        checkAllBots?.failed_count ||
                        0;

                    const finalStatus =
                        finalFailed > 0
                            ? 'failed'
                            : 'published';

                    await supabase
                        .from('publish_queue')
                        .update({

                            status:
                                finalStatus,

                            bot3_group:
                                null,

                            ai_final_text3:
                                null

                        })
                        .eq(
                            'id',
                            initialPostData.id
                        );

                    await logToDashboard(
                        `🎉 اكتملت جميع المجموعات. الحالة: ${finalStatus}`,
                        'success'
                    );

                }

                await supabase
                    .from('bot_counters')
                    .update({
                        status:
                            'IDLE'
                    })
                    .eq(
                        'bot_name',
                        BOT_ID
                    );

                normalCompletion =
                    true;

                break;
            }

            // -----------------------------------------------
            // 🎯 تحديد المجموعة
            // -----------------------------------------------

            let targetGroup =
                null;

            if (
                botGroup
            ) {

                targetGroup =
                    botGroup;

                await logToDashboard(
                    `🎯 استكمال المجموعة المعلقة: ${targetGroup.name}`,
                    'info'
                );

            }
            else {

                targetGroup =
                    groups[0];

                const remainingGroups =
                    groups.slice(1);

                const {
                    error:
                        updateErr
                } =
                    await supabase
                        .from('publish_queue')
                        .update({

                            bot3_group:
                                JSON.stringify(
                                    targetGroup
                                ),

                            groups_json:
                                JSON.stringify(
                                    remainingGroups
                                )

                        })
                        .eq(
                            'id',
                            initialPostData.id
                        );

                if (
                    updateErr
                ) {

                    await logToDashboard(
                        `⚠️ تعذر حجز المجموعة: ${updateErr.message}`,
                        'warn'
                    );

                    await sleep(
                        2000
                    );

                    continue;
                }

                await logToDashboard(
                    `🎯 تم حجز المجموعة: ${targetGroup.name}`,
                    'success'
                );
            }

            // -----------------------------------------------
            // 🛡️ فحص التكرار
            // -----------------------------------------------

            const {
                data:
                    logData,
                error:
                    logCheckError
            } =
                await supabase
                    .from('bot_publish_logs')
                    .select('id')
                    .eq(
                        'bot_name',
                        BOT_ID
                    )
                    .eq(
                        'ad_id',
                        initialPostData.id
                    )
                    .eq(
                        'group_name',
                        targetGroup.name
                    )
                    .eq(
                        'status',
                        'SUCCESS'
                    )
                    .limit(1);

            if (
                logCheckError
            ) {

                await logToDashboard(
                    `⚠️ تعذر فحص تكرار المجموعة: ${logCheckError.message}`,
                    'warn'
                );

            }

            if (
                logData &&
                logData.length > 0
            ) {

                await logToDashboard(
                    `🛡️ المجموعة (${targetGroup.name}) منشورة مسبقاً. سيتم تجاوزها.`,
                    'warn'
                );

                await supabase
                    .from('publish_queue')
                    .update({

                        bot3_group:
                            null,

                        ai_final_text3:
                            null

                    })
                    .eq(
                        'id',
                        initialPostData.id
                    );

                continue;
            }

            // -----------------------------------------------
            // 🚀 النشر
            // -----------------------------------------------

            try {

                await publishToGroup(
                    page,
                    targetGroup,
                    freshData,
                    imagePath
                );

                // -------------------------------------------
                // 📊 تحديث success_count
                // -------------------------------------------

                const {
                    data:
                        latestSuccessPost
                } =
                    await supabase
                        .from('publish_queue')
                        .select(
                            'success_count'
                        )
                        .eq(
                            'id',
                            initialPostData.id
                        )
                        .single();

                const currentSuccessCount =
                    latestSuccessPost?.success_count ||
                    0;

                const newSuccessCount =
                    currentSuccessCount +
                    1;

                await supabase
                    .from('publish_queue')
                    .update({

                        bot3_group:
                            null,

                        ai_final_text3:
                            null,

                        success_count:
                            newSuccessCount

                    })
                    .eq(
                        'id',
                        initialPostData.id
                    );

                await logToDashboard(
                    `✅ نجاح المجموعة (${targetGroup.name}) | الإجمالي: ${newSuccessCount}`,
                    'success'
                );

                // -------------------------------------------
                // ⏳ استراحة بين المجموعات
                // -------------------------------------------

                const {
                    data:
                        checkData
                } =
                    await supabase
                        .from('publish_queue')
                        .select(
                            'groups_json'
                        )
                        .eq(
                            'id',
                            initialPostData.id
                        )
                        .single();

                let currentRemaining =
                    [];

                if (
                    Array.isArray(
                        checkData?.groups_json
                    )
                ) {

                    currentRemaining =
                        checkData.groups_json;

                }
                else if (
                    typeof checkData?.groups_json ===
                    'string'
                ) {

                    try {

                        currentRemaining =
                            JSON.parse(
                                checkData.groups_json ||
                                '[]'
                            );

                    }
                    catch (e) {

                        currentRemaining =
                            [];
                    }
                }

                if (
                    currentRemaining.length >
                    0
                ) {

                    const longBreak =
                        randomDelay(
                            240,
                            420
                        );

                    await logToDashboard(
                        `⏳ استراحة ${Math.round(longBreak / 60000)} دقائق قبل المجموعة التالية.`,
                        'info'
                    );

                    await sleep(
                        longBreak
                    );
                }

            }
            catch (err) {

                // -------------------------------------------
                // 🚨 Facebook Security
                // -------------------------------------------

                const isFacebookSecurity =
                    err.message.includes(
                        'FB_SESSION_INVALID'
                    ) ||
                    err.message.includes(
                        'Checkpoint'
                    ) ||
                    err.message.includes(
                        'checkpoint'
                    );

                if (
                    isFacebookSecurity
                ) {

                    await logToDashboard(
                        `🚨 Facebook أوقف الجلسة: ${err.message}`,
                        'error'
                    );

                    await supabase
                        .from('bot_counters')
                        .update({
                            status:
                                'FACEBOOK_CHECKPOINT'
                        })
                        .eq(
                            'bot_name',
                            BOT_ID
                        );

                    normalCompletion =
                        false;

                    break;
                }

                // -------------------------------------------
                // ❌ خطأ عادي
                // -------------------------------------------

                const {
                    data:
                        latestFailedPost
                } =
                    await supabase
                        .from('publish_queue')
                        .select(
                            'failed_count,error_message'
                        )
                        .eq(
                            'id',
                            initialPostData.id
                        )
                        .single();

                const currentFailedCount =
                    latestFailedPost?.failed_count ||
                    0;

                const newFailedCount =
                    currentFailedCount +
                    1;

                let failedGroups =
                    [];

                try {

                    if (
                        latestFailedPost?.error_message
                    ) {

                        const parsed =
                            JSON.parse(
                                latestFailedPost
                                    .error_message
                            );

                        if (
                            Array.isArray(
                                parsed
                            )
                        ) {

                            failedGroups =
                                parsed;
                        }
                    }

                }
                catch (e) {}

                failedGroups.push({

                    name:
                        targetGroup.name,

                    url:
                        targetGroup.url,

                    error:
                        err.message

                });

                await logToDashboard(
                    `❌ فشل النشر في (${targetGroup.name}): ${err.message}`,
                    'error'
                );

                await supabase
                    .from('publish_queue')
                    .update({

                        bot3_group:
                            null,

                        ai_final_text3:
                            null,

                        failed_count:
                            newFailedCount,

                        error_message:
                            JSON.stringify(
                                failedGroups
                            )

                    })
                    .eq(
                        'id',
                        initialPostData.id
                    );

                await sleep(
                    randomDelay(
                        20,
                        30
                    )
                );

                continue;
            }
        }

        return {
            completed:
                normalCompletion,

            reason:
                normalCompletion
                    ? 'COMPLETED'
                    : 'STOPPED_OR_INTERRUPTED'
        };

    }
    catch (err) {

        await logToDashboard(
            `❌ خطأ عام في البوت الثالث: ${err.message}`,
            'error'
        );

        await supabase
            .from('bot_counters')
            .update({
                status:
                    'ERROR'
            })
            .eq(
                'bot_name',
                BOT_ID
            );

        return {
            completed:
                false,

            reason:
                'ERROR',

            error:
                err.message
        };

    }
    finally {

        try {

            if (
                page &&
                !page.isClosed()
            ) {

                await page.close();
            }

        }
        catch (e) {}

        try {

            if (browser) {

                await browser.close();
            }

        }
        catch (e) {}

        if (
            imagePath &&
            fs.existsSync(
                imagePath
            )
        ) {

            try {

                fs.unlinkSync(
                    imagePath
                );

            }
            catch (e) {}
        }

        await logToDashboard(
            '🧹 تم إغلاق متصفح البوت الثالث.',
            'info'
        );
    }
}

// ============================================================
// 🔄 إعادة الإعلانات العالقة الخاصة بـ Bot3 فقط
// ============================================================

async function resetStuckBot3Posts() {

    await logToDashboard(
        '🔄 فحص إعلانات Bot3 العالقة.',
        'info'
    );

    try {

        /*
         * مهم:
         * لا نغيّر كل publish_queue.
         *
         * هنا نحاول فقط إعادة السجلات التي:
         * - تحتوي على bot3_group
         * أو
         * - ما زال لديها groups_json
         *
         * ولا نلمس السجلات التي تخص بوتات أخرى فقط.
         */

        const {
            data,
            error
        } =
            await supabase
                .from('publish_queue')
                .select(
                    'id,status,groups_json,bot3_group'
                )
                .eq(
                    'status',
                    'processing'
                );

        if (error) {

            await logToDashboard(
                `⚠️ خطأ قراءة الإعلانات العالقة: ${error.message}`,
                'error'
            );

            return;
        }

        if (
            !data ||
            data.length === 0
        ) {

            await logToDashboard(
                '✅ لا توجد إعلانات Bot3 عالقة.',
                'info'
            );

            return;
        }

        for (
            const post
            of data
        ) {

            let hasGroups =
                false;

            let hasBot3Group =
                false;

            if (
                Array.isArray(
                    post.groups_json
                )
            ) {

                hasGroups =
                    post.groups_json.length >
                    0;

            }
            else if (
                typeof post.groups_json ===
                'string'
            ) {

                try {

                    const parsed =
                        JSON.parse(
                            post.groups_json ||
                            '[]'
                        );

                    hasGroups =
                        Array.isArray(
                            parsed
                        ) &&
                        parsed.length > 0;

                }
                catch (e) {}
            }

            if (
                post.bot3_group
            ) {

                hasBot3Group =
                    true;
            }

            /*
             * إذا كان الإعلان يحتوي على مهمة Bot3،
             * نعيده إلى running.
             *
             * إذا لم يكن فيه أي مهمة لـ Bot3،
             * لا نلمسه.
             */

            if (
                hasGroups ||
                hasBot3Group
            ) {

                const {
                    error:
                        updateError
                } =
                    await supabase
                        .from('publish_queue')
                        .update({
                            status:
                                'running'
                        })
                        .eq(
                            'id',
                            post.id
                        )
                        .eq(
                            'status',
                            'processing'
                        );

                if (
                    updateError
                ) {

                    await logToDashboard(
                        `⚠️ فشل إعادة الإعلان #${post.id}: ${updateError.message}`,
                        'warn'
                    );

                }
                else {

                    await logToDashboard(
                        `🔄 تمت إعادة الإعلان #${post.id} إلى running.`,
                        'info'
                    );

                }
            }
        }

    }
    catch (e) {

        await logToDashboard(
            `⚠️ خطأ resetStuckBot3Posts: ${e.message}`,
            'error'
        );

    }
}

// ============================================================
// 🔍 البحث عن إعلان مناسب لـ Bot3
// ============================================================

function hasBot3Work(
    post
) {

    let groups =
        [];

    if (
        Array.isArray(
            post.groups_json
        )
    ) {

        groups =
            post.groups_json;

    }
    else if (
        typeof post.groups_json ===
        'string'
    ) {

        try {

            groups =
                JSON.parse(
                    post.groups_json ||
                    '[]'
                );

        }
        catch (e) {

            groups =
                [];
        }
    }

    let hasBot3Group =
        false;

    if (
        typeof post.bot3_group ===
            'object' &&
        post.bot3_group !== null
    ) {

        hasBot3Group =
            true;

    }
    else if (
        typeof post.bot3_group ===
        'string'
    ) {

        try {

            hasBot3Group =
                !!JSON.parse(
                    post.bot3_group
                );

        }
        catch (e) {

            hasBot3Group =
                false;
        }
    }

    return (
        groups.length > 0 ||
        hasBot3Group
    );
}

// ============================================================
// 🚀 محرك Bot3
// ============================================================

async function startBot3Engine() {

    await logToDashboard(
        '🚀 تم تشغيل محرك البوت الثالث.',
        'success'
    );

    await supabase
        .from('bot_counters')
        .update({
            status:
                'RUNNING'
        })
        .eq(
            'bot_name',
            BOT_ID
        );

    await resetStuckBot3Posts();

    await cleanOldLogs();

    while (true) {

        try {

            // -----------------------------------------------
            // 🛑 حالة Bot3
            // -----------------------------------------------

            const {
                data:
                    counterStatus
            } =
                await supabase
                    .from('bot_counters')
                    .select(
                        'status'
                    )
                    .eq(
                        'bot_name',
                        BOT_ID
                    )
                    .single();

            if (
                counterStatus &&
                [
                    'IDLE',
                    'STOPPED',
                    'PAUSED'
                ].includes(
                    counterStatus.status
                )
            ) {

                await forceKillProcess(
                    'تم رصد حالة الإيقاف في المحرك الرئيسي'
                );

                return;
            }

            // -----------------------------------------------
            // 📦 قراءة الطابور
            // -----------------------------------------------

            const {
                data,
                error
            } =
                await supabase
                    .from('publish_queue')
                    .select('*')
                    .order(
                        'id',
                        {
                            ascending:
                                true
                        }
                    );

            if (error) {

                await logToDashboard(
                    `⚠️ خطأ قراءة الطابور: ${error.message}`,
                    'error'
                );

                await sleep(
                    10000
                );

                continue;
            }

            // -----------------------------------------------
            // 🔎 اختيار إعلان Bot3
            // -----------------------------------------------

            let postToRun =
                null;

            if (
                data &&
                data.length > 0
            ) {

                for (
                    const post
                    of data
                ) {

                    /*
                     * لا نريد تشغيل إعلان
                     * متوقف أو ملغي.
                     */

                    if (
                        [
                            'stopped',
                            'paused',
                            'cancelled',
                            'published',
                            'failed'
                        ].includes(
                            post.status
                        )
                    ) {

                        continue;
                    }

                    if (
                        hasBot3Work(
                            post
                        )
                    ) {

                        postToRun =
                            post;

                        break;
                    }
                }
            }

            // -----------------------------------------------
            // 🏁 لا توجد مهام
            // -----------------------------------------------

            if (!postToRun) {

                await logToDashboard(
                    '🎉 لا توجد إعلانات قيد الانتظار لـ Bot3.',
                    'success'
                );

                await supabase
                    .from('bot_counters')
                    .update({
                        status:
                            'IDLE'
                    })
                    .eq(
                        'bot_name',
                        BOT_ID
                    );

                /*
                 * لا نستخدم forceKillProcess هنا مباشرة
                 * حتى لا نسجل حالة إيقاف خاطئة.
                 *
                 * GitHub Action سينتهي طبيعيًا.
                 */

                return;
            }

            // -----------------------------------------------
            // 🔒 وضع الإعلان Processing
            // -----------------------------------------------

            const {
                error:
                    processingError
            } =
                await supabase
                    .from('publish_queue')
                    .update({
                        status:
                            'processing'
                    })
                    .eq(
                        'id',
                        postToRun.id
                    );

            if (
                processingError
            ) {

                await logToDashboard(
                    `⚠️ تعذر وضع الإعلان #${postToRun.id} في processing: ${processingError.message}`,
                    'warn'
                );

                await sleep(
                    3000
                );

                continue;
            }

            // -----------------------------------------------
            // 🚀 تشغيل الإعلان
            // -----------------------------------------------

            const result =
                await processOnePostBot3(
                    postToRun
                );

            // -----------------------------------------------
            // 🧾 تحديث الحالة حسب النتيجة
            // -----------------------------------------------

            if (
                result?.completed ===
                true
            ) {

                /*
                 * لا نغيّر الإعلان إلى stopped
                 * إلا بعد اكتمال مهمة Bot3.
                 *
                 * إذا كانت بوتات أخرى ما زالت تعمل
                 * فلن نغيّر حالة الإعلان إلى published
                 * هنا؛ processOnePostBot3 هو الذي يتعامل
                 * مع اكتمال جميع المجموعات.
                 */

                await supabase
                    .from('publish_queue')
                    .update({
                        status:
                            'stopped'
                    })
                    .eq(
                        'id',
                        postToRun.id
                    )
                    .eq(
                        'status',
                        'processing'
                    );

                await logToDashboard(
                    `🧾 انتهت مهمة Bot3 للإعلان #${postToRun.id}.`,
                    'info'
                );

            }
            else {

                /*
                 * لا نضع stopped في حالة الخطأ أو
                 * التوقف اليدوي؛ حتى يستطيع Bot3
                 * الاستكمال لاحقًا.
                 */

                const {
                    data:
                        currentPost
                } =
                    await supabase
                        .from('publish_queue')
                        .select(
                            'status'
                        )
                        .eq(
                            'id',
                            postToRun.id
                        )
                        .single();

                if (
                    currentPost &&
                    currentPost.status ===
                    'processing'
                ) {

                    await supabase
                        .from('publish_queue')
                        .update({
                            status:
                                'running'
                        })
                        .eq(
                            'id',
                            postToRun.id
                        )
                        .eq(
                            'status',
                            'processing'
                        );
                }

                await logToDashboard(
                    `🔄 لم تكتمل مهمة Bot3 للإعلان #${postToRun.id}. سيتم إبقاؤها قابلة للاستكمال.`,
                    'warn'
                );
            }

            // -----------------------------------------------
            // ⏳ تأخير بين الإعلانات
            // -----------------------------------------------

            const macroDelay =
                randomDelay(
                    1200,
                    2100
                );

            await logToDashboard(
                `⏳ استراحة بين الإعلانات: ${Math.round(macroDelay / 60000)} دقيقة.`,
                'info'
            );

            await sleep(
                macroDelay
            );

        }
        catch (err) {

            await logToDashboard(
                `❌ خطأ في المحرك الرئيسي: ${err.message}`,
                'error'
            );

            await supabase
                .from('bot_counters')
                .update({
                    status:
                        'ERROR'
                })
                .eq(
                    'bot_name',
                    BOT_ID
                );

            await sleep(
                10000
            );
        }
    }
}

// ============================================================
// 📦 Export
// ============================================================

module.exports =
    processOnePostBot3;

// ============================================================
// ▶️ تشغيل مباشر
// ============================================================

if (
    require.main === module
) {

    startBot3Engine()
        .catch(async err => {

            console.error(
                '❌ خطأ قاتل في Bot3:',
                err
            );

            try {

                await supabase
                    .from('bot_counters')
                    .update({
                        status:
                            'ERROR'
                    })
                    .eq(
                        'bot_name',
                        BOT_ID
                    );

            }
            catch (e) {}

            process.exit(1);
        });
}
