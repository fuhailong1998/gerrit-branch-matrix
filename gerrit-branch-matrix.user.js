// ==UserScript==
// @name         Gerrit 主线覆盖矩阵
// @namespace    https://github.com/fuhailong1998/gerrit-branch-matrix
// @version      1.9.4
// @description  在 Gerrit 变更页显示该变更在各目标分支的同步状态，提供覆盖矩阵面板、cherry-pick 与「无需同步」标记
// @match        http://10.2.12.42/gerrit/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

/*
 * 只读 Gerrit 查询走同源 fetch，复用浏览器登录态，不保存任何凭据。
 * cherry-pick 为写操作，使用 Gerrit 网页的 XSRF 令牌，失败时给出可读提示。
 * 仓库、目标分支与「无需同步」标记全部保存在本浏览器。
 *
 * 安装后点浏览器工具栏的 Tampermonkey 图标 →「设置 Gerrit 地址」，填写你的 Gerrit 地址
 * （含 /gerrit 之类的子路径），之后在该站点右下角会出现图标。
 * 也可以直接打开 Gerrit 页面，脚本会自动识别。
 */
(function () {
    'use strict';

    const pageWin = () => (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);

    /** 由页面推断当前 Gerrit 地址与子路径：CANONICAL_PATH 是 Gerrit 页面公开的部署路径。 */
    function detectGerritUrl() {
        const canonical = pageWin().CANONICAL_PATH;
        if (typeof canonical !== 'string') {
            return null;
        }
        return (location.origin + canonical.replace(/\/+$/, '')).replace(/\/+$/, '');
    }

    /**
     * 访问 Gerrit 的根地址，来自用户在配置面板中填写的「连接地址」，
     * 未填写时回落到当前页面推断出的地址。支持跨域访问其它 Gerrit 站点。
     */
    function baseUrl() {
        const configured = (loadConnection() || '').trim().replace(/\/+$/, '');
        if (configured) {
            return configured;
        }
        const canonical = pageWin().CANONICAL_PATH;
        return location.origin + (typeof canonical === 'string' ? canonical.replace(/\/+$/, '') : '');
    }

    /** 未配置地址时，通过页面结构识别 Gerrit。 */
    const isGerritPage = () => !!document.querySelector('gr-app')
        || typeof pageWin().CANONICAL_PATH === 'string';
    const CONFIG_KEY = 'branchMatrixConfig';
    const MARKS_KEY = 'branchMatrixMarks';
    const CONN_KEY = 'branchMatrixConnection';
    const FAB_KEY = 'branchMatrixFabPos';
    const BOX_KEY = 'branchMatrixBoxPos';
    const BOX_GRIP = 120;
    const SCHEMA = 2;
    const TOAST_MS = 8000;
    const FAB_SIZE = 66;
    const FAB_MARGIN = 20;
    const DRAG_SLOP = 4;
    const RANK = {MERGED: 3, NEW: 2, ABANDONED: 1};
    /** 首次使用不预置任何仓库，由用户在配置面板中添加。 */
    const DEFAULT_REPOS = [];

    // ------------------------------------------------------------ 图标（24×24 视口，统一线宽）

    const svg = (body, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" , 30)
        aria-hidden="true" focusable="false">${body}</svg>`;

    const ICON = {
        matrix: svg(`<rect x="3" y="3" width="18" height="18" rx="3.5"/>
            <rect x="7" y="7" width="4" height="4" rx=".8" fill="currentColor" stroke="none"/>
            <rect x="13" y="7" width="4" height="4" rx=".8" fill="currentColor" stroke="none" opacity=".35"/>
            <rect x="7" y="13" width="4" height="4" rx=".8" fill="currentColor" stroke="none" opacity=".35"/>
            <rect x="13" y="13" width="4" height="4" rx=".8" fill="currentColor" stroke="none"/>`, 30),
        gear: svg(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8
            2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7
            1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1
            0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0
            1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0
            1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0
            0-1.5 1z"/>`),
        refresh: svg('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
        close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
        plus: svg('<path d="M12 5v14M5 12h14"/>', 14),
        trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>', 14),
        merged: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>', 14),
        review: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 14),
        abandoned: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>', 14),
        missing: svg('<circle cx="12" cy="12" r="9" stroke-dasharray="3 2.6"/><path d="m9.5 9.5 5 5m0-5-5 5"/>', 14),
        skip: svg('<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>', 14),
        error: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
            + '<path d="M12 9v4M12 17h.01"/>', 14),
    };

    const STATUS = {
        MERGED: {icon: ICON.merged, text: '已合入', tone: 'merged'},
        NEW: {icon: ICON.review, text: '评审中', tone: 'review'},
        ABANDONED: {icon: ICON.abandoned, text: '已放弃', tone: 'abandoned'},
        NONE: {icon: ICON.missing, text: '未同步', tone: 'missing'},
        MARKED: {icon: ICON.skip, text: '无需同步', tone: 'skip'},
        ERROR: {icon: ICON.error, text: '查询失败', tone: 'error'},
    };

    // ------------------------------------------------------------ 小工具

    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
    const changeUrl = (project, num) => `${baseUrl()}/c/${project}/+/${num}`;
    const title = (t) => (t.note ? `${t.note}（${t.branch}）` : t.branch);
    const shortName = (project) => project.split('/').pop() || project;
    /** 仓库显示名：优先用户自定义名称，否则取项目路径末段。 */
    const repoName = (r) => (r.name || '').trim() || shortName(r.project || '') || '(未命名)';
    const fmtTime = (d) => d.toLocaleString('zh-CN', {hour12: false});
    const localTime = (text) => {
        if (!text) {
            return '';
        }
        const d = new Date(text.replace(' ', 'T') + (text.includes('.') ? '' : 'Z'));
        return isNaN(d.getTime()) ? String(text).slice(0, 16) : fmtTime(d);
    };

    // ------------------------------------------------------------ 配置读写

    /** 兼容 v1 的 {项目: {mainline, show, targets}} 结构。 */
    function normalize(raw) {
        if (!raw) {
            return {schema: SCHEMA, repos: []};
        }
        if (Array.isArray(raw.repos)) {
            return {schema: SCHEMA, repos: raw.repos, activeRepo: raw.activeRepo};
        }
        const repos = Object.entries(raw)
            .filter(([, c]) => c && typeof c === 'object')
            .map(([project, c]) => ({project, mainline: c.mainline || '', show: c.show || 30, targets: c.targets || []}));
        return {schema: SCHEMA, repos, activeRepo: repos[0]?.project};
    }

    function loadConfig() {
        let raw = null;
        try {
            raw = JSON.parse(GM_getValue(CONFIG_KEY, '') || 'null');
        } catch (e) {
            raw = null;
        }
        if (!raw) {
            return {schema: SCHEMA, repos: DEFAULT_REPOS.map((r) => JSON.parse(JSON.stringify(r)))};
        }
        return normalize(raw);
    }

    const saveConfig = (cfg) => GM_setValue(CONFIG_KEY, JSON.stringify(cfg));

    /** Gerrit 连接地址（根地址，含部署子路径）。 */
    const loadConnection = () => GM_getValue(CONN_KEY, '') || '';
    const saveConnection = (url) => GM_setValue(CONN_KEY, url.trim().replace(/\/+$/, ''));

    /** 校验配置，返回错误信息数组。 */
    function validate(cfg) {
        const errors = [];
        if (!cfg.repos.length) {
            errors.push('至少需要一个仓库');
        }
        const seen = new Set();
        const names = new Set();
        for (const repo of cfg.repos) {
            const name = repo.project || '(空仓库)';
            if (!repo.project) {
                errors.push('存在未填写 Gerrit 项目路径的仓库');
            } else if (seen.has(repo.project)) {
                errors.push(`仓库重复：${repo.project}`);
            }
            seen.add(repo.project);
            const shown = repoName(repo);
            if (names.has(shown)) {
                errors.push(`显示名称重复：${shown}，请修改其中一个`);
            }
            names.add(shown);
            if (!repo.mainline) {
                errors.push(`${name}：未设置主线分支`);
            }
            for (const t of repo.targets) {
                if (!t.branch) {
                    errors.push(`${name}：存在未填写分支名的目标分支`);
                } else if (t.branch === repo.mainline) {
                    errors.push(`${name}：目标分支 ${t.branch} 与主线相同`);
                }
            }
        }
        return errors;
    }

    // ------------------------------------------------------------ 无需同步标记

    const markKey = (project, branch, changeId) => `${project}|${branch}|${changeId}`;

    function loadMarks() {
        try {
            return JSON.parse(GM_getValue(MARKS_KEY, '') || '{}');
        } catch (e) {
            return {};
        }
    }

    const saveMarks = (marks) => GM_setValue(MARKS_KEY, JSON.stringify(marks));

    // ------------------------------------------------------------ 浮动按钮位置

    /** 悬浮按钮的位置，坐标非法或陈旧时回落到右下角。 */
    function loadFabPos() {
        const fallback = () => ({x: window.innerWidth - FAB_SIZE - FAB_MARGIN,
            y: window.innerHeight - FAB_SIZE - FAB_MARGIN});
        try {
            const saved = JSON.parse(GM_getValue(FAB_KEY, '') || 'null');
            if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) {
                return fallback();
            }
            return clampFabPos(saved);
        } catch (e) {
            return fallback();
        }
    }

    const clampFabPos = (pos) => ({
        x: Math.min(Math.max(pos.x, FAB_MARGIN), Math.max(FAB_MARGIN, window.innerWidth - FAB_SIZE - FAB_MARGIN)),
        y: Math.min(Math.max(pos.y, FAB_MARGIN), Math.max(FAB_MARGIN, window.innerHeight - FAB_SIZE - FAB_MARGIN)),
    });

    const saveFabPos = (pos) => GM_setValue(FAB_KEY, JSON.stringify(pos));

    /**
     * 拖动移动按钮。位置以自身 style 为准（不依赖 offsetLeft 的布局结果）。
     * 未发生移动的 pointerup 视为点击；随后的合成 click 会被抑制，键盘触发的 click 不受影响。
     */
    function makeDraggable(btn, onActivate) {
        let drag = null;
        let suppressClick = false;
        const nowPos = () => ({
            x: parseFloat(btn.style.left) || 0,
            y: parseFloat(btn.style.top) || 0,
        });
        const capture = (id, on) => {
            try {
                (on ? btn.setPointerCapture : btn.releasePointerCapture)?.call(btn, id);
            } catch (e) {
                /* 指针捕获不可用不影响拖动本身 */
            }
        };
        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) {
                return;
            }
            drag = {startX: e.clientX, startY: e.clientY, origin: nowPos(), moved: false};
            capture(e.pointerId, true);
            btn.dataset.dragging = '1';
        });
        btn.addEventListener('pointermove', (e) => {
            if (!drag) {
                return;
            }
            const pos = {x: drag.origin.x + e.clientX - drag.startX, y: drag.origin.y + e.clientY - drag.startY};
            if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) > DRAG_SLOP) {
                drag.moved = true;
            }
            Object.assign(btn.style, clampStyle(pos));
        });
        const endDrag = (e, activateIfStill) => {
            if (!drag) {
                return;
            }
            const moved = drag.moved;
            drag = null;
            btn.dataset.dragging = '';
            capture(e?.pointerId, false);
            if (moved) {
                const pos = clampFabPos(nowPos());
                Object.assign(btn.style, clampStyle(pos));
                saveFabPos(pos);
            }
            // 无论是否移动，随后的合成 click 都不应再触发一次操作
            suppressClick = true;
            setTimeout(() => {
                suppressClick = false;
            }, 0);
            if (!moved && activateIfStill) {
                onActivate();
            }
        };
        btn.addEventListener('pointerup', (e) => endDrag(e, true));
        btn.addEventListener('pointercancel', (e) => endDrag(e, false));
        btn.addEventListener('click', () => {
            if (suppressClick) {
                suppressClick = false;
                return;
            }
            onActivate();
        });
    }

    const clampStyle = (pos) => ({left: `${pos.x}px`, top: `${pos.y}px`, right: 'auto', bottom: 'auto'});

    // ------------------------------------------------------------ Gerrit

    /** Gerrit 3.x 网页把 XSRF 令牌放在 XSRF_TOKEN cookie 中，写操作需以 X-Gerrit-Auth 头回传。 */
    function csrfToken() {
        const cookie = document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('XSRF_TOKEN='));
        if (cookie) {
            return decodeURIComponent(cookie.slice('XSRF_TOKEN='.length));
        }
        const meta = document.head.querySelector('meta[name="X-Gerrit-Auth"]');
        return meta?.content || null;
    }

    /** 访问配置的 Gerrit 站点时需要携带该站点的 cookie；同站点用 same-origin 即可。 */
    const fetchCredentials = () => (isSameOrigin(baseUrl()) ? 'same-origin' : 'include');

    const isSameOrigin = (url) => {
        try {
            return new URL(url, location.href).origin === location.origin;
        } catch (e) {
            return true;
        }
    };

    const strip = (text) => (text.startsWith(")]}'") ? text.slice(text.indexOf('\n') + 1) : text);

    async function get(path) {
        const resp = await fetch(`${baseUrl()}${path}`, {credentials: fetchCredentials()});
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        return JSON.parse(strip(await resp.text()));
    }

    async function post(path, body) {
        const token = csrfToken();
        if (!token) {
            throw new Error('未找到 Gerrit 鉴权令牌，请确认已在 Gerrit 网页上登录');
        }
        const resp = await fetch(`${baseUrl()}${path}`, {
            method: 'POST',
            credentials: fetchCredentials(),
            headers: {'Content-Type': 'application/json', 'X-Gerrit-Auth': token},
            body: JSON.stringify(body),
        });
        const text = strip(await resp.text());
        if (!resp.ok) {
            let detail = text.slice(0, 300);
            try {
                detail = JSON.parse(text).message || detail;
            } catch (e) {
                /* 保持原文 */
            }
            throw new Error(`HTTP ${resp.status}: ${detail}`);
        }
        return text ? JSON.parse(text) : {};
    }

    const query = (q, n) => get(`/changes/?q=${encodeURIComponent(q)}&n=${n}`);
    const fetchBranches = async (project) => (await get(`/projects/${encodeURIComponent(project)}/branches/?n=1000`))
        // 只取 refs/heads/ 下的真实分支，排除 HEAD 等符号引用
        .map((b) => String(b.ref || '')).filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length)).sort();

    /** 返回 {changeId: {status, number}}，同一 Change-Id 取最优状态。 */
    async function targetStatus(project, branch, changeIds) {
        const result = {};
        for (let i = 0; i < changeIds.length; i += 40) {
            const ids = changeIds.slice(i, i + 40).map((id) => `change:${id}`).join(' OR ');
            const list = await query(`project:"${project}" branch:"${branch}" (${ids})`, 500);
            for (const ch of list) {
                const prev = result[ch.change_id];
                if (!prev || (RANK[ch.status] || 0) > (RANK[prev.status] || 0)) {
                    result[ch.change_id] = {status: ch.status, number: ch._number};
                }
            }
        }
        return result;
    }

    /** 测试连接：读取服务器版本与当前登录账号。 */
    async function testConnection(root) {
        const opts = {credentials: isSameOrigin(root) ? 'same-origin' : 'include'};
        try {
            const v = await fetch(`${root}/config/server/version`, opts);
            if (!v.ok) {
                return {ok: false, text: `无法访问：HTTP ${v.status}，请确认地址（含 /gerrit 之类的子路径）`};
            }
            const version = JSON.parse(strip(await v.text()));
            const a = await fetch(`${root}/accounts/self`, opts);
            if (!a.ok) {
                return {ok: false, text: `已连接 Gerrit ${version}，但未登录：请先在该站点登录`};
            }
            const me = JSON.parse(strip(await a.text()));
            return {ok: true, text: `已连接 Gerrit ${version}，登录为 ${me.username || me.name || me.email || '当前用户'}`};
        } catch (e) {
            return {ok: false, text: `连接失败：${e.message}（跨站点时请检查第三方 Cookie 与 CORS）`};
        }
    }

    /** 把某个变更 cherry-pick 到目标分支，Gerrit 会保留原 Change-Id。 */
    async function cherryPick(changeNumber, branch) {
        const created = await post(`/changes/${changeNumber}/revisions/current/cherrypick`,
            {destination: `refs/heads/${branch}`});
        return {number: created._number, changeId: created.change_id};
    }

    // ------------------------------------------------------------ 样式与主题

    const STYLE = `
        .bm-root{
            --bm-bg:#ffffff;--bm-fg:#1f2328;--bm-muted:#59636e;--bm-border:#d0d7de;--bm-subtle:#f6f8fa;
            --bm-hover:#eef1f4;--bm-accent:#0969da;--bm-sel:#ddf4ff;--bm-shadow:0 8px 24px rgba(31,35,40,.18);
            --bm-merged:#1a7f37;--bm-review:#0969da;--bm-abandoned:#59636e;--bm-missing:#953800;
            --bm-skip:#8250df;--bm-error:#cf222e;
            --bm-merged-bg:#dafbe1;--bm-review-bg:#ddf4ff;--bm-abandoned-bg:#eaeef2;
            --bm-missing-bg:#fff1e5;--bm-skip-bg:#fbefff;--bm-error-bg:#ffebe9;
            color:var(--bm-fg);font:13px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
        }
        .bm-root[data-theme=dark]{
            --bm-bg:#161b22;--bm-fg:#e6edf3;--bm-muted:#9198a1;--bm-border:#3d444d;--bm-subtle:#212830;
            --bm-hover:#262c36;--bm-accent:#4493f8;--bm-sel:#1b3352;--bm-shadow:0 8px 24px rgba(0,0,0,.5);
            --bm-merged:#3fb950;--bm-review:#79c0ff;--bm-abandoned:#9198a1;--bm-missing:#ffa657;
            --bm-skip:#ab7df8;--bm-error:#f85149;
            --bm-merged-bg:#122b1a;--bm-review-bg:#142b45;--bm-abandoned-bg:#262c36;
            --bm-missing-bg:#3d2414;--bm-skip-bg:#2b2042;--bm-error-bg:#3b1b20;
        }
        .bm-root *{box-sizing:border-box}
        .bm-root button,.bm-root input,.bm-root select,.bm-root textarea{font:inherit;color:inherit}
        .bm-root :focus-visible{outline:2px solid var(--bm-accent);outline-offset:1px}
        .bm-root a{color:var(--bm-accent);text-decoration:none}
        .bm-btn svg,.bm-icon-btn svg{display:block;flex:none}
        .bm-root a:hover{text-decoration:underline}

        #bm-box{position:fixed;z-index:99999;background:var(--bm-bg);border:1px solid var(--bm-border);
            border-radius:10px;box-shadow:var(--bm-shadow);display:flex;flex-direction:column;overflow:hidden}
        #bm-box .bm-head{display:flex;gap:8px;align-items:center;padding:8px 10px 8px 14px;
            border-bottom:1px solid var(--bm-border);background:var(--bm-subtle);cursor:move;user-select:none;
            touch-action:none}
        #bm-box .bm-head :is(button,select,input,a){cursor:pointer}
        #bm-box[data-dragging="1"]{opacity:.92;box-shadow:0 12px 32px rgba(31,35,40,.3)}
        #bm-box .bm-head h2{margin:0;font-size:14px;font-weight:600}
        #bm-box .bm-body{overflow:auto;padding:10px 14px;flex:1;min-height:0}
        #bm-box .bm-foot{padding:6px 14px;border-top:1px solid var(--bm-border);color:var(--bm-muted);
            display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:12px}
        #bm-box .bm-foot span{display:inline-flex;gap:4px;align-items:center}

        .bm-btn{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:4px 12px;cursor:pointer;
            line-height:1;vertical-align:middle;
            border:1px solid var(--bm-border);border-radius:6px;background:var(--bm-bg);
            transition:background-color .15s,border-color .15s}
        .bm-btn:hover{background:var(--bm-hover)}
        .bm-btn:disabled{opacity:.55;cursor:default}
        .bm-btn.bm-primary{background:var(--bm-accent);border-color:var(--bm-accent);color:#fff}
        .bm-btn.bm-primary:hover{filter:brightness(1.08)}
        .bm-btn.bm-danger{color:var(--bm-error)}
        .bm-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;
            border:1px solid transparent;border-radius:6px;background:none;cursor:pointer;color:var(--bm-muted);
            transition:background-color .15s,color .15s}
        .bm-icon-btn:hover{background:var(--bm-hover);color:var(--bm-fg)}

        #bm-box select,#bm-box input,#bm-box textarea{border:1px solid var(--bm-border);border-radius:6px;
            padding:4px 8px;min-height:30px;background:var(--bm-bg);min-width:0}
        #bm-box label{color:var(--bm-muted);font-size:12px}

        #bm-box table{border-collapse:separate;border-spacing:0;width:100%}
        #bm-box th,#bm-box td{border-bottom:1px solid var(--bm-border);padding:6px 10px;text-align:left;
            white-space:nowrap;vertical-align:middle}
        #bm-box th{background:var(--bm-subtle);position:sticky;top:-10px;z-index:1;font-weight:600}
        #bm-box tbody tr:hover td{background:var(--bm-subtle)}
        #bm-box td.bm-num{color:var(--bm-muted);font-variant-numeric:tabular-nums}
        #bm-box td.bm-subject{max-width:420px;overflow:hidden;text-overflow:ellipsis}
        #bm-box .bm-change-num{display:inline-block;min-width:6ch;color:var(--bm-muted);
            font-variant-numeric:tabular-nums}
        #bm-box td.bm-time{color:var(--bm-muted);font-variant-numeric:tabular-nums}

        .bm-cell{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;
            border:1px solid transparent;background:none;cursor:default;white-space:nowrap;line-height:20px}
        a.bm-cell,button.bm-cell{cursor:pointer}
        a.bm-cell:hover,button.bm-cell:hover{background:var(--bm-hover);border-color:var(--bm-border);
            text-decoration:none}
        button.bm-cell[aria-busy=true]{cursor:progress;opacity:.7}
        .bm-root .bm-tone-merged{color:var(--bm-merged);--bm-tone-bg:var(--bm-merged-bg)}
        .bm-root .bm-tone-review{color:var(--bm-review);--bm-tone-bg:var(--bm-review-bg)}
        .bm-root .bm-tone-abandoned{color:var(--bm-abandoned);--bm-tone-bg:var(--bm-abandoned-bg)}
        .bm-root .bm-tone-missing{color:var(--bm-missing);--bm-tone-bg:var(--bm-missing-bg)}
        .bm-root .bm-tone-skip{color:var(--bm-skip);--bm-tone-bg:var(--bm-skip-bg)}
        .bm-root .bm-tone-error{color:var(--bm-error);--bm-tone-bg:var(--bm-error-bg)}
        .bm-root .bm-cell{background:var(--bm-tone-bg)}
        .bm-root .bm-cell:hover{background:var(--bm-tone-bg);border-color:currentColor}
        .bm-caret{opacity:.6;font-size:10px}

        .bm-layout{display:flex;min-height:340px;height:calc(100% - 92px)}
        .bm-side{width:280px;flex:none;border-right:1px solid var(--bm-border);padding:12px;overflow:auto}
        .bm-main{flex:1;padding:12px 16px;overflow:auto;min-width:0}
        .bm-row{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
        .bm-field{display:flex;flex-direction:column;gap:3px}
        .bm-repo{display:flex;flex-direction:column;gap:1px;width:100%;text-align:left;padding:7px 10px;
            border:1px solid transparent;border-radius:8px;background:none;cursor:pointer;margin-bottom:4px;
            transition:background-color .15s}
        .bm-repo:hover{background:var(--bm-hover)}
        .bm-repo[aria-current=true]{background:var(--bm-sel);border-color:var(--bm-accent)}
        .bm-repo small{color:var(--bm-muted)}
        .bm-hint{color:var(--bm-muted)}
        .bm-errors{margin:0 0 10px;padding:8px 12px 8px 28px;border:1px solid var(--bm-error);border-radius:6px;
            color:var(--bm-error)}
        .bm-section{font-size:12px;font-weight:600;color:var(--bm-muted);text-transform:none;margin:14px 0 8px}
        .bm-empty{padding:28px;text-align:center;color:var(--bm-muted)}
        .bm-conn{padding:10px 16px;border-bottom:1px solid var(--bm-border);background:var(--bm-subtle)}
        .bm-conn code{font-size:12px}
        .bm-add{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;padding:8px;
            border:1px solid var(--bm-border);border-radius:8px;background:var(--bm-subtle)}
        .bm-picker{margin:0 0 12px;padding:10px;border:1px solid var(--bm-accent);border-radius:8px;
            background:var(--bm-subtle)}
        .bm-pick-list{max-height:220px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));
            gap:2px 12px;padding:4px;border:1px solid var(--bm-border);border-radius:6px;background:var(--bm-bg)}
        .bm-check{display:inline-flex;gap:6px;align-items:center;min-height:28px;padding:2px 6px;border-radius:4px;
            cursor:pointer;color:var(--bm-fg)!important;font-size:13px!important}
        .bm-check:hover{background:var(--bm-hover)}
        .bm-check input{min-height:0;margin:0;cursor:pointer}
        .bm-actions{display:inline-flex;gap:8px;align-items:center;flex:none}
        .bm-btn-plain{padding:4px 12px}

        #bm-menu{position:fixed;z-index:100001;min-width:230px;max-width:340px;padding:4px;background:var(--bm-bg);
            border:1px solid var(--bm-border);border-radius:8px;box-shadow:var(--bm-shadow)}
        #bm-menu [role=menuitem]{display:flex;gap:8px;align-items:center;width:100%;text-align:left;border:none;
            background:none;padding:7px 10px;border-radius:6px;cursor:pointer;min-height:32px}
        #bm-menu [role=menuitem]:hover,#bm-menu [role=menuitem]:focus-visible{background:var(--bm-hover);outline:none}
        #bm-menu .bm-menu-form{padding:8px 10px;display:flex;flex-direction:column;gap:8px}
        #bm-menu .bm-menu-form p{margin:0;white-space:normal}
        #bm-menu .bm-menu-form input{border:1px solid var(--bm-border);border-radius:6px;padding:4px 8px;
            min-height:30px;background:var(--bm-bg)}
        #bm-menu .bm-menu-actions{display:flex;gap:8px;justify-content:flex-end}
        #bm-menu .bm-menu-note{padding:6px 10px 8px;font-size:12px;white-space:pre-wrap;word-break:break-word}

        #bm-toasts{position:fixed;z-index:100002;left:50%;bottom:20px;transform:translateX(-50%);display:flex;
            flex-direction:column;gap:8px;align-items:center;pointer-events:none}
        .bm-toast{pointer-events:auto;display:flex;gap:10px;align-items:flex-start;max-width:min(560px,92vw);
            padding:10px 12px 10px 14px;background:var(--bm-bg);border:1px solid var(--bm-border);
            border-left:4px solid var(--bm-merged);border-radius:8px;box-shadow:var(--bm-shadow)}
        .bm-toast[data-kind=error]{border-left-color:var(--bm-error)}
        .bm-toast div{white-space:pre-wrap;word-break:break-word;flex:1}

        #bm-fab{position:fixed;z-index:100000;width:66px;height:66px;border-radius:50%;display:flex;
            align-items:center;justify-content:center;padding:0;cursor:grab;touch-action:none;
            background:var(--bm-bg);color:var(--bm-accent);border:1px solid var(--bm-border);
            box-shadow:0 4px 16px rgba(31,35,40,.22);transition:background-color .15s,box-shadow .15s,opacity .15s}
        #bm-fab:hover{background:var(--bm-hover);box-shadow:0 6px 20px rgba(31,35,40,.3)}
        #bm-fab[data-dragging="1"]{cursor:grabbing;opacity:.85;transition:none}
        #bm-fab::after{content:"拖动可移动";position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);
            font-size:10px;color:var(--bm-muted);white-space:nowrap;opacity:0;transition:opacity .15s}
        #bm-fab:hover::after{opacity:1}

        @media (max-width:760px){
            .bm-layout{flex-direction:column}
            .bm-side{width:auto;border-right:none;border-bottom:1px solid var(--bm-border)}
            #bm-box td.bm-subject{max-width:220px}
        }
        @media (prefers-reduced-motion:reduce){
            .bm-root,.bm-root *{transition:none!important}
        }
    `;

    /** 跟随 Gerrit 当前主题：按页面实际背景亮度判断明暗。 */
    function hostTheme() {
        for (const el of [document.body, document.documentElement]) {
            const m = getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g);
            if (m && (m.length < 4 || +m[3] > 0)) {
                const [r, g, b] = m.map(Number);
                return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45 ? 'dark' : 'light';
            }
        }
        return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function themed(el) {
        el.classList.add('bm-root');
        el.dataset.theme = hostTheme();
        return el;
    }

    // ------------------------------------------------------------ 提示条

    function toast(html, kind = 'ok') {
        let host = document.getElementById('bm-toasts');
        if (!host) {
            host = themed(document.createElement('div'));
            host.id = 'bm-toasts';
            host.setAttribute('role', 'status');
            host.setAttribute('aria-live', 'polite');
            document.body.appendChild(host);
        }
        host.dataset.theme = hostTheme();
        const item = document.createElement('div');
        item.className = 'bm-toast';
        item.dataset.kind = kind;
        item.innerHTML = `<div>${html}</div>`;
        const close = document.createElement('button');
        close.className = 'bm-icon-btn';
        close.innerHTML = ICON.close;
        close.setAttribute('aria-label', '关闭提示');
        close.onclick = () => item.remove();
        item.appendChild(close);
        host.appendChild(item);
        if (kind !== 'error') {
            setTimeout(() => item.remove(), TOAST_MS);
        }
        return item;
    }

    // ------------------------------------------------------------ 浮层容器

    function iconButton(icon, label, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bm-icon-btn';
        btn.innerHTML = icon;
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.onclick = onClick;
        return btn;
    }

    /**
     * 打开浮层，返回 {box, head, body, foot}。head 中依次放：标题、调用方控件、弹性空白、操作图标、关闭。
     * kind 用于记忆该类面板拖动后的位置；标题栏空白处可拖动。
     */
    function openBox(css, heading, actions = [], kind = null) {
        closeBox();
        const box = themed(document.createElement('section'));
        box.id = 'bm-box';
        box.style.cssText = css;
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-label', heading);
        box.dataset.kind = kind || heading;
        box.innerHTML = `<header class="bm-head" title="拖动标题栏可移动，双击复位"><h2>${esc(heading)}</h2>
            <span data-slot="controls" style="display:contents"></span><span style="flex:1"></span>
            <span data-slot="actions" style="display:contents"></span></header><div class="bm-body"></div>`;
        const slot = box.querySelector('[data-slot=actions]');
        for (const [icon, label, onClick] of actions) {
            slot.appendChild(iconButton(icon, label, onClick));
        }
        slot.appendChild(iconButton(ICON.close, '关闭', closeBox));
        document.body.appendChild(box);
        if (kind) {
            makeBoxDraggable(box, kind);
        }
        onBoxChange();
        return {
            box,
            head: box.querySelector('[data-slot=controls]'),
            body: box.querySelector('.bm-body'),
            foot: (html) => {
                box.querySelector('.bm-foot')?.remove();
                const foot = document.createElement('footer');
                foot.className = 'bm-foot';
                foot.innerHTML = html;
                box.appendChild(foot);
            },
        };
    }

    // ------------------------------------------------------------ 面板拖动

    const loadBoxPos = () => {
        try {
            return JSON.parse(GM_getValue(BOX_KEY, '') || '{}');
        } catch (e) {
            return {};
        }
    };

    /** 把面板左上角夹在视口内，至少保留标题栏可见可抓。 */
    function clampBox(box, x, y) {
        const w = box.offsetWidth || 320;
        const keep = BOX_GRIP;
        return {
            x: Math.min(Math.max(x, keep - w), window.innerWidth - keep),
            y: Math.min(Math.max(y, 0), window.innerHeight - keep),
        };
    }

    function placeBox(box, pos) {
        const p = clampBox(box, pos.x, pos.y);
        Object.assign(box.style, {left: `${p.x}px`, top: `${p.y}px`, right: 'auto', bottom: 'auto', transform: 'none'});
        return p;
    }

    /** 标题栏拖动；按钮、输入框等交互控件不触发拖动。位置按面板类型记忆。 */
    function makeBoxDraggable(box, kind) {
        const head = box.querySelector('.bm-head');
        const saved = loadBoxPos()[kind];
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
            placeBox(box, saved);
        }
        let drag = null;
        head.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.target.closest('button, input, select, textarea, a')) {
                return;
            }
            const rect = box.getBoundingClientRect();
            drag = {startX: e.clientX, startY: e.clientY, x: rect.left, y: rect.top};
            try {
                head.setPointerCapture(e.pointerId);
            } catch (err) {
                /* 指针捕获不可用不影响拖动 */
            }
            box.dataset.dragging = '1';
            e.preventDefault();
        });
        head.addEventListener('pointermove', (e) => {
            if (drag) {
                placeBox(box, {x: drag.x + e.clientX - drag.startX, y: drag.y + e.clientY - drag.startY});
            }
        });
        const end = () => {
            if (!drag) {
                return;
            }
            drag = null;
            box.dataset.dragging = '';
            const all = loadBoxPos();
            all[kind] = {x: parseFloat(box.style.left) || 0, y: parseFloat(box.style.top) || 0};
            GM_setValue(BOX_KEY, JSON.stringify(all));
        };
        head.addEventListener('pointerup', end);
        head.addEventListener('pointercancel', end);
        head.addEventListener('dblclick', (e) => {
            if (e.target.closest('button, input, select, textarea, a')) {
                return;
            }
            const all = loadBoxPos();
            delete all[kind];
            GM_setValue(BOX_KEY, JSON.stringify(all));
            const css = box.dataset.initialCss;
            if (css) {
                box.style.cssText = css;
            }
        });
        box.dataset.initialCss = box.style.cssText;
        if (saved) {
            box.dataset.initialCss = '';
        }
    }

    /** 面板开关时通知图标同步展开状态；由 init 注入实现。 */
    let onBoxChange = () => {};

    const isMatrixOpen = () => document.getElementById('bm-box')?.dataset.kind === 'matrix';
    const isBoxOpen = () => !!document.getElementById('bm-box');

    function closeBox() {
        closeMenu();
        if (document.getElementById('bm-box')) {
            document.getElementById('bm-box').remove();
            onBoxChange();
        }
    }

    // ------------------------------------------------------------ 单元格

    const badge = (s, extra = '') => `${s.icon}<span>${esc(s.text)}</span>${extra}`;

    /** 单元格 HTML：已合入/评审中为链接；未同步/已放弃/已标记为可操作按钮。 */
    function cellHtml(project, info, mark, attrs = '') {
        if (info && info.number && (info.status === 'MERGED' || info.status === 'NEW')) {
            const s = STATUS[info.status];
            return `<a class="bm-cell bm-tone-${s.tone}" href="${changeUrl(project, info.number)}" target="_blank"
                title="打开目标分支上的变更 ${info.number}">${badge(s)}</a>`;
        }
        if (mark) {
            const s = STATUS.MARKED;
            const tip = `标记于 ${fmtTime(new Date(mark.at))}${mark.reason ? `\n原因：${mark.reason}` : ''}`;
            return `<button type="button" class="bm-cell bm-tone-${s.tone}" title="${esc(tip)}" aria-haspopup="menu"
                ${attrs}>${badge(s, '<span class="bm-caret">▾</span>')}</button>`;
        }
        const s = STATUS[info ? info.status : 'NONE'] || STATUS.NONE;
        return `<button type="button" class="bm-cell bm-tone-${s.tone}" title="选择操作" aria-haspopup="menu"
            ${attrs}>${badge(s, '<span class="bm-caret">▾</span>')}</button>`;
    }

    const errorCell = (message) => `<span class="bm-cell bm-tone-error" title="${esc(message)}">
        ${badge(STATUS.ERROR)}</span>`;

    // ------------------------------------------------------------ 操作菜单

    let menuState = null;

    function closeMenu(restoreFocus = false) {
        if (!menuState) {
            return;
        }
        document.removeEventListener('mousedown', menuState.outside, true);
        menuState.menu.remove();
        if (restoreFocus && menuState.anchor.isConnected) {
            menuState.anchor.focus();
        }
        menuState = null;
    }

    /** 在锚点下方打开菜单；items 为 [{label, icon, run}]，run 可调用 ctx.form() 切换为内嵌表单。 */
    function openMenu(anchor, items) {
        closeMenu();
        const menu = themed(document.createElement('div'));
        menu.id = 'bm-menu';
        menu.setAttribute('role', 'menu');
        const place = () => {
            const rect = anchor.getBoundingClientRect();
            const top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
            const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
            menu.style.top = `${Math.max(8, top)}px`;
            menu.style.left = `${Math.max(8, left)}px`;
        };
        const ctx = {
            close: () => closeMenu(true),
            /** 菜单内提示，失败时留在原处，成功则稍后自动收起。 */
            notice(message, kind = 'ok') {
                const old = menu.querySelector('.bm-menu-note');
                old?.remove();
                const note = document.createElement('div');
                note.className = `bm-menu-note bm-tone-${kind === 'error' ? 'error' : 'merged'}`;
                note.setAttribute('role', kind === 'error' ? 'alert' : 'status');
                note.textContent = message;
                menu.appendChild(note);
                if (kind !== 'error') {
                    setTimeout(() => note.remove(), 6000);
                }
                return note;
            },
            /**
             * 把菜单内容换成一个小表单：说明、可选输入框、取消/确认。
             * onConfirm 可为 async；期间按钮进入执行态，结果直接显示在菜单里，不依赖提示条。
             */
            form({message, input, confirmText, cancelText = '取消', busyText = '正在执行…', confirmId, onConfirm}) {
                menu.innerHTML = '';
                menu.setAttribute('role', 'dialog');
                const form = document.createElement('form');
                form.className = 'bm-menu-form';
                form.noValidate = true;
                form.innerHTML = `<p>${message}</p>${input ? `<input type="text" placeholder="${esc(input)}"
                    aria-label="${esc(input)}">` : ''}<div class="bm-menu-actions">
                    ${cancelText ? '<button type="button" class="bm-btn" data-act="cancel">取消</button>' : ''}
                    <button type="submit" class="bm-btn bm-primary" data-act="confirm"
                        ${confirmId ? `data-id="${esc(confirmId)}"` : ''}>${esc(confirmText)}</button>
                    </div>`;
                const confirm = form.querySelector('[data-act=confirm]');
                form.querySelector('[data-act=cancel]')?.addEventListener('click', () => closeMenu(true));
                const submit = async () => {
                    if (confirm.disabled) {
                        return;
                    }
                    confirm.disabled = true;
                    confirm.textContent = busyText;
                    const value = (form.querySelector('input')?.value || '').trim();
                    try {
                        await onConfirm(value);
                    } catch (e) {
                        confirm.disabled = false;
                        confirm.textContent = confirmText;
                        ctx.notice(`操作失败：${e?.message || e}`, 'error');
                    }
                };
                // 同时挂在表单提交和按钮点击上：无论哪种触发方式都不会丢事件
                form.addEventListener('submit', (e) => {
                    e.preventDefault();
                    submit();
                });
                confirm.addEventListener('click', (e) => {
                    e.preventDefault();
                    submit();
                });
                menu.appendChild(form);
                place();
                (form.querySelector('input') || confirm).focus();
            },
        };
        for (const item of items) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('role', 'menuitem');
            btn.innerHTML = `${item.icon || ''}<span>${esc(item.label)}</span>`;
            btn.onclick = () => item.run(ctx);
            menu.appendChild(btn);
        }
        menu.addEventListener('keydown', (e) => {
            const list = [...menu.querySelectorAll('[role=menuitem]')];
            const i = list.indexOf(document.activeElement);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
                list[next]?.focus();
            }
        });
        document.body.appendChild(menu);
        place();
        const outside = (e) => {
            const path = e.composedPath ? e.composedPath() : [e.target];
            if (!path.includes(menu) && !path.includes(anchor)) {
                closeMenu();
            }
        };
        document.addEventListener('mousedown', outside, true);
        menuState = {menu, anchor, outside};
        menu.querySelector('[role=menuitem]')?.focus();
    }

    /** 单元格支持的操作：cherry-pick（未同步/已放弃/已标记）与无需同步标记。 */
    function cellActions({project, branch, change, mark, after}) {
        const items = [{
            label: `Cherry-pick 到 ${branch}`,
            icon: ICON.plus,
            run: (ctx) => ctx.form({
                message: `将变更 <b>${change.number}</b> cherry-pick 到 <code>${esc(branch)}</code>。<br>
                    <span class="bm-hint">Gerrit 会创建一个新变更（保留 Change-Id），仍需评审合入。</span>`,
                confirmText: '创建变更',
                busyText: '正在创建…',
                onConfirm: async () => {
                    let created;
                    try {
                        created = await cherryPick(change.number, branch);
                    } catch (e) {
                        if (!/identical tree/i.test(e.message)) {
                            throw e;
                        }
                        // 目标分支已含相同内容：通常是被其他提交一并带过去了，换了 Change-Id 所以矩阵认不出
                        ctx.form({
                            message: `<b>目标分支已包含这些改动</b>，Gerrit 拒绝创建空的 cherry-pick。<br>
                                <span class="bm-hint">通常是该改动随另一个提交一起合入了 <code>${esc(branch)}</code>，
                                Change-Id 不同，所以矩阵仍显示未同步。可以标记为无需同步。</span>`,
                            confirmText: '标记为无需同步',
                            confirmId: 'mark-identical',
                            onConfirm: () => {
                                const marks = loadMarks();
                                marks[markKey(project, branch, change.changeId)] = {
                                    reason: '目标分支已包含相同改动（identical tree）', at: Date.now()};
                                saveMarks(marks);
                                closeMenu();
                                after();
                            },
                        });
                        return;
                    }
                    const url = changeUrl(project, created.number);
                    ctx.notice(`已在 ${branch} 创建变更 ${created.number}，请继续评审合入。`);
                    ctx.form({
                        message: `已创建变更 <a href="${url}" target="_blank">${created.number}</a>。
                            <br><span class="bm-hint">可在新变更页继续评审；本页数据已刷新。</span>`,
                        confirmText: '知道了',
                        cancelText: '',
                        onConfirm: () => {
                            closeMenu();
                            after();
                        },
                    });
                },
            }),
        }];
        if (mark) {
            items.push({
                label: '取消「无需同步」标记',
                icon: ICON.close,
                run: (ctx) => {
                    const marks = loadMarks();
                    delete marks[markKey(project, branch, change.changeId)];
                    saveMarks(marks);
                    ctx.close();
                    after();
                },
            });
        } else {
            items.push({
                label: '标记为无需同步…',
                icon: ICON.skip,
                run: (ctx) => ctx.form({
                    message: `以后不再提示 <code>${esc(branch)}</code> 同步这个变更。`,
                    input: '原因（可留空）',
                    confirmText: '标记',
                    onConfirm: (reason) => {
                        const marks = loadMarks();
                        marks[markKey(project, branch, change.changeId)] = {reason, at: Date.now()};
                        saveMarks(marks);
                        closeMenu();
                        after();
                    },
                }),
            });
        }
        return items;
    }

    /** 给容器内带 data-cell 的按钮绑定菜单；resolve(el) 返回该单元格的上下文。 */
    function bindCells(container, resolve) {
        container.querySelectorAll('button.bm-cell[data-cell]').forEach((el) => {
            el.onclick = (e) => {
                e.stopPropagation();
                if (menuState?.anchor === el) {
                    closeMenu(true);
                    return;
                }
                openMenu(el, cellActions({...resolve(el)}));
            };
        });
    }

    // ------------------------------------------------------------ 独立矩阵面板

    const legendHtml = () => [STATUS.MERGED, STATUS.NEW, STATUS.NONE, STATUS.ABANDONED, STATUS.MARKED, STATUS.ERROR]
        .map((s) => `<span class="bm-tone-${s.tone}">${s.icon}<span>${s.text}</span></span>`)
        .join('');

    async function renderMatrix(ui, project) {
        const cfg = loadConfig().repos.find((r) => r.project === project);
        if (!cfg) {
            ui.body.innerHTML = '<div class="bm-empty">该仓库未配置</div>';
            return;
        }
        ui.body.innerHTML = '<div class="bm-empty" aria-busy="true">加载中…</div>';
        try {
            const changes = await query(`project:"${project}" branch:"${cfg.mainline}" (status:open OR status:merged)`, cfg.show || 30);
            const ids = changes.map((c) => c.change_id);
            const cols = await Promise.all(cfg.targets.map((t) =>
                targetStatus(project, t.branch, ids).catch((e) => ({__error: e.message}))));
            const marks = loadMarks();
            let html = `<table><thead><tr><th scope="col">#</th><th scope="col">主线变更</th>
                <th scope="col">合入 / 更新时间</th><th scope="col">主线（${esc(cfg.mainline)}）</th>
                ${cfg.targets.map((t) => `<th scope="col">${esc(title(t))}</th>`).join('')}</tr></thead><tbody>`;
            changes.forEach((ch, i) => {
                html += `<tr><td class="bm-num">${i + 1}</td>
                    <td class="bm-subject" title="${esc(`${ch.subject}\n${ch.change_id}`)}">
                        <a href="${changeUrl(project, ch._number)}" target="_blank"
                        ><span class="bm-change-num">${ch._number}</span> ${esc(ch.subject)}</a></td>
                    <td class="bm-time">${esc(localTime(ch.submitted || ch.updated))}</td>
                    <td>${cellHtml(project, {status: ch.status, number: ch._number})}</td>`;
                cfg.targets.forEach((t, j) => {
                    const col = cols[j];
                    html += `<td>${col.__error ? errorCell(col.__error) : cellHtml(project, col[ch.change_id],
                        marks[markKey(project, t.branch, ch.change_id)], `data-cell data-i="${i}" data-j="${j}"`)}</td>`;
                });
                html += '</tr>';
            });
            html += '</tbody></table>';
            ui.body.innerHTML = changes.length ? html : '<div class="bm-empty">主线暂无评审中或已合入变更</div>';
            ui.foot(`${legendHtml()}<span style="flex:1"></span>
                <span>刷新于 ${fmtTime(new Date())} · ${changes.length} 条</span>`);
            bindCells(ui.body, (el) => {
                const ch = changes[+el.dataset.i];
                const branch = cfg.targets[+el.dataset.j].branch;
                return {
                    project,
                    branch,
                    change: {number: ch._number, changeId: ch.change_id},
                    mark: loadMarks()[markKey(project, branch, ch.change_id)],
                    after: () => renderMatrix(ui, project),
                };
            });
        } catch (e) {
            ui.body.innerHTML = `<div class="bm-empty bm-tone-error">加载失败：${esc(e.message)}</div>`;
        }
    }

    function showMatrixPanel(preferProject) {
        const cfg = loadConfig();
        if (!cfg.repos.length) {
            showConfigPanel();
            return;
        }
        const projects = cfg.repos.map((r) => r.project);
        const current = projects.includes(preferProject) ? preferProject : projects[0];
        let select = null;
        const ui = openBox('left:4vw;top:5vh;width:92vw;max-height:90vh', '主线覆盖矩阵', [
            [ICON.refresh, '刷新全部', () => renderMatrix(ui, select.value)],
            [ICON.gear, '配置仓库与分支', () => showConfigPanel(select.value)],
        ], 'matrix');
        select = document.createElement('select');
        select.setAttribute('aria-label', '仓库');
        select.innerHTML = cfg.repos.map((r) => `<option value="${esc(r.project)}"
            ${r.project === current ? 'selected' : ''} title="${esc(r.project)}">${esc(repoName(r))}</option>`).join('');
        select.onchange = () => renderMatrix(ui, select.value);
        ui.head.appendChild(select);
        renderMatrix(ui, current);
    }

    // ------------------------------------------------------------ 配置面板

    const branchCache = new Map();

    function showConfigPanel(preferProject) {
        const cfg = loadConfig();
        const pick = [preferProject, cfg.activeRepo].find((p) => cfg.repos.some((r) => r.project === p));
        let selected = pick || cfg.repos[0]?.project;
        let errors = [];
        let jsonMode = false;
        let adding = false;
        let picker = null;

        const ui = openBox('left:50%;top:6vh;transform:translateX(-50%);width:min(1000px,94vw);height:min(640px,88vh)',
            '覆盖矩阵配置', [[ICON.matrix, '查看矩阵', () => showMatrixPanel(selected)]], 'config');
        ui.body.style.padding = '0';

        const jsonBtn = document.createElement('button');
        jsonBtn.type = 'button';
        jsonBtn.className = 'bm-btn';
        jsonBtn.textContent = '导入/导出';
        jsonBtn.onclick = () => {
            jsonMode = !jsonMode;
            render();
        };
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'bm-btn bm-primary';
        saveBtn.textContent = '保存';
        saveBtn.onclick = () => {
            errors = validate(cfg);
            if (connDraft && !/^https?:\/\/[^/\s]+/i.test(connDraft)) {
                errors.unshift('Gerrit 连接地址需以 http:// 或 https:// 开头');
            }
            if (errors.length) {
                render();
                return;
            }
            cfg.activeRepo = selected;
            saveConnection(connDraft);
            saveConfig(cfg);
            toast('配置已保存');
            showMatrixPanel(selected);
        };
        ui.head.append(jsonBtn, saveBtn);

        let connDraft = loadConnection();
        let connState = null;

        const repo = () => cfg.repos.find((r) => r.project === selected);

        /** 顶部「Gerrit 连接」：填写地址并测试连通性与登录状态。 */
        function connHtml() {
            const detected = detectGerritUrl();
            const effective = (connDraft || detected || '').replace(/\/+$/, '');
            const stateHtml = !connState ? '' : `<span class="bm-tone-${connState.ok ? 'merged' : 'error'}">${
                esc(connState.text)}</span>`;
            return `<div class="bm-conn">
                <div class="bm-row" style="margin:0;align-items:flex-end">
                    <div class="bm-field" style="flex:1 1 420px"><label for="bm-f-conn">Gerrit 连接地址</label>
                        <input id="bm-f-conn" data-act="conn" type="url" value="${esc(connDraft)}"
                            placeholder="${esc(detected || 'https://gerrit.example.com 或 http://192.0.2.10/gerrit')}"></div>
                    ${detected && connDraft !== detected ? `<button type="button" class="bm-btn" data-act="conn-use"
                        title="${esc(detected)}">使用当前站点</button>` : ''}
                    <button type="button" class="bm-btn" data-act="conn-test">测试连接</button>
                </div>
                <div class="bm-hint" style="margin-top:4px">${connDraft ? '' : detected
                    ? `留空则使用当前站点：<code>${esc(detected)}</code>。`
                    : '当前页面不是 Gerrit，请填写 Gerrit 地址。'}
                    ${stateHtml}${effective && !isSameOrigin(effective) ? ' <span class="bm-hint">'
                    + '跨站点访问需先在该 Gerrit 登录，且浏览器允许第三方 Cookie。</span>' : ''}</div>
            </div>`;
        }

        const errorsHtml = () => (errors.length
            ? `<ul class="bm-errors" role="alert">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '');

        function render() {
            jsonBtn.textContent = jsonMode ? '返回编辑' : '导入/导出';
            saveBtn.hidden = jsonMode;
            if (jsonMode) {
                renderJson();
                return;
            }
            ui.body.innerHTML = `${connHtml()}<div class="bm-layout">
                <nav class="bm-side" aria-label="仓库列表">
                    <div class="bm-row" style="justify-content:space-between"><b>仓库</b>
                        <span><button type="button" class="bm-btn" data-act="add-current"
                            title="把当前页面所在的 Gerrit 项目加为仓库">当前项目</button>
                        <button type="button" class="bm-btn" data-act="add-repo">${ICON.plus}新增</button></span></div>
                    ${adding ? `<form class="bm-add" data-act="add-form">
                        <input name="path" placeholder="Gerrit 项目路径（必填）" aria-label="Gerrit 项目路径" required>
                        <input name="name" placeholder="显示名称（可留空，默认取路径末段）" aria-label="显示名称">
                        <div class="bm-row" style="justify-content:flex-end;margin:0">
                            <button type="button" class="bm-btn" data-act="add-cancel">取消</button>
                            <button type="submit" class="bm-btn bm-primary">添加</button></div></form>` : ''}
                    ${cfg.repos.map((r) => `<button type="button" class="bm-repo" data-act="pick"
                        data-project="${esc(r.project)}" aria-current="${r.project === selected}" title="${esc(r.project)}">
                        <b>${esc(repoName(r))}</b>
                        <small>${esc(r.mainline || '未设主线')} · ${r.targets.length} 个目标分支</small></button>`).join('')
                        || '<div class="bm-hint">还没有仓库</div>'}
                </nav>
                <div class="bm-main">${errorsHtml()}${repo() ? repoForm(repo())
                    : `<div class="bm-empty">${cfg.repos.length ? '选择左侧仓库，或新增一个'
                        : '首次使用：确认上方 Gerrit 连接地址，<br>再点左上「新增」填写项目路径，或在变更页点「当前项目」。'}</div>`}</div>
            </div>`;
            wire();
        }

        function repoForm(r) {
            const branches = branchCache.get(r.project);
            const rows = r.targets.map((t, i) => `<div class="bm-row">
                <input data-act="t-branch" data-i="${i}" list="bm-branches" placeholder="目标分支名"
                    aria-label="第 ${i + 1} 个目标分支名" value="${esc(t.branch)}" style="flex:2 1 220px">
                <input data-act="t-note" data-i="${i}" placeholder="备注（列标题显示）"
                    aria-label="第 ${i + 1} 个目标分支备注" value="${esc(t.note || '')}" style="flex:1 1 140px">
                <button type="button" class="bm-icon-btn" data-act="t-del" data-i="${i}"
                    aria-label="删除目标分支 ${esc(t.branch || i + 1)}" title="删除">${ICON.trash}</button>
            </div>`).join('');
            return `<datalist id="bm-branches">${(branches || []).map((b) => `<option value="${esc(b)}">`).join('')}
                </datalist>
                <div class="bm-row" style="align-items:flex-end">
                    <div class="bm-field" style="flex:1 1 180px"><label for="bm-f-name">显示名称</label>
                        <input id="bm-f-name" data-act="name" value="${esc(r.name || '')}"
                            placeholder="${esc(shortName(r.project || ''))}"></div>
                    <div class="bm-field" style="flex:2 1 320px"><label for="bm-f-project">Gerrit 项目路径</label>
                        <input id="bm-f-project" data-act="project" value="${esc(r.project)}"></div>
                    <button type="button" class="bm-btn bm-danger" data-act="del-repo">${ICON.trash}删除仓库</button>
                </div>
                <div class="bm-row" style="align-items:flex-end">
                    <div class="bm-field" style="flex:1 1 240px"><label for="bm-f-main">主线分支</label>
                        <input id="bm-f-main" data-act="mainline" list="bm-branches" value="${esc(r.mainline)}"></div>
                    <div class="bm-field" style="width:110px"><label for="bm-f-show">显示数量</label>
                        <input id="bm-f-show" data-act="show" type="number" min="1" max="200" value="${r.show || 30}"></div>
                    <button type="button" class="bm-btn" data-act="load-branches">${ICON.refresh}载入分支列表</button>
                </div>
                <div class="bm-hint">${branches ? `已从 Gerrit 载入 ${branches.length} 个分支，分支输入框可直接下拉选择。`
                    : '载入分支列表后，分支输入框可下拉选择；也可以直接手填。'}</div>
                <div class="bm-row" style="justify-content:space-between;margin-top:16px">
                    <div class="bm-section" style="margin:0">目标分支</div>
                    <span class="bm-actions"><button type="button" class="bm-btn bm-btn-plain"
                        data-act="add-manual">手动添加</button>
                    <button type="button" class="bm-btn" data-act="add-target"
                        aria-expanded="${!!picker}">${ICON.plus}从分支列表选择</button></span></div>
                ${picker ? pickerHtml(r) : ''}
                ${rows || '<div class="bm-hint">还没有目标分支</div>'}`;
        }

        /** 可选分支：排除主线和已添加的。 */
        const candidates = (r) => {
            const taken = new Set([r.mainline, ...r.targets.map((t) => t.branch)]);
            return (branchCache.get(r.project) || []).filter((b) => !taken.has(b));
        };

        /** 列表为空时说明原因，避免看起来像“点不开”。 */
        function emptyText(r, remaining) {
            const total = (branchCache.get(r.project) || []).length;
            if (picker.filter && remaining.length) {
                return `没有匹配「${esc(picker.filter)}」的分支。请调整筛选词，或用「手动添加」直接输入分支名。`;
            }
            if (!total) {
                return '该项目在 Gerrit 上没有分支。请确认项目路径是否正确，或用「手动添加」直接输入分支名。';
            }
            const others = cfg.repos.filter((x) => x !== r && (branchCache.get(x.project) || []).length)
                .map((x) => repoName(x));
            return `该项目的分支都已添加为「目标分支」或「主线」，没有可再选的分支。<br>
                如需新增，请先在 Gerrit 上创建分支；分支已存在但不在列表里时，可用「手动添加」直接输入。${others.length
                    ? `<br>提示：切换左侧仓库前请先「保存」，否则本次改动会丢失。` : ''}`;
        }

        function pickerHtml(r) {
            if (picker.loading) {
                return '<div class="bm-picker"><div class="bm-hint" aria-busy="true">正在从 Gerrit 载入分支…</div></div>';
            }
            if (picker.error) {
                return `<div class="bm-picker"><div class="bm-tone-error">载入分支失败：${esc(picker.error)}</div>
                    <div class="bm-row" style="margin:8px 0 0"><button type="button" class="bm-btn"
                    data-act="pk-retry">重试</button><button type="button" class="bm-btn" data-act="pk-close">关闭</button>
                    </div></div>`;
            }
            const all = candidates(r);
            const kw = picker.filter.toLowerCase();
            const shown = all.filter((b) => b.toLowerCase().includes(kw));
            const allShownChecked = shown.length > 0 && shown.every((b) => picker.checked.has(b));
            return `<div class="bm-picker" role="group" aria-label="选择目标分支">
                <div class="bm-row" style="margin-bottom:6px">
                    <input data-act="pk-filter" type="search" placeholder="筛选分支，例如 release" aria-label="筛选分支"
                        value="${esc(picker.filter)}" style="flex:1">
                    <label class="bm-check"><input type="checkbox" data-act="pk-all"
                        ${allShownChecked ? 'checked' : ''} ${shown.length ? '' : 'disabled'}>全选可见</label>
                </div>
                <div class="bm-pick-list">${shown.map((b) => `<label class="bm-check">
                    <input type="checkbox" data-act="pk-one" value="${esc(b)}" ${picker.checked.has(b) ? 'checked' : ''}>
                    <span>${esc(b)}</span></label>`).join('') || `<div class="bm-pick-empty">${emptyText(r, all)}</div>`}</div>
                <div class="bm-row" style="justify-content:space-between;margin:8px 0 0">
                    <span class="bm-hint">共 ${all.length} 个可选，已选 ${picker.checked.size} 个</span>
                    <span><button type="button" class="bm-btn" data-act="pk-close">取消</button>
                    <button type="button" class="bm-btn bm-primary" data-act="pk-add"
                        ${picker.checked.size ? '' : 'disabled'}>添加所选（${picker.checked.size}）</button></span>
                </div></div>`;
        }

        function renderJson() {
            ui.body.innerHTML = `<div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px;height:100%">
                <div class="bm-hint">包含仓库配置和「无需同步」标记。可复制备份，或粘贴后点「导入」覆盖本浏览器的数据。</div>
                <textarea aria-label="配置与标记 JSON" spellcheck="false"
                    style="flex:1;min-height:320px;font:12px/1.5 ui-monospace,Consolas,monospace;resize:none"></textarea>
                <div class="bm-row" style="justify-content:flex-end;margin:0">
                    <button type="button" class="bm-btn" data-act="copy">复制</button>
                    <button type="button" class="bm-btn bm-primary" data-act="import">导入</button></div></div>`;
            const area = ui.body.querySelector('textarea');
            area.value = JSON.stringify({config: cfg, marks: loadMarks()}, null, 2);
            ui.body.querySelector('[data-act=copy]').onclick = async () => {
                try {
                    await navigator.clipboard.writeText(area.value);
                    toast('已复制到剪贴板');
                } catch (e) {
                    area.select();
                    toast('无法访问剪贴板，已选中文本，请按 Ctrl+C 复制', 'error');
                }
            };
            ui.body.querySelector('[data-act=import]').onclick = () => {
                try {
                    const parsed = JSON.parse(area.value);
                    const next = normalize(parsed.config || parsed);
                    const problems = validate(next);
                    if (problems.length) {
                        toast(`导入内容有问题：\n${problems.map(esc).join('\n')}`, 'error');
                        return;
                    }
                    saveConfig(next);
                    if (parsed.marks) {
                        saveMarks(parsed.marks);
                    }
                    toast('已导入');
                    showConfigPanel(next.activeRepo);
                } catch (e) {
                    toast(`JSON 格式错误：${esc(e.message)}`, 'error');
                }
            };
            area.focus();
        }

        function wire() {
            const body = ui.body;
            const connInput = body.querySelector('[data-act=conn]');
            connInput?.addEventListener('input', () => {
                connDraft = connInput.value.trim().replace(/\/+$/, '');
                connState = null;
            });
            const useBtn = body.querySelector('[data-act=conn-use]');
            if (useBtn) {
                useBtn.onclick = () => {
                    connDraft = detectGerritUrl() || '';
                    connState = null;
                    render();
                };
            }
            body.querySelector('[data-act=conn-test]').onclick = async (e) => {
                const btn = e.currentTarget;
                const target = (connDraft || detectGerritUrl() || '').replace(/\/+$/, '');
                if (!target) {
                    connState = {ok: false, text: '请先填写地址'};
                    render();
                    return;
                }
                btn.disabled = true;
                btn.textContent = '测试中…';
                connState = await testConnection(target);
                render();
            };
            body.querySelectorAll('[data-act=pick]').forEach((el) => {
                el.onclick = () => {
                    selected = el.dataset.project;
                    picker = null;
                    render();
                };
            });
            body.querySelector('[data-act=add-repo]').onclick = () => {
                adding = !adding;
                render();
                body.querySelector('[data-act=add-form] input')?.focus();
            };
            const addForm = body.querySelector('[data-act=add-form]');
            if (addForm) {
                addForm.onsubmit = (e) => {
                    e.preventDefault();
                    const path = addForm.elements.path.value.trim();
                    const name = addForm.elements.name.value.trim();
                    if (!path) {
                        toast('请填写 Gerrit 项目路径', 'error');
                        return;
                    }
                    if (cfg.repos.some((x) => x.project === path)) {
                        toast('该仓库已存在', 'error');
                        return;
                    }
                    cfg.repos.push({project: path, name, mainline: '', show: 30, targets: []});
                    selected = path;
                    adding = false;
                    picker = null;
                    render();
                };
                addForm.querySelector('[data-act=add-cancel]').onclick = () => {
                    adding = false;
                    render();
                };
            }
            body.querySelector('[data-act=add-current]').onclick = () => {
                const project = currentChange()?.project;
                if (!project) {
                    toast('当前页面不是 Gerrit 变更页，无法识别项目', 'error');
                    return;
                }
                if (!cfg.repos.some((x) => x.project === project)) {
                    cfg.repos.push({project, mainline: '', show: 30, targets: []});
                }
                selected = project;
                render();
            };
            const r = repo();
            if (!r) {
                return;
            }
            const on = (act, handler) => body.querySelector(`[data-act=${act}]`)?.addEventListener('input', handler);
            on('name', (e) => {
                r.name = e.target.value.trim();
                const item = [...body.querySelectorAll('.bm-repo')].find((x) => x.dataset.project === selected);
                if (item) {
                    item.querySelector('b').textContent = repoName(r);
                }
            });
            on('project', (e) => {
                r.project = e.target.value.trim();
                selected = r.project;
                body.querySelector('#bm-f-name').placeholder = shortName(r.project);
            });
            on('mainline', (e) => {
                r.mainline = e.target.value.trim();
            });
            on('show', (e) => {
                r.show = Math.min(Math.max(parseInt(e.target.value, 10) || 30, 1), 200);
            });
            const del = body.querySelector('[data-act=del-repo]');
            del.onclick = () => {
                if (del.dataset.armed !== '1') {
                    del.dataset.armed = '1';
                    del.innerHTML = `${ICON.trash}再点一次确认删除`;
                    setTimeout(() => {
                        if (del.isConnected) {
                            del.dataset.armed = '';
                            del.innerHTML = `${ICON.trash}删除仓库`;
                        }
                    }, 4000);
                    return;
                }
                cfg.repos = cfg.repos.filter((x) => x !== r);
                selected = cfg.repos[0]?.project;
                render();
            };
            body.querySelector('[data-act=load-branches]').onclick = async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                btn.innerHTML = `${ICON.refresh}载入中…`;
                try {
                    branchCache.set(r.project, await fetchBranches(r.project));
                } catch (err) {
                    toast(`载入分支失败：${esc(err.message)}`, 'error');
                }
                render();
            };
            body.querySelector('[data-act=add-manual]').onclick = () => {
                r.targets.push({branch: '', note: ''});
                render();
                const inputs = body.querySelectorAll('[data-act=t-branch]');
                inputs[inputs.length - 1]?.focus();
            };
            body.querySelector('[data-act=add-target]').onclick = () => {
                if (picker) {
                    picker = null;
                    render();
                    return;
                }
                openPicker(r);
            };
            wirePicker(r);
            body.querySelectorAll('[data-act=t-branch]').forEach((el) => {
                el.addEventListener('input', () => {
                    r.targets[+el.dataset.i].branch = el.value.trim();
                });
            });
            body.querySelectorAll('[data-act=t-note]').forEach((el) => {
                el.addEventListener('input', () => {
                    r.targets[+el.dataset.i].note = el.value.trim();
                });
            });
            body.querySelectorAll('[data-act=t-del]').forEach((el) => {
                el.onclick = () => {
                    r.targets.splice(+el.dataset.i, 1);
                    render();
                };
            });
        }

        async function openPicker(r) {
            picker = {filter: '', checked: new Set(), loading: !branchCache.has(r.project), error: null};
            render();
            if (picker.loading) {
                try {
                    branchCache.set(r.project, await fetchBranches(r.project));
                    picker.loading = false;
                } catch (e) {
                    picker.loading = false;
                    picker.error = e.message;
                }
                if (repo() === r && picker) {
                    render();
                }
            }
            ui.body.querySelector('.bm-picker')?.scrollIntoView({block: 'nearest'});
            ui.body.querySelector('[data-act=pk-filter]')?.focus();
        }

        function wirePicker(r) {
            const body = ui.body;
            if (!picker) {
                return;
            }
            body.querySelectorAll('[data-act=pk-close]').forEach((el) => {
                el.onclick = () => {
                    picker = null;
                    render();
                };
            });
            const retry = body.querySelector('[data-act=pk-retry]');
            if (retry) {
                retry.onclick = () => openPicker(r);
            }
            const filter = body.querySelector('[data-act=pk-filter]');
            if (filter) {
                filter.addEventListener('input', () => {
                    picker.filter = filter.value;
                    const pos = filter.selectionStart;
                    render();
                    const again = ui.body.querySelector('[data-act=pk-filter]');
                    again.focus();
                    again.setSelectionRange(pos, pos);
                });
                filter.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                    }
                });
            }
            body.querySelectorAll('[data-act=pk-one]').forEach((el) => {
                el.onchange = () => {
                    if (el.checked) {
                        picker.checked.add(el.value);
                    } else {
                        picker.checked.delete(el.value);
                    }
                    render();
                };
            });
            const all = body.querySelector('[data-act=pk-all]');
            if (all) {
                all.onchange = () => {
                    const kw = picker.filter.toLowerCase();
                    candidates(r).filter((b) => b.toLowerCase().includes(kw)).forEach((b) => {
                        if (all.checked) {
                            picker.checked.add(b);
                        } else {
                            picker.checked.delete(b);
                        }
                    });
                    render();
                };
            }
            body.querySelector('.bm-picker')?.scrollIntoView({block: 'nearest'});
            const add = body.querySelector('[data-act=pk-add]');
            if (add) {
                add.onclick = () => {
                    const chosen = [...picker.checked];
                    chosen.forEach((branch) => r.targets.push({branch, note: ''}));
                    picker = null;
                    render();
                    toast(`已添加 ${chosen.length} 个目标分支，可继续填写备注，记得保存`);
                };
            }
        }

        render();
    }

    // ------------------------------------------------------------ 变更详情页

    /** 去掉部署子路径后的页面路径，用于识别变更页。 */
    function pagePath() {
        const canonical = pageWin().CANONICAL_PATH;
        const prefix = typeof canonical === 'string' ? canonical.replace(/\/+$/, '') : '';
        return prefix && location.pathname.startsWith(prefix)
            ? location.pathname.slice(prefix.length) || '/' : location.pathname;
    }

    function currentChange() {
        const m = pagePath().match(/^\/c\/(.+)\/\+\/(\d+)/);
        return m ? {project: decodeURIComponent(m[1]), number: m[2]} : null;
    }

    /**
     * 读取单个主线变更在各目标分支的状态。
     * 返回 {cfg, ch, results}；不属于已配置仓库或不在主线时返回 {skip: 原因}。
     */
    async function loadChangeStatus(change) {
        const cfg = loadConfig().repos.find((r) => r.project === change.project);
        if (!cfg) {
            return {skip: '该仓库未配置'};
        }
        const [ch] = await query(`change:${change.number}`, 1);
        if (!ch) {
            return {skip: '未查询到该变更'};
        }
        if (ch.branch !== cfg.mainline) {
            return {notMainline: {branch: ch.branch, mainline: cfg.mainline}};
        }
        const results = await Promise.all(cfg.targets.map((t) =>
            targetStatus(change.project, t.branch, [ch.change_id])
                .then((st) => ({info: st[ch.change_id]}), (e) => ({error: e.message}))));
        return {cfg, ch, results};
    }

    /** 渲染「目标分支 → 状态」列表并绑定单元格菜单，row(t, cell) 决定每行的外层结构。 */
    function renderStatusRows(container, change, data, row, after) {
        const {cfg, ch, results} = data;
        const marks = loadMarks();
        container.innerHTML = cfg.targets.map((t, i) => row(t, results[i].error ? errorCell(results[i].error)
            : cellHtml(change.project, results[i].info, marks[markKey(change.project, t.branch, ch.change_id)],
                `data-cell data-j="${i}"`))).join('') || '<div class="bm-hint">该仓库还没有配置目标分支</div>';
        bindCells(container, (el) => {
            const branch = cfg.targets[+el.dataset.j].branch;
            return {
                project: change.project,
                branch,
                change: {number: change.number, changeId: ch.change_id},
                mark: loadMarks()[markKey(change.project, branch, ch.change_id)],
                after,
            };
        });
    }

    // ------------------------------------------------------------ 嵌入变更页右栏

    /** 嵌入区块的样式：沿用 Gerrit 自身的 CSS 变量，看起来与 Relation chain / Cherry picks 一致。 */
    const EMBED_STYLE = `
        :host{display:block;width:min(420px,32vw);min-width:300px;max-width:100%}
        .bm-embed{margin-bottom:var(--spacing-l,12px);font:inherit;color:var(--primary-text-color,inherit)}
        .bm-embed-head{display:flex;align-items:flex-end;gap:4px;margin-bottom:var(--spacing-s,4px)}
        .bm-embed-head h3{margin:0;flex:1;color:var(--deemphasized-text-color,#5f6368);
            font-family:var(--header-font-family,inherit);font-size:var(--font-size-h3,1.143rem);
            font-weight:var(--font-weight-h3,400);line-height:var(--line-height-h3,1.714rem)}
        .bm-embed-head .bm-icon-btn{width:26px;height:26px}
        .bm-line{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px;
            padding:2px var(--spacing-m,8px) 2px 20px;background:var(--background-color-primary,#fff);
            border:1px solid var(--border-color,#ddd);border-bottom:none}
        .bm-line:first-child{border-top-left-radius:var(--border-radius,4px);
            border-top-right-radius:var(--border-radius,4px)}
        .bm-line:last-child{border-bottom:1px solid var(--border-color,#ddd);
            border-bottom-left-radius:var(--border-radius,4px);border-bottom-right-radius:var(--border-radius,4px)}
        .bm-line .bm-branch{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
        .bm-line .bm-cell{padding:0 6px;flex:none}
        .bm-embed .bm-hint{padding:4px 0}
        .bm-note{padding:6px var(--spacing-m,8px);color:var(--deemphasized-text-color,#5f6368);
            background:var(--background-color-secondary,#f6f8fa);border:1px solid var(--border-color,#ddd);
            border-radius:var(--border-radius,4px)}
        .bm-note code{font-family:var(--monospace-font-family,monospace);color:var(--primary-text-color,inherit)}
    `;

    /** 嵌入状态：key 为当前变更，host 为挂载的宿主元素。 */
    const embed = {key: null, host: null, loading: false};

    /** 沿 Gerrit 的 Shadow DOM 找到右栏「相关变更」容器（Cherry picks 所在处）。 */
    function findRelatedColumn() {
        const view = document.querySelector('gr-app')?.shadowRoot
            ?.querySelector('gr-app-element')?.shadowRoot
            ?.querySelector('gr-change-view')?.shadowRoot;
        return view?.querySelector('.relatedChanges') || null;
    }

    function unmountEmbed() {
        embed.host?.remove();
        embed.host = null;
        embed.key = null;
    }

    async function mountEmbed(change) {
        const column = findRelatedColumn();
        if (!column || embed.loading) {
            return;
        }
        embed.loading = true;
        let data;
        try {
            data = await loadChangeStatus(change);
        } catch (e) {
            data = {error: e.message};
        } finally {
            embed.loading = false;
        }
        // 未配置仓库不显示；非主线变更显示提示；加载期间用户已离开该变更则放弃
        if (data.skip || currentChange()?.number !== change.number) {
            embed.key = data.skip ? `${change.project}|${change.number}` : null;
            return;
        }
        const host = document.createElement('div');
        host.className = 'bm-embed-host';
        const shadow = host.attachShadow({mode: 'open'});
        shadow.innerHTML = `<style>${STYLE}${EMBED_STYLE}</style><section class="bm-embed bm-root"
            aria-label="目标分支同步"><div class="bm-embed-head"><h3>目标分支同步</h3></div>
            <div class="bm-lines" role="list"></div></section>`;
        const root = shadow.querySelector('.bm-embed');
        root.dataset.theme = hostTheme();
        const head = shadow.querySelector('.bm-embed-head');
        const lines = shadow.querySelector('.bm-lines');
        const render = async (refetch) => {
            if (refetch) {
                lines.innerHTML = '<div class="bm-hint" aria-busy="true">加载中…</div>';
                try {
                    data = await loadChangeStatus(change);
                } catch (e) {
                    data = {error: e.message};
                }
            }
            root.dataset.theme = hostTheme();
            if (data.error) {
                lines.innerHTML = `<div class="bm-hint bm-tone-error">加载失败：${esc(data.error)}</div>`;
                return;
            }
            if (data.notMainline) {
                const {branch, mainline} = data.notMainline;
                lines.innerHTML = `<div class="bm-note" role="note">当前变更位于 <code>${esc(branch)}</code>，
                    不是主线 <code>${esc(mainline)}</code>，无需检查目标分支同步。</div>`;
                return;
            }
            renderStatusRows(lines, change, data, (t, cell) => `<div class="bm-line" role="listitem">
                <span class="bm-branch" title="${esc(t.branch)}">${esc(title(t))}</span>${cell}</div>`,
            () => render(true));
        };
        head.append(iconButton(ICON.refresh, '刷新同步状态', () => render(true)),
            iconButton(ICON.matrix, '打开覆盖矩阵', () => showMatrixPanel(change.project)));
        column.appendChild(host);
        embed.host = host;
        embed.key = `${change.project}|${change.number}`;
        render(false);
    }

    /** 周期检查：换了变更就重建；Gerrit 重绘把区块挤掉了就原样放回。 */
    function syncEmbed() {
        const change = currentChange();
        const key = change ? `${change.project}|${change.number}` : null;
        if (key !== embed.key) {
            unmountEmbed();
            if (change) {
                mountEmbed(change);
            }
            return;
        }
        if (embed.host && !embed.host.isConnected) {
            findRelatedColumn()?.appendChild(embed.host);
        }
    }

    // ------------------------------------------------------------ 入口

    function init() {
        const style = document.createElement('style');
        style.textContent = STYLE;
        document.head.appendChild(style);

        const fab = themed(document.createElement('button'));
        fab.id = 'bm-fab';
        fab.type = 'button';
        fab.innerHTML = ICON.matrix;
        fab.title = '主线覆盖矩阵（拖动可移动，双击复位）';
        fab.setAttribute('aria-label', '主线覆盖矩阵');
        Object.assign(fab.style, clampStyle(loadFabPos()));
        /** 同步图标的展开状态，让界面表现和辅助技术读出一致。 */
        const syncFabState = () => {
            const open = isBoxOpen();
            fab.setAttribute('aria-expanded', String(open));
            fab.title = `${open ? '关闭' : '打开'}主线覆盖矩阵（拖动可移动，双击复位）`;
        };
        onBoxChange = syncFabState;
        // 图标是开关：任一面板已打开就关闭，否则打开矩阵
        makeDraggable(fab, () => {
            if (isBoxOpen()) {
                closeBox();
                return;
            }
            fab.dataset.theme = hostTheme();
            showMatrixPanel(currentChange()?.project);
        });
        syncFabState();
        fab.addEventListener('dblclick', () => {
            saveFabPos({x: window.innerWidth - FAB_SIZE - FAB_MARGIN, y: window.innerHeight - FAB_SIZE - FAB_MARGIN});
            const pos = loadFabPos();
            Object.assign(fab.style, clampStyle(pos));
            toast('已复位到右下角');
        });
        window.addEventListener('resize', () => {
            const pos = clampFabPos({x: fab.offsetLeft, y: fab.offsetTop});
            Object.assign(fab.style, clampStyle(pos));
            saveFabPos(pos);
        });
        document.body.appendChild(fab);

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') {
                return;
            }
            if (menuState) {
                closeMenu(true);
            } else if (document.getElementById('bm-box')) {
                closeBox();
                fab.focus();
            }
        });

        // Gerrit 是单页应用：按 URL 变化在右栏挂载或替换同步区块
        setInterval(syncEmbed, 1000);
    }

    /** 当前页面是否属于已配置的 Gerrit 站点。 */
    const onConfiguredSite = () => {
        const conn = loadConnection();
        if (!conn) {
            return false;
        }
        try {
            const u = new URL(conn);
            const path = u.pathname.replace(/\/+$/, '');
            return u.origin === location.origin
                && (location.pathname === path || location.pathname.startsWith(path + '/'));
        } catch (e) {
            return false;
        }
    };

    /** 保存地址后，只允许配置的站点与部署路径显示界面。 */
    const shouldDisplay = () => loadConnection() ? onConfiguredSite() : isGerritPage();

    let started = false;

    /** 统一限制自动启动和菜单启动，其他页面不加载界面。 */
    function ensureStarted() {
        if (!shouldDisplay()) {
            return false;
        }
        if (!started) {
            started = true;
            init();
        }
        return true;
    }

    /** Tampermonkey 扩展菜单：安装后可直接在扩展图标里设置 Gerrit 地址。 */
    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') {
            return;
        }
        const conn = loadConnection();
        GM_registerMenuCommand(`设置 Gerrit 地址${conn ? `（当前：${conn}）` : ''}`, () => {
            const detected = detectGerritUrl();
            const input = window.prompt('Gerrit 地址（含子路径，例如 https://gerrit.example.com 或 http://192.0.2.10/gerrit）',
                conn || detected || 'https://');
            if (input === null) {
                return;
            }
            const url = input.trim().replace(/\/+$/, '');
            if (url && !/^https?:\/\/[^/\s]+/i.test(url)) {
                window.alert('地址需以 http:// 或 https:// 开头');
                return;
            }
            saveConnection(url);
            if (!url) {
                window.alert('已清除 Gerrit 地址，将自动识别当前页面。');
                return;
            }
            if (shouldDisplay()) {
                ensureStarted();
                toast(`Gerrit 地址已设置为 ${esc(url)}`);
            } else if (window.confirm(`已保存：${url}\n\n是否打开该 Gerrit 继续配置仓库？`)) {
                (typeof GM_openInTab === 'function' ? GM_openInTab : window.open)(url, {active: true});
            }
        });
        GM_registerMenuCommand('打开主线覆盖矩阵', () => {
            if (!ensureStarted()) {
                window.alert('请先打开配置的 Gerrit 地址，再使用矩阵。');
                return;
            }
            if (!isBoxOpen()) {
                showMatrixPanel(currentChange()?.project);
            }
        });
        GM_registerMenuCommand('配置仓库与分支', () => {
            if (!ensureStarted()) {
                window.alert('请先打开配置的 Gerrit 地址，再配置仓库。');
                return;
            }
            showConfigPanel();
        });
    }

    // 正常情况下 @run-at document-idle 时 body 已就绪；若脚本被提前注入，等 DOM 准备好再初始化。
    // 扩展菜单在所有页面可用；页面界面只在 Gerrit 页面（或已配置的 Gerrit 站点）加载。
    const start = () => {
        if (window.top !== window.self) {
            return;
        }
        registerMenu();
        if (shouldDisplay()) {
            ensureStarted();
        }
    };
    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start, {once: true});
    }
})();
