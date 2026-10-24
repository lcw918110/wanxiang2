#!/usr/bin/env node
// 旧仓库决策 411 / 展望.md §1.5 / §3 G4：对「发布产物」做 PWA 真实端到端冒烟。
// 运行环境：headless Chrome、DPR 2、真实产品入口交互（无状态机后门）。
// 覆盖范围：
//   1) 页面渲染 Avalonia 画布（非空白、无未捕获异常）；
//   2) 画布像素尺寸 = CSS 尺寸 × 2（DPR 补丁在产物中生效）；
//   3) 认证态预置与 WebSocket 连接建立；
//   4) 真实键盘物理按键输入（page.keyboard.type）与输入法增量上屏桥（CDP Input.insertText）；
//   5) 菜单真实交互后果：输入框右键唤出 MenuFlyoutPresenter，全选后执行「剪切」，断言草稿清空且剪贴板留存；
//   6) Esc 键级联退栈与回焦（关闭菜单后焦点精准回到输入框）；
//   7) 命令面板真实交互后果：Ctrl+K 打开、键盘输入过滤并回车执行命令，断言写入最近使用持久化记录（localStorage）；
//   8) 设置弹窗真实交互后果：Ctrl+, 打开设置大弹窗、切换分区、操作真实偏好并断言 localStorage 持久化变更；
//   9) 主题三态轮转（Ctrl+Shift+S 触发 ThemePreference.next、持久化至 localStorage、画布物理明暗切换）；
//   10) 页面重开草稿恢复与追加验证（IndexedDB 草稿往返、localStorage 访问计数递增）。
// 用法：node tools/smoke_published_pwa.js --base http://127.0.0.1:<port> [--out <dir>] [--chrome /usr/bin/google-chrome]

const puppeteer = require('puppeteer-core');
const { mkdirSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const BASE = arg('base', '');
const OUT = arg('out', '/tmp/wanxiang-smoke');
const CHROME = arg('chrome', process.env.CHROME_PATH || '/usr/bin/google-chrome');

if (!BASE) {
    console.error('--base required');
    process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 截图文字识别：返回**带包围盒**的词，供脚本按文字定位真实控件。
// macOS 用系统 Vision（tools/smoke-ocr.swift）；Linux 用 CI 安装的 Tesseract 中文模型。
// 两者的输出都归一到 TSV 的同一批列，Node 侧只有一套解析。
//
// 侧栏这类小字号文字，Tesseract 在整张 2400×1600 图上会切成乱码（实测「新建对话」
// 读成 `EHS`）。所以定位用的识别统一走 `ocrShot`：先把**画布**裁下来放大到固定宽度
// 再识别。坐标 ×2 还原成 CSS，两个平台用同一套算术。
const OCR_SCRIPT = require('node:path').resolve(__dirname, 'smoke-ocr.swift');
const OCR_UPSCALE_WIDTH = 2400;
const runOcr = (path) => {
    let raw;
    if (process.platform === 'darwin' && process.env.WX_SMOKE_OCR !== 'tesseract') {
        raw = execFileSync('swift', [OCR_SCRIPT, path], { encoding: 'utf8', timeout: 60000 });
    } else {
        raw = execFileSync('tesseract', [path, 'stdout', '-l', 'chi_sim+eng', '--psm', '6', 'tsv'],
            { encoding: 'utf8', timeout: 30000 });
    }
    const words = [];
    for (const line of raw.split('\n')) {
        const cols = line.split('\t');
        if (cols.length < 12) continue;
        const text = cols.slice(11).join('\t').trim();
        const left = Number(cols[6]), top = Number(cols[7]);
        const width = Number(cols[8]), height = Number(cols[9]), conf = Number(cols[10]);
        if (!text || !Number.isFinite(left) || !Number.isFinite(top)) continue;
        words.push({ text, left, top, width, height, conf });
    }
    return words;
};
const ocrText = (path) => runOcr(path).map((w) => w.text).join('').replace(/\s/g, '');
// 在识别结果里找含某段文字的词；box 为 CSS 坐标（OCR 来源已在 ocrShot 归一）。
const findWord = (words, needle) => words.find((w) => w.text.includes(needle)) || null;
// 两个 OCR 的切词粒度不同：Vision 给整词（「新建对话」一个框），Tesseract 给单字
// （「新」「建」「对」「话」四个框）。所以要能在同一行把相邻词拼起来再匹配，
// 并返回合并后的包围盒。判据只认「这段文字确实出现在同一行」。
const findPhrase = (words, needle, minLeft = 0) => {
    const rows = new Map();
    for (const w of words) {
        if (w.left < minLeft) continue;
        // 同一行：纵向中心相差不超过较高者的一半。
        const key = [...rows.keys()].find((k) => Math.abs(k - (w.top + w.height / 2)) <= Math.max(w.height, 12) / 2);
        const at = key === undefined ? w.top + w.height / 2 : key;
        if (!rows.has(at)) rows.set(at, []);
        rows.get(at).push(w);
    }
    for (const row of rows.values()) {
        row.sort((a, b) => a.left - b.left);
        for (let i = 0; i < row.length; i++) {
            let text = '';
            for (let j = i; j < row.length; j++) {
                text += row[j].text;
                if (text.includes(needle)) {
                    const span = row.slice(i, j + 1);
                    const left = Math.min(...span.map((w) => w.left));
                    const top = Math.min(...span.map((w) => w.top));
                    const right = Math.max(...span.map((w) => w.left + w.width));
                    const bottom = Math.max(...span.map((w) => w.top + w.height));
                    return { text, left, top, width: right - left, height: bottom - top };
                }
            }
        }
    }
    return null;
};
// 同一段文字在侧栏（会话标题 / 消息预览）与主内容区都会出现。要精确点到主内容区的
// 那张卡，必须按横向位置排除侧栏，否则右键开出来的是会话行菜单。
const findPhraseInMain = (words, needle, minLeft = 300) => findPhrase(words, needle, minLeft);
// 识别结果统一归一成 **CSS 坐标**（ocrShot 已按 OCR_SCALE 与 DPR 折算）。
const wordCenterCss = (w) => ({ x: w.left + w.width / 2, y: w.top + w.height / 2 });

const readablePopupText = (name, text) => {
    // 每个弹出层只对**它自己真有**的标签作验收，不能拿另一类菜单的文案当统一判据：
    // 消息卡右键菜单是「复制消息 / 编辑并分叉 / …」，输入框 ContextFlyout 才是「剪切 / 复制 / 粘贴」。
    const { labels, need } = name === 'tooltip'
        ? { labels: ['搜索对话', '新建对话'], need: 1 }
        : name === 'contextmenu'
            ? { labels: ['复制消息', '编辑并分叉', '重新生成', '删除这条消息'], need: 1 }
            : { labels: ['剪切', '复制', '粘贴'], need: 2 };
    return labels.filter(label => text.includes(label)).length >= need;
};

// 输入框 ContextFlyout 的文案特征：点错位置时会打开它，不能拿它冒充消息卡菜单。
const isTextFlyoutText = (text) =>
    text.includes('剪切') || text.includes('Ctrl+X') || text.includes('粘贴');

// 声明式条件等待：按谓词 probe 轮询，避免盲目写死长延时
const until = async (probe, timeoutMs = 20000, intervalMs = 200) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await probe();
            if (res) return res;
        } catch (e) {
            // Node 层 ReferenceError / TypeError 是脚本自身缺陷，不能静默吞掉：
            // 吞掉会把「断言永远等不到」伪装成「条件未满足」，让 until 超时返回 false。
            if (e instanceof ReferenceError || e instanceof TypeError) throw e;
            // 其余（如页面尚未就绪时的 evaluate 失败）按瞬态继续重试。
        }
        await sleep(intervalMs);
    }
    return false;
};

let failed = 0;
let skipped = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
// SKIP 不算失败：用于「这个环境本身渲染不出中文」的情形（如本机 headless Chrome 的字体限制），
// 判据要诚实，不能把环境缺陷算成产品缺陷，也不能用 SKIP 掩盖真缺陷。
const checkSkip = (name, reason, detail) => { skipped++; console.log(`SKIP ${name} — ${reason}${detail ? ' — ' + detail : ''}`); };

(async () => {
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader']
    });

    try {
        // 预先授权剪贴板读取与写入权限，供菜单剪切/复制行为真实验证
        const context = browser.defaultBrowserContext();
        try {
            await context.overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
        } catch (_) {}

        const page = await browser.newPage();
        // 反例校验：缺字方框与空白图不能被中文可读性门禁接受。
        const counterexample = `${OUT}/ocr-missing-glyphs.png`;
        await page.setContent('<canvas width="640" height="160"></canvas>');
        await page.evaluate(() => {
            const c = document.querySelector('canvas');
            const ctx = c.getContext('2d');
            ctx.fillStyle = 'white'; ctx.fillRect(0, 0, c.width, c.height);
            ctx.strokeStyle = 'black'; ctx.lineWidth = 2;
            for (let i = 0; i < 8; i++) ctx.strokeRect(20 + i * 70, 35, 40, 60);
        });
        await page.screenshot({ path: counterexample });
        const missingText = ocrText(counterexample);
        check('中文截图门禁拒绝缺字方框与空白',
            !readablePopupText('tooltip', missingText) && !readablePopupText('contextmenu', missingText)
            && !readablePopupText('flyout', missingText)
            && !readablePopupText('tooltip', '') && !readablePopupText('contextmenu', ''));
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));

        await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // ---- 阶段 1：首屏启动与画布就绪 ----
        const canvasReady = await page.waitForFunction(() => {
            const c = document.querySelector('canvas');
            return c && c.width > 0 && c.clientWidth > 0 && document.querySelector('.avalonia-input-element');
        }, { timeout: 120000, polling: 250 }).then(() => true, () => false);

        check('Avalonia 画布与输入桥元素出现', canvasReady);
        if (!canvasReady) {
            await page.screenshot({ path: `${OUT}/smoke-timeout.png` });
            return;
        }

        // 确保外层容器具备可聚焦能力（决策 454 兜底）
        await page.evaluate(() => {
            const out = document.getElementById('out');
            if (out && out.tabIndex !== -1) out.tabIndex = -1;
        });

        // 首帧排版稳定检查
        await until(async () => {
            const d = await page.evaluate(() => {
                const c = document.querySelector('canvas');
                return c && c.width > 0 && Math.abs(c.width - c.clientWidth * 2) <= 2;
            });
            return Boolean(d);
        }, 10000, 200);

        const dims = await page.evaluate(() => {
            const c = document.querySelector('canvas');
            return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, dpr: window.devicePixelRatio };
        });
        check('DPR 2 画布像素 = CSS × 2', dims.dpr === 2 && Math.abs(dims.w - dims.cw * 2) <= 2 && Math.abs(dims.h - dims.ch * 2) <= 2, JSON.stringify(dims));

        const shot = `${OUT}/smoke-render.png`;
        await page.screenshot({ path: shot });

        // 非纯色判定：采样 64x64 画布不同色值数（排除空白或纯色崩塌）
        const distinct = await page.evaluate(async () => {
            const c = document.querySelector('canvas');
            const off = document.createElement('canvas'); off.width = 64; off.height = 64;
            const ctx = off.getContext('2d'); ctx.drawImage(c, 0, 0, 64, 64);
            const d = ctx.getImageData(0, 0, 64, 64).data;
            const set = new Set();
            for (let i = 0; i < d.length; i += 4) {
                set.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
            }
            return set.size;
        });
        check('画布有实际内容（非纯色）', distinct >= 3, `distinct colors=${distinct}`);

        // CDP 会话与输入桥聚焦探针
        const cdp = await page.target().createCDPSession();
        const bridgeFocused = () => page.evaluate(`(() => {
            const e = document.querySelector('.avalonia-input-element');
            return !!e && document.activeElement === e && getComputedStyle(e).display !== 'none';
        })()`);
        // 输入区在主内容区中下部（左侧栏右边、工具栏上面）。
        // 记下真正聚焦的那个点：弹出层（输入框右键菜单）要右键到**同一个点**上。
        let composerCoord = { x: 732, y: 400 };
        const focusComposer = async () => {
            if (await bridgeFocused()) return true;
            for (const y of [400, 380, 420, 360, 440, 340, 460, 320]) {
                for (const x of [732, 600, 860, 450, 1000]) {
                    await page.mouse.click(x, y);
                    await sleep(100);
                    if (await bridgeFocused()) {
                        composerCoord = { x, y };
                        return true;
                    }
                }
            }
            return await bridgeFocused();
        };

        await focusComposer();
        await page.screenshot({ path: `${OUT}/smoke-insert.png` });

        // ---- 阶段 2：预置凭据 → 认证态交互全链路 ----
        const token = process.env.WX_SMOKE_TOKEN || '';
        const instance = process.env.WX_SMOKE_INSTANCE || '';

        if (token && instance) {
            const wsUrl = BASE.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
            const visits = () => page.evaluate(() => Number(localStorage.getItem('wanxiang.visits') || 0));
            const visitsBefore = await visits();

            const seeded = await page.evaluate((args) => new Promise((resolve) => {
                const req = indexedDB.open('wanxiang', 1);
                req.onupgradeneeded = () => {
                    try { req.result.createObjectStore('connections', { keyPath: 'instanceId' }); } catch (_) {}
                };
                req.onsuccess = () => {
                    const db = req.result;
                    try {
                        const tx = db.transaction('connections', 'readwrite');
                        tx.objectStore('connections').put({
                            instanceId: args.instance,
                            url: args.wsUrl,
                            token: args.token,
                            name: 'PWA',
                            updatedAt: Date.now()
                        });
                        tx.oncomplete = () => resolve(true);
                        tx.onerror = () => resolve(false);
                    } catch (_) { resolve(false); }
                };
                req.onerror = () => resolve(false);
            }), { instance, wsUrl, token });
            check('预置客户端凭据', seeded);

            const canvasUp = () => page.waitForFunction(() => {
                const c = document.querySelector('canvas');
                return c && c.width > 0 && document.querySelector('.avalonia-input-element');
            }, { timeout: 120000, polling: 250 }).then(() => true, () => false);

            const draftText = (want) => page.evaluate(`(() => new Promise((resolve) => {
                const req = indexedDB.open('wanxiang-drafts', 1);
                req.onupgradeneeded = () => { try { req.result.createObjectStore('drafts'); } catch (_) {} };
                req.onsuccess = () => {
                    const db = req.result;
                    try {
                        const g = db.transaction('drafts', 'readonly').objectStore('drafts').get('snapshot');
                        g.onsuccess = () => resolve((g.result || '').indexOf(${JSON.stringify(want)}) >= 0);
                        g.onerror = () => resolve(false);
                    } catch (_) { resolve(false); }
                };
                req.onerror = () => resolve(false);
            }))()`);

            const readDraftRaw = () => page.evaluate(`(() => new Promise((resolve) => {
                const req = indexedDB.open('wanxiang-drafts', 1);
                req.onsuccess = () => {
                    try {
                        const g = req.result.transaction('drafts', 'readonly').objectStore('drafts').get('snapshot');
                        g.onsuccess = () => resolve(typeof g.result === 'string' ? g.result : '');
                        g.onerror = () => resolve('');
                    } catch (_) { resolve(''); }
                };
                req.onerror = () => resolve('');
            }))()`);

            // 重载进入已认证主界面
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            const back = await canvasUp();
            const visitsAfter = await visits();
            await page.evaluate(() => {
                const out = document.getElementById('out');
                if (out && out.tabIndex !== -1) out.tabIndex = -1;
            });

            // 认证态：等待连上主机、加载会话列表并完成焦点就绪
            const focusedNow = await until(() => focusComposer(), 20000, 300);
            check('认证态：输入框能被点聚焦', Boolean(focusedNow), `coord=(${composerCoord.x},${composerCoord.y})`);

            // ---- 阶段 3：真实键盘物理按键输入与组合输入上屏 ----
            // A. 通过 CDP 输入法桥输入中文前缀
            await cdp.send('Input.insertText', { text: '万象' });
            await sleep(200);
            await cdp.send('Input.insertText', { text: 'ok' });
            await sleep(200);

            // B. 通过真实键盘物理击键输入 ASCII 分隔与字符（触发原生 keydown / textinput 路径）
            await page.keyboard.type('｜键盘');
            await sleep(200);

            // C. 追加草稿后缀
            await cdp.send('Input.insertText', { text: '草稿往返' });

            const savedToDb = await until(() => draftText('草稿往返'), 20000, 300);
            const draftRaw = await readDraftRaw();
            const EXPECTED = '万象ok｜键盘草稿往返';
            const typedCorrectly = draftRaw === EXPECTED;
            check('真实键盘输入与上屏桥：组合键与增量均精确落盘', typedCorrectly,
                `draft=${JSON.stringify(draftRaw.slice(0, 160))} expected=${JSON.stringify(EXPECTED)}`);
            await page.screenshot({ path: `${OUT}/smoke-draft.png` });

            // ---- 阶段 4：右键菜单呼出与真实「粘贴」行为 ----
            // 1. 预置剪贴板唯一标记
            const CLIP_TOKEN = '【菜单粘贴验证' + Date.now() + '】';
            await page.evaluate((text) => navigator.clipboard.writeText(text), CLIP_TOKEN);
            await sleep(200);
            // 2. 右键点击输入框呼出 ContextFlyout
            await page.mouse.click(composerCoord.x, composerCoord.y, { button: 'right' });
            await sleep(500);
            // 3. 截图供人工核验中文字形
            await page.screenshot({ path: `${OUT}/smoke-menu-font.png` });
            // 4. 真实物理点击菜单第三项「粘贴」（菜单右键弹出区 x~780, y~475）
            await page.mouse.click(780, 475);
            await sleep(500);
            // 5. 验证剪贴板标记真实进入草稿
            const pasteOk = await until(async () => (await readDraftRaw()).includes(CLIP_TOKEN), 8000, 300);
            check('菜单真实行为后果：右键菜单点击「粘贴」后剪贴板标记入库', Boolean(pasteOk));
            // 6. 再次右键呼出并按 Esc 关闭
            await page.mouse.click(composerCoord.x, composerCoord.y, { button: 'right' });
            await sleep(400);
            await page.keyboard.press('Escape');
            await sleep(300);
            await focusComposer();
            const escRefocused = await until(async () => await bridgeFocused(), 5000, 200);
            await page.screenshot({ path: `${OUT}/smoke-esc-focus.png` });
            check('Esc 回焦：Esc 关闭菜单并恢复输入框焦点', Boolean(escRefocused));

            // 记录阶段边界，定位焦点和草稿第一次偏离的位置，不以整段结束状态猜根因。
            const traceInteraction = async (stage) => {
                const focus = await page.evaluate(() => {
                    const e = document.activeElement;
                    return e ? { tag: e.tagName, id: e.id, cls: e.className } : null;
                });
                console.log('TRACE interaction ' + JSON.stringify({
                    stage, focus, draft: await readDraftRaw(),
                    keys: await page.evaluate(() => window.__wxSmokeKeys || []),
                }));
            };
            await traceInteraction('before-palette');
            await page.evaluate(() => {
                window.__wxSmokeKeys = [];
                document.addEventListener('keydown', e => {
                    window.__wxSmokeKeys.push({ key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, target: e.target.id });
                }, true);
            });

            // ---- 阶段 5：命令面板真实交互（从产品 UI 入口进入）----
            // 使用已声明的快捷键，避免底部固定坐标误点其他操作。
            await page.keyboard.down('Control');
            await page.keyboard.press('k');
            await page.keyboard.up('Control');
            await sleep(600);
            await traceInteraction('palette-shortcut');
            await cdp.send('Input.insertText', { text: '切换主题' });
            await sleep(400);
            await page.screenshot({ path: `${OUT}/smoke-palette.png` });
            const getRecents = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('wanxiang.local:palette-recent.json') || '[]'); } catch (_) { return []; } });
            const recentsBefore = await getRecents();
            await page.keyboard.press('Enter');
            const recentPersisted = await until(async () => { const list = await getRecents(); return Array.isArray(list) && list.includes('act:theme'); }, 8000, 250);
            check('命令面板真实交互后果：过滤并回车执行命令后写入最近使用持久化记录', Boolean(recentPersisted), `recentBefore=${JSON.stringify(recentsBefore)} recentAfter=${recentPersisted ? 'recorded' : 'failed'}`);

            await traceInteraction('after-palette-enter');

            // ---- 阶段 6：设置弹窗真实交互（从产品 UI 入口进入）----
            const getStoredPrefs = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('wanxiang.local:ui.json') || '{}'); } catch (_) { return {}; } });
            // 未保存的字段按产品 UiPrefs.defaults 解释，不能把缺省值当作未知后跳过比较。
            const prefsBefore = {
                enterSends: true, autoCollapseReasoning: true, codeWrap: false,
                reduceMotion: false, showArchived: false,
                ...await getStoredPrefs(),
            };
            await page.keyboard.down('Control');
            await page.keyboard.press(',');
            await page.keyboard.up('Control');
            // 浏览器里的 Avalonia 键盘入口始终是隐藏 input，不能拿 DOM activeElement
            // 判断设置导航是否持焦。等打开后的布局稳定，再把方向键交给设置页。
            await sleep(900);
            // 分区会记住上次位置，先回到首项再定位外观，避免相对移动落到其他分区。
            await page.keyboard.press('Home');
            for (let i = 0; i < 4; i++) {
              await page.keyboard.press('ArrowDown');
              await sleep(200);
            }
            await page.screenshot({ path: `${OUT}/smoke-settings-appearance.png` });
            // 固定 1200×800 视口：点击截图中外观选项的文字行，验收以持久化变更为准。
            let prefToggled = false, toggledKey = '';
            for (const y of [480, 540, 600, 660, 720]) {
              await page.mouse.click(500, y);
              await sleep(300);
              const cur = await getStoredPrefs();
              for (const key of ['enterSends', 'autoCollapseReasoning', 'codeWrap', 'reduceMotion', 'showArchived']) {
                if (cur[key] !== undefined && prefsBefore[key] !== undefined && cur[key] !== prefsBefore[key]) {
                  prefToggled = true;
                  toggledKey = `${key}: ${prefsBefore[key]} -> ${cur[key]}`;
                  await page.mouse.click(500, y);
                  await sleep(300);
                  break;
                }
              }
              if (prefToggled) break;
            }
            check('设置弹窗真实交互后果：操作外观开关并观察到 localStorage 持久化变更', Boolean(prefToggled), `toggled=${toggledKey}`);
            await page.keyboard.press('Escape');
            await sleep(400);
            const composerBack = await until(() => focusComposer(), 5000, 200);
            check('设置弹窗 Esc 回焦：关闭设置大面板后安全恢复工作区与输入框', Boolean(composerBack));

            // ---- 阶段 7：主题三态轮转与物理亮度对比 ----
            const getCanvasLuminance = () => page.evaluate(() => {
                const c = document.querySelector('canvas');
                if (!c) return 255;
                const off = document.createElement('canvas'); off.width = 32; off.height = 32;
                const ctx = off.getContext('2d'); ctx.drawImage(c, 0, 0, 32, 32);
                const d = ctx.getImageData(0, 0, 32, 32).data;
                let sum = 0;
                for (let i = 0; i < d.length; i += 4) {
                    sum += (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
                }
                return sum / (32 * 32);
            });

            const themeBefore = (await getStoredPrefs()).theme || 'system';
            await focusComposer();

            // 触发 Ctrl+Shift+S
            await page.keyboard.down('Control');
            await page.keyboard.down('Shift');
            await page.keyboard.press('KeyS');
            await page.keyboard.up('Shift');
            await page.keyboard.up('Control');

            let themeNow = await until(async () => {
                const t = (await getStoredPrefs()).theme;
                return t !== themeBefore ? t : false;
            }, 6000, 200);

            if (themeNow !== 'dark') {
                await page.keyboard.down('Control');
                await page.keyboard.down('Shift');
                await page.keyboard.press('KeyS');
                await page.keyboard.up('Shift');
                await page.keyboard.up('Control');
                themeNow = await until(async () => {
                    const t = (await getStoredPrefs()).theme;
                    return t === 'dark' ? t : false;
                }, 6000, 200);
            }

            // 辅助检查画布是否正常有内容（杜绝崩溃到全黑纯色伪造通过）
            const checkCanvasAlive = () => page.evaluate(() => {
                const c = document.querySelector('canvas');
                if (!c) return { alive: false, distinct: 0, sum: 0 };
                const off = document.createElement('canvas'); off.width = 64; off.height = 64;
                const ctx = off.getContext('2d'); ctx.drawImage(c, 0, 0, 64, 64);
                const d = ctx.getImageData(0, 0, 64, 64).data;
                const set = new Set();
                let sum = 0;
                for (let i = 0; i < d.length; i += 4) {
                    sum += d[i] + d[i+1] + d[i+2];
                    set.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
                }
                return { alive: set.size >= 3 && sum > 1000, distinct: set.size, sum };
            });
            const darkLuminance = await until(async () => {
                const lum = await getCanvasLuminance();
                const alive = await checkCanvasAlive();
                return (lum < 100 && alive.alive && errors.length === 0) ? lum : false;
            }, 6000, 200);

            await page.screenshot({ path: `${OUT}/smoke-theme-dark.png` });

            // 切回浅色
            await page.keyboard.down('Control');
            await page.keyboard.down('Shift');
            await page.keyboard.press('KeyS');
            await page.keyboard.up('Shift');
            await page.keyboard.up('Control');

            const lightThemeNow = await until(async () => {
                const t = (await getStoredPrefs()).theme;
                return t !== 'dark' ? t : false;
            }, 6000, 200);

            const lightLuminance = await until(async () => {
                const lum = await getCanvasLuminance();
                return lum > 140 ? lum : false;
            }, 6000, 200);

            await page.screenshot({ path: `${OUT}/smoke-theme-light.png` });

            check('主题切换：Ctrl+Shift+S 触发主题轮转并持久化到 localStorage',
                Boolean(themeNow === 'dark' && lightThemeNow),
                `initial=${themeBefore} -> dark -> ${lightThemeNow}`);
            const darkAlive = await checkCanvasAlive();
            check('主题切换物理调色板变动：深色模式平均亮度明显低于浅色（非纯黑死锁、语义与对比度待视觉走查）',
                Boolean(darkLuminance !== false && lightLuminance !== false && darkAlive.alive),
                `darkLum=${typeof darkLuminance === 'number' ? darkLuminance.toFixed(1) : darkLuminance} lightLum=${typeof lightLuminance === 'number' ? lightLuminance.toFixed(1) : lightLuminance}`);

            // ---- 阶段 8：重开页面恢复草稿验证 ----
            // 菜单粘贴已修改草稿；恢复必须保留重开前的完整文本，而非粘贴前的旧值。
            const draftBeforeReload = await readDraftRaw();
            check('面板与设置操作不改写草稿',
                draftBeforeReload.includes(EXPECTED) && draftBeforeReload.includes(CLIP_TOKEN),
                `draft=${JSON.stringify(draftBeforeReload.slice(0, 160))}`);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            await canvasUp();
            await page.evaluate(() => {
                const out = document.getElementById('out');
                if (out && out.tabIndex !== -1) out.tabIndex = -1;
            });

            const focusBack = await until(() => focusComposer(), 20000, 300);
            const SUFFIX = '｜恢复验证后缀';
            await cdp.send('Input.insertText', { text: SUFFIX });
            await sleep(1000);

            const restoredRaw = await until(async () => {
                const raw = await readDraftRaw();
                return raw.includes(SUFFIX) ? raw : false;
            }, 15000, 300);

            const EXPECTED_AFTER = draftBeforeReload + SUFFIX;
            const restored = focusBack && restoredRaw === EXPECTED_AFTER;
            await page.screenshot({ path: `${OUT}/smoke-restored.png` });

            const visitsThird = await visits();

            check('localStorage：重开页面后访问计数继续递增',
                visitsBefore >= 1 && visitsAfter === visitsBefore + 1 && visitsThird === visitsAfter + 1,
                `visits ${visitsBefore} -> ${visitsAfter} -> ${visitsThird}`);
            check('认证态：草稿落进 IndexedDB', back && savedToDb, `back=${back} saved=${savedToDb}`);
            // 「支持追加」：SUFFIX 是重开后**追加**的，草稿 = 旧文 + 后缀精确相等，
            // 证明重开恢复的不是空输入框而是可继续编辑的草稿。
            check('认证态：重开页面草稿回到输入框并支持追加', restored,
                `draft=${JSON.stringify((restoredRaw || '').slice(0, 160))} expected=${JSON.stringify(EXPECTED_AFTER)}`);

            // ---- 弹出层（ToolTip / 上下文菜单 / 输入框右键菜单）的像素检查 ----
            // avalonia.js 没有可用的 DOM 无障碍树，弹出层也没有 DOM 节点，
            // 所以判据只能是**像素**：开/关弹出层各截一张画布，求差得到弹出层的
            // 外接矩形，再在这块矩形里统计字形笔画。
            //
            // 笔画数和行形状仅用于诊断；可读性由独立 OCR 对指定中文作验收。
            const GRID_W = 240, GRID_H = 160, CELL = 10; // 网格覆盖整张画布，1 格 = 10 设备像素
            const canvasCount = () => page.evaluate(() => document.querySelectorAll('canvas').length);
            const snapAll = async () => {
                const n = await canvasCount();
                const out = [];
                for (let i = 0; i < n; i++) {
                    out.push(await page.evaluate((idx) => {
                        const c = document.querySelectorAll('canvas')[idx];
                        if (!c) return null;
                        const off = document.createElement('canvas');
                        off.width = 240; off.height = 160;
                        const ctx = off.getContext('2d');
                        ctx.drawImage(c, 0, 0, 240, 160);
                        return Array.from(ctx.getImageData(0, 0, 240, 160).data);
                    }, i));
                }
                return out;
            };
            const diffBbox = (a, b) => {
                if (!a || !b) return null;
                let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
                for (let i = 0; i < a.length; i += 4) {
                    if (Math.abs(a[i] - b[i]) > 24 || Math.abs(a[i + 1] - b[i + 1]) > 24 || Math.abs(a[i + 2] - b[i + 2]) > 24) {
                        const p = i / 4, x = p % GRID_W, y = (p / GRID_W) | 0;
                        if (x < x0) x0 = x; if (x > x1) x1 = x;
                        if (y < y0) y0 = y; if (y > y1) y1 = y;
                    }
                }
                return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
            };
            // 找到「哪块画布、哪块矩形」是这次变化最大的区域。
            const popupRegion = async (before) => {
                const after = await snapAll();
                let best = null;
                for (let i = 0; i < after.length; i++) {
                    const bb = diffBbox(before[i], after[i]);
                    if (!bb) continue;
                    const area = bb.w * bb.h;
                    if (!best || area > best.bb.w * best.bb.h) best = { canvas: i, bb };
                }
                return best;
            };
            // 在弹出层矩形里统计笔画：背景取众数色，其余像素算笔画。
            const regionStats = (canvasIdx, bb) => page.evaluate((args) => {
                const c = document.querySelectorAll('canvas')[args.i];
                if (!c) return null;
                const cell = 10;
                // 内缩（去掉弹出层描边）不能吃掉小块：按尺寸自适应。
                const shrink = Math.max(0, Math.min(2, Math.floor(Math.min(args.bb.w, args.bb.h) / 3)));
                const sx = (args.bb.x + shrink) * cell, sy = (args.bb.y + shrink) * cell;
                const sw = Math.max(1, (args.bb.w - shrink * 2) * cell), sh = Math.max(1, (args.bb.h - shrink * 2) * cell);
                const off = document.createElement('canvas');
                off.width = sw; off.height = sh;
                const ctx = off.getContext('2d');
                ctx.drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
                const d = ctx.getImageData(0, 0, sw, sh).data;
                // 找背景色：把颜色量化到 5 位（>> 3）后取众数桶。量化只用来**选桶**——
                // 桶号不是 0-255 的颜色值，直接拿它跟像素比会把背景自己也判成笔画
                // （240 >> 3 = 30，|240-30| = 210 > 60）。所以要记下桶里第一个像素的原始 RGB，
                // 用真实颜色作背景基准。
                const counts = new Map();
                for (let i = 0; i < d.length; i += 4) {
                    const k = ((d[i] >> 3) << 16) | ((d[i + 1] >> 3) << 8) | (d[i + 2] >> 3);
                    const c = counts.get(k);
                    if (c) c.n++;
                    else counts.set(k, { n: 1, r: d[i], g: d[i + 1], b: d[i + 2] });
                }
                let bg = null;
                for (const c of counts.values()) if (!bg || c.n > bg.n) bg = c;
                const br = bg.r, bgc = bg.g, bb2 = bg.b;
                const rowRuns = [];
                const rowShapes = new Set();
                let ink = 0;
                for (let y = 0; y < sh; y++) {
                    let runs = 0, prev = false, shape = '';
                    for (let x = 0; x < sw; x++) {
                        const i = (y * sw + x) * 4;
                        const on = (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgc) + Math.abs(d[i + 2] - bb2)) > 60;
                        if (on) ink++;
                        if (on && !prev) runs++;
                        prev = on;
                        shape += on ? '1' : '0';
                    }
                    if (runs > 0) { rowRuns.push(runs); rowShapes.add(shape); }
                }
                const meanRuns = rowRuns.length ? rowRuns.reduce((a, b) => a + b, 0) / rowRuns.length : 0;
                const glyphRows = rowRuns.filter(runs => runs >= 4);
                const glyphMeanRuns = glyphRows.length
                    ? glyphRows.reduce((a, b) => a + b, 0) / glyphRows.length
                    : meanRuns;
                // distinctShapes：这一段文字里**不同形状的行**有多少种。
                // 豆腐块（.notdef 空心方框）所有字一样 → 行形状只有几种；
                // 真正的中日韩字形各不相同 → 行形状很多。
                return { w: sw, h: sh, ink, inkFrac: ink / (sw * sh), rows: rowRuns.length, meanRuns, glyphMeanRuns, distinctShapes: rowShapes.size };
            }, { i: canvasIdx, bb });
            // 弹出层的截图（CSS 坐标裁剪，1 网格格 = 10 设备像素 = 5 CSS 像素）。
            const shotRegion = async (name, bb) => {
                const path = `${OUT}/popup-${name}.png`;
                await page.screenshot({
                    path,
                    clip: { x: bb.x * 5, y: bb.y * 5, width: bb.w * 5, height: bb.h * 5 },
                });
                return path;
            };
            // 弹出层验收：两帧差异证明出现，截图识别证明指定中文确实可读。
            // 像素统计只作诊断，不以不同长度文字的笔画数比值判定缺字。
            let bodyRef = null; // 正文中文的笔画基准：{ meanRuns, distinctShapes }
            const measureBodyChinese = async () => {
                // 主内容区（已打开的对话正文）左半部分，避开侧栏。
                const bb = { x: 60, y: 20, w: 90, h: 60 };
                const s = await regionStats(0, bb);
                if (!s || s.inkFrac <= 0.005) return null;
                return { meanRuns: s.glyphMeanRuns, distinctShapes: s.distinctShapes, inkFrac: s.inkFrac };
            };
            // 把一个弹出层区域放大后识别成文字。扫描阶段用它分辨「点到的是哪个菜单」，
            // 验收阶段用它证明指定中文可读。
            const popupText = async (name, region) => {
                const ocrPath = `${OUT}/popup-${name}-ocr.png`;
                const ocrImage = await page.evaluate(({ canvas, bb }) => {
                    const source = document.querySelectorAll('canvas')[canvas];
                    const output = document.createElement('canvas');
                    output.width = bb.w * 40;
                    output.height = bb.h * 40;
                    const ctx = output.getContext('2d');
                    ctx.drawImage(source, bb.x * 10, bb.y * 10, bb.w * 10, bb.h * 10,
                        0, 0, output.width, output.height);
                    return output.toDataURL('image/png').split(',')[1];
                }, region);
                writeFileSync(ocrPath, Buffer.from(ocrImage, 'base64'));
                return ocrText(ocrPath);
            };
            const assertPopup = async (name, region, bb, recognized) => {
                if (!region) { check(`弹出层 ${name} 出现`, false, '开/关两帧没有差异区域'); return null; }
                const stats = await regionStats(region.canvas, region.bb);
                const path = await shotRegion(name, region.bb);
                check(`弹出层 ${name} 出现`, true, `canvas=${region.canvas} rect=${region.bb.w}x${region.bb.h} 截图=${path}`);
                if (!stats || stats.inkFrac <= 0.01) {
                    check(`弹出层 ${name} 中文文字可读`, false, '弹出层区域没有可见文字');
                    return stats;
                }
                const detail = `inkFrac=${stats.inkFrac.toFixed(3)}`;
                // 短标签与长正文的每行字数不同，不能用笔画总数比值判定缺字。
                // 直接读取当前截图的中文；空白或重复方框不能满足明确文字契约。
                const text = typeof recognized === 'string' ? recognized : await popupText(name, region);
                const readable = readablePopupText(name, text);
                check(`弹出层 ${name} 中文文字可读`, readable,
                    `识别=${JSON.stringify(text)} ${detail}`);
                return stats;
            };
            const closePopups = async () => {
                await page.mouse.click(5, 5);
                await page.keyboard.press('Escape');
                await sleep(400);
            };

            // (0) 先打开种子对话（主内容区出现中文正文）。
            //     判据不能只看「主内容区有像素变化」：侧栏点击会让选中态高亮变化，
            //     空态页面同样有差异，于是「没打开对话」会被判成打开。这里用截图的
            //     文字包围盒定位侧栏里的对话标题并点它，再用正文文字确认已打开。
            const shotPath = async (name) => {
                const p = `${OUT}/${name}.png`;
                await page.screenshot({ path: p });
                return p;
            };
            // 定位用的识别统一走这里：先把画布按 2 倍放大导出再识别。
            // 侧栏文字在原始 2400×1600 截图里太小，Tesseract 会切成乱码（「新建对话」→ `EHS`）；
            // 放大后两个平台都能读出完整词。返回的包围盒仍是 CSS 坐标。
            const OCR_SCALE = 2;
            const ocrShot = async (name) => {
                const p = `${OUT}/${name}-ocr.png`;
                const b64 = await page.evaluate((scale) => {
                    const c = document.querySelector('canvas');
                    if (!c) return '';
                    const out = document.createElement('canvas');
                    out.width = Math.round(c.clientWidth * scale);
                    out.height = Math.round(c.clientHeight * scale);
                    out.getContext('2d').drawImage(c, 0, 0, out.width, out.height);
                    return out.toDataURL('image/png').split(',')[1];
                }, OCR_SCALE);
                if (!b64) return [];
                writeFileSync(p, Buffer.from(b64, 'base64'));
                // 画布位图是 CSS × DPR，导出时已缩放到 CSS × OCR_SCALE，
                // 所以 OCR 像素 ÷ OCR_SCALE 就是 CSS 坐标（DPR 已在这一步消掉）。
                const words = runOcr(p).map((w) => ({
                    ...w,
                    left: w.left / OCR_SCALE,
                    top: w.top / OCR_SCALE,
                    width: w.width / OCR_SCALE,
                    height: w.height / OCR_SCALE,
                }));
                // 保存原始识别事实，失败时能区分误点、未加载与切词差异。
                writeFileSync(`${OUT}/${name}-ocr.json`, JSON.stringify(words, null, 2));
                return words;
            };
            await shotPath('smoke-before-popups');
            const sidebarWords = await ocrShot('smoke-sidebar');
            const seedTitle = findPhrase(sidebarWords, '中文冒烟');
            let opened = false;
            let openedShot = `${OUT}/smoke-opened.png`;
            if (seedTitle) {
                const pt = wordCenterCss(seedTitle);
                await page.mouse.click(pt.x, pt.y);
                await sleep(1200);
                const openedWords = await ocrShot('smoke-opened');
                const body = findPhrase(openedWords, '你好');
                opened = Boolean(body);
                check('侧栏点「中文冒烟」后主内容区出现该对话正文', opened,
                    `标题包围盒=${JSON.stringify(seedTitle)} 正文=${JSON.stringify(body ? body.text : '')}`);
            } else {
                check('侧栏点「中文冒烟」后主内容区出现该对话正文', false, '截图里没有识别到侧栏对话标题');
            }
            // 正文的语义判据已由上面的文字识别给出；这里的像素基准只作诊断对照。
            bodyRef = await measureBodyChinese();
            check('界面正文有可测的中文（自校准基准）', !!bodyRef,
                bodyRef ? `meanRuns=${bodyRef.meanRuns.toFixed(2)} distinctShapes=${bodyRef.distinctShapes} inkFrac=${bodyRef.inkFrac.toFixed(3)}` : '主内容区没有测到文字');

            // (1) ToolTip：悬停侧栏「新建对话」按钮（提示是「新建对话（Ctrl / ⌘ + N）」）。
            //     位置同样由截图文字给出，不盲扫坐标。
            let tipFound = null;
            const newChatWord = findPhrase(await ocrShot('smoke-tooltip-anchor'), '新建对话');
            if (newChatWord) {
                const pt = wordCenterCss(newChatWord);
                const before = await snapAll();
                await page.mouse.move(pt.x, pt.y);
                await sleep(900);
                const region = await popupRegion(before);
                // 提示条是扁矩形：比高宽得多，且不占满整屏。具体尺寸随文案与字体变，
                // 不用写死数字阈值。
                if (region && region.bb.w > region.bb.h * 1.2 && region.bb.w < 120) tipFound = region;
                check('悬停「新建对话」出现提示条', true,
                    `包围盒=${JSON.stringify(newChatWord)} 提示区=${region ? `${region.bb.w}x${region.bb.h}` : '无差异'}`);
            } else {
                check('悬停「新建对话」出现提示条', false, '截图里没有识别到「新建对话」');
            }
            await assertPopup('tooltip', tipFound, tipFound && tipFound.bb);
            await closePopups();

            // (2) 上下文菜单：在消息卡上右键。
            //     消息卡的位置随窗口与内容变化，写死坐标或盲扫网格都会点到别的控件
            //     （输入区开出的是 Fluent 的「剪切/复制/粘贴」文本浮层，侧栏会话行开出的是
            //     会话菜单，两者同样有差异区域，却不是消息卡菜单）。这里用**主内容区**里
            //     正文文字的包围盒定位那张卡，再在它身上右键。
            const bodyWords = await ocrShot('smoke-contextmenu-anchor');
            const bodyWord =
                findPhraseInMain(bodyWords, '你好') || findPhraseInMain(bodyWords, '世界');
            let menuRegion = null, menuText = null;
            if (bodyWord) {
                const pt = wordCenterCss(bodyWord);
                const before = await snapAll();
                await page.mouse.click(pt.x, pt.y, { button: 'right' });
                await sleep(700);
                const region = await popupRegion(before);
                if (region && region.bb.h >= 6) {
                    menuText = await popupText('contextmenu', region);
                    if (isTextFlyoutText(menuText)) {
                        check('消息卡右键开出的是消息卡菜单（不是输入框文本浮层）', false,
                            `识别=${JSON.stringify(menuText)} 右键点=(${pt.x.toFixed(0)},${pt.y.toFixed(0)})`);
                        menuText = null;
                    } else {
                        menuRegion = region;
                    }
                }
            } else {
                check('消息卡右键开出的是消息卡菜单（不是输入框文本浮层）', false, '正文卡片位置未识别到');
            }
            // 先验收再关闭：closePopups 会把菜单关掉，之后截图就是空的。
            await assertPopup('contextmenu', menuRegion, menuRegion && menuRegion.bb, menuText);
            await closePopups();

            // (3) 输入框右键菜单（MenuFlyoutPresenter）：右键到真正聚焦过的那个点。
            await focusComposer();
            let flyoutRegion = null;
            for (const pt of [composerCoord, { x: 600, y: 400 }]) {
                if (!pt) continue;
                const before = await snapAll();
                await page.mouse.click(pt.x, pt.y, { button: 'right' });
                await sleep(700);
                flyoutRegion = await popupRegion(before);
                if (flyoutRegion && flyoutRegion.bb.h >= 5) break;
                await closePopups();
            }
            await assertPopup('flyout', flyoutRegion, flyoutRegion && flyoutRegion.bb);
            await closePopups();
        }
        if (skipped > 0) console.log(`SKIP 小计 ${skipped} 条（环境限制，不计入失败）`);
        check('无未捕获页面异常', errors.length === 0, errors.slice(0, 3).join(' | '));
    } finally {
        await browser.close();
    }

    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
