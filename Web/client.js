(function () {
    if (window.__seerrProgressLoaded) return;
    window.__seerrProgressLoaded = true;

    var style = document.createElement('style');
    style.textContent =
        '.seerr-pill{display:inline-flex;align-items:center;gap:.5em;margin:.6em 0;padding:.35em .9em;cursor:pointer;' +
        'border-radius:999px;border:1px solid #22a55a;font-weight:600;font-size:.95em;color:#fff;' +
        'background:#2a3140;position:relative;overflow:hidden;z-index:0}' +
        '.seerr-pill .seerr-fill{position:absolute;left:0;top:0;bottom:0;background:#22a55a;z-index:-1;transition:width .6s}' +
        '.seerr-pill .seerr-spin{width:.9em;height:.9em;border:2px solid rgba(255,255,255,.35);' +
        'border-top-color:#fff;border-radius:50%;animation:seerr-rot 1s linear infinite}' +
        '@keyframes seerr-rot{to{transform:rotate(360deg)}}' +
        '.seerr-tip{position:fixed;z-index:100000;width:min(380px,92vw);padding:12px 14px;border-radius:12px;' +
        'background:rgba(24,28,38,.97);border:1px solid #333b4d;color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.55);' +
        'backdrop-filter:blur(8px);text-align:left}' +
        '.seerr-tip .seerr-head{font-size:.75em;letter-spacing:.06em;text-transform:uppercase;opacity:.6;margin-bottom:8px}' +
        '.seerr-tip .seerr-row+.seerr-row{margin-top:12px;padding-top:12px;border-top:1px solid #2a3140}' +
        '.seerr-tip .seerr-name{font-size:.85em;line-height:1.35;word-break:break-all}' +
        '.seerr-tip .seerr-track{height:6px;border-radius:3px;background:#2e3547;margin:7px 0 5px;overflow:hidden}' +
        '.seerr-tip .seerr-bar{height:100%;border-radius:3px;background:#22a55a;transition:width .6s}' +
        '.seerr-tip .seerr-meta{display:flex;justify-content:space-between;font-size:.78em;opacity:.75}';
    document.head.appendChild(style);

    var itemCache = {};
    var currentItems = [];

    function currentItemId() {
        var m = /[?&]id=([0-9a-f]{32}|[0-9a-f-]{36})/i.exec(location.hash);
        return location.hash.indexOf('details') > -1 && m ? m[1] : null;
    }

    function removePill() {
        document.querySelectorAll('.seerr-pill,.seerr-tip').forEach(function (e) { e.remove(); });
    }

    function fmtTime(t) {
        var m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)$/.exec(t || '');
        if (!m) return t || '';
        var d = +(m[1] || 0), h = +m[2], mi = +m[3];
        if (d) return d + 'd ' + h + 'h';
        if (h) return h + 'h ' + mi + 'm';
        return Math.max(mi, 1) + 'm';
    }

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text; // textContent on purpose: release names are untrusted
        return e;
    }

    function renderTip(tip) {
        tip.textContent = '';
        tip.appendChild(el('div', 'seerr-head', 'Downloading'));
        if (!currentItems.length) {
            tip.appendChild(el('div', 'seerr-name', 'Waiting for download info from Seerr'));
            return;
        }
        currentItems.forEach(function (i) {
            var pct = i.percent == null ? 0 : Math.max(0, Math.min(100, i.percent));
            var row = el('div', 'seerr-row');
            row.appendChild(el('div', 'seerr-name', i.title || 'Unknown'));
            var track = el('div', 'seerr-track');
            var bar = el('div', 'seerr-bar');
            bar.style.width = pct + '%';
            track.appendChild(bar);
            row.appendChild(track);
            var meta = el('div', 'seerr-meta');
            meta.appendChild(el('span', null, (i.percent == null ? '?' : Math.round(pct) + '%') +
                (i.timeLeft ? ' \u00b7 ' + fmtTime(i.timeLeft) + ' left' : '')));
            if (i.count > 1) meta.appendChild(el('span', null, i.count + ' files'));
            row.appendChild(meta);
            tip.appendChild(row);
        });
    }

    function showTip(pill) {
        var tip = document.querySelector('.seerr-tip');
        if (!tip) {
            tip = el('div', 'seerr-tip');
            document.body.appendChild(tip);
        }
        renderTip(tip);
        var r = pill.getBoundingClientRect();
        tip.style.top = (r.bottom + 8) + 'px';
        tip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8)) + 'px';
    }

    function hideTip() {
        var t = document.querySelector('.seerr-tip');
        if (t) t.remove();
    }

    async function getItem(id) {
        if (!itemCache[id]) {
            itemCache[id] = await ApiClient.getItem(ApiClient.getCurrentUserId(), id);
        }
        return itemCache[id];
    }

    async function tick() {
        try {
            if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId()) return;
            var id = currentItemId();
            if (!id) { removePill(); return; }

            var item = await getItem(id);
            var type = item.Type === 'Series' ? 'tv' : item.Type === 'Movie' ? 'movie' : null;
            var tmdb = item.ProviderIds && (item.ProviderIds.Tmdb || item.ProviderIds.tmdb);
            if (!type || !tmdb) { removePill(); return; }

            var list = await ApiClient.getJSON(ApiClient.getUrl('SeerrProgress/Status'));
            var hit = list.find(function (x) { return x.mediaType === type && String(x.tmdbId) === String(tmdb); });
            if (!hit) { removePill(); return; }

            var page = document.querySelector('.itemDetailPage:not(.hide)') || document;
            var host = page.querySelector('.itemMiscInfo-primary') || page.querySelector('.detailPagePrimaryContainer');

            var pill = document.querySelector('.seerr-pill');
            if (!pill) {
                pill = el('div', 'seerr-pill');
                pill.innerHTML = '<span class="seerr-fill"></span><span class="seerr-text"></span><span class="seerr-spin"></span>';
                pill.addEventListener('mouseenter', function () { showTip(pill); });
                pill.addEventListener('mouseleave', hideTip);
                pill.addEventListener('click', function () {
                    if (document.querySelector('.seerr-tip')) hideTip(); else showTip(pill); // touch devices
                });
                if (host) {
                    host.parentNode.insertBefore(pill, host.nextSibling);
                } else {
                    // Jellyfin 12 changed the layout; if the known spots are gone, float it bottom-left.
                    pill.style.cssText = 'position:fixed;left:24px;bottom:24px;z-index:10000';
                    document.body.appendChild(pill);
                }
            }

            currentItems = hit.items || [];
            var tip = document.querySelector('.seerr-tip');
            if (tip) renderTip(tip);

            var pct = hit.percent;
            pill.querySelector('.seerr-fill').style.width = (pct == null ? 0 : pct) + '%';
            pill.querySelector('.seerr-text').textContent =
                pct == null ? 'Processing' : 'Downloading ' + Math.round(pct) + '%';
        } catch (e) {
            console.debug('SeerrProgress:', e);
        }
    }

    window.addEventListener('hashchange', function () { removePill(); tick(); });
    setInterval(tick, 5000);
    tick();
})();
