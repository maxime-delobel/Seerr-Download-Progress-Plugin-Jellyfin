(function () {
    if (window.__seerrProgressLoaded) return;
    window.__seerrProgressLoaded = true;

    var style = document.createElement('style');
    style.textContent =
        /* progress pill */
        '.seerr-pill{display:inline-flex;align-items:center;gap:.5em;margin:.6em 0;padding:.35em .9em;cursor:pointer;' +
        'border-radius:999px;border:1px solid #22a55a;font-weight:600;font-size:.95em;color:#fff;' +
        'background:#2a3140;position:relative;overflow:hidden;z-index:0}' +
        '.seerr-pill .seerr-fill{position:absolute;left:0;top:0;bottom:0;background:#22a55a;z-index:-1;transition:width .6s}' +
        '.seerr-pill .seerr-spin{width:.9em;height:.9em;border:2px solid rgba(255,255,255,.35);' +
        'border-top-color:#fff;border-radius:50%;animation:seerr-rot 1s linear infinite}' +
        '@keyframes seerr-rot{to{transform:rotate(360deg)}}' +
        /* hover menu */
        '.seerr-tip{position:fixed;z-index:100000;width:min(380px,92vw);padding:12px 14px;border-radius:12px;' +
        'background:rgba(24,28,38,.97);border:1px solid #333b4d;color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.55);' +
        'backdrop-filter:blur(8px);text-align:left}' +
        '.seerr-tip .seerr-head{font-size:.75em;letter-spacing:.06em;text-transform:uppercase;opacity:.6;margin-bottom:8px}' +
        '.seerr-tip .seerr-row+.seerr-row{margin-top:12px;padding-top:12px;border-top:1px solid #2a3140}' +
        '.seerr-tip .seerr-name{font-size:.85em;line-height:1.35;word-break:break-all}' +
        '.seerr-tip .seerr-track{height:6px;border-radius:3px;background:#2e3547;margin:7px 0 5px;overflow:hidden}' +
        '.seerr-tip .seerr-bar{height:100%;border-radius:3px;background:#22a55a;transition:width .6s}' +
        '.seerr-tip .seerr-meta{display:flex;justify-content:space-between;font-size:.78em;opacity:.75}' +
        /* requests tab */
        '.seerr-req-wrap{padding:1em 3.3%}' +
        '.seerr-req-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}' +
        '.seerr-card{display:flex;gap:12px;padding:12px;border-radius:12px;background:#1c212b;border:1px solid #2a3140;color:#fff;' +
        'font-family:inherit;font-size:1rem;-webkit-font-smoothing:antialiased}' +
        '.seerr-tab-icon{font-size:1.5em;margin-right:.35em;vertical-align:middle;line-height:1}' +
        '.seerr-card.seerr-click{cursor:pointer}.seerr-card.seerr-click:hover{border-color:#3f485c}' +
        '.seerr-poster{flex:0 0 78px;height:117px;border-radius:8px;background:#2a3140 center/cover no-repeat}' +
        '.seerr-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}' +
        '.seerr-title{font-size:1.05em;font-weight:600;line-height:1.3;letter-spacing:normal;word-break:break-word}' +
        '.seerr-sub{font-size:.8em;opacity:.65}' +
        '.seerr-badge{align-self:flex-start;font-size:.75em;font-weight:600;padding:.2em .7em;border-radius:999px;border:1px solid}' +
        '.seerr-st-pending{color:#f0b429;border-color:#f0b429}' +
        '.seerr-st-approved{color:#5aa9ff;border-color:#5aa9ff}' +
        '.seerr-st-downloading{color:#3ddc84;border-color:#3ddc84}' +
        '.seerr-st-partial{color:#2ec4b6;border-color:#2ec4b6}' +
        '.seerr-st-available{color:#22a55a;border-color:#22a55a;background:rgba(34,165,90,.15)}' +
        '.seerr-st-declined,.seerr-st-failed{color:#ff6b6b;border-color:#ff6b6b}' +
        '.seerr-card .seerr-track{height:6px;border-radius:3px;background:#2e3547;overflow:hidden}' +
        '.seerr-card .seerr-bar{height:100%;border-radius:3px;background:#22a55a;transition:width .6s}' +
        '.seerr-msg{opacity:.7;padding:1.5em 0}';
    document.head.appendChild(style);

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text; // textContent on purpose: names come from outside
        return e;
    }

    function fmtTime(t) {
        var m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)$/.exec(t || '');
        if (!m) return t || '';
        var d = +(m[1] || 0), h = +m[2], mi = +m[3];
        if (d) return d + 'd ' + h + 'h';
        if (h) return h + 'h ' + mi + 'm';
        return Math.max(mi, 1) + 'm';
    }

    /* ================= progress pill on item pages ================= */

    var itemCache = {};
    var currentItems = [];

    function currentItemId() {
        var m = /[?&]id=([0-9a-f]{32}|[0-9a-f-]{36})/i.exec(location.hash);
        return location.hash.indexOf('details') > -1 && m ? m[1] : null;
    }

    function removePill() {
        document.querySelectorAll('.seerr-pill,.seerr-tip').forEach(function (e) { e.remove(); });
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

    async function pillTick() {
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

    /* ================= "My requests" tab =================
       Put <div id="seerr-requests"></div> in a Custom Tab (or any HTML spot).
       The script fills it in whenever it is on screen. */

    var STATES = {
        pending: 'Waiting for approval',
        approved: 'Approved, waiting for download',
        downloading: 'Downloading',
        partial: 'Partially available',
        available: 'Available',
        declined: 'Declined',
        failed: 'Failed'
    };

    var reqData = null;
    var reqAt = 0;
    var reqBusy = false;

    function seasonLabel(list) {
        if (!list || !list.length) return '';
        if (list.length > 2 && list[list.length - 1] - list[0] === list.length - 1) {
            return 'Seasons ' + list[0] + '\u2013' + list[list.length - 1];
        }
        return (list.length === 1 ? 'Season ' : 'Seasons ') + list.join(', ');
    }

    async function openInLibrary(r) {
        var userId = ApiClient.getCurrentUserId();
        var type = r.type === 'tv' ? 'Series' : 'Movie';
        var want = String(r.tmdbId);

        // Only accept an item whose TMDB id really matches, so a filter the server
        // ignores can never open the wrong title.
        function match(items) {
            return (items || []).find(function (i) {
                var p = i.ProviderIds || {};
                return i.Type === type && String(p.Tmdb || p.tmdb || '') === want;
            });
        }

        try {
            var res = await ApiClient.getItems(userId, {
                AnyProviderIdEquals: 'tmdb.' + want,
                IncludeItemTypes: type,
                Recursive: true,
                Fields: 'ProviderIds',
                Limit: 10
            });
            var hit = match(res.Items);
            if (!hit && r.title) {
                res = await ApiClient.getItems(userId, {
                    SearchTerm: r.title,
                    IncludeItemTypes: type,
                    Recursive: true,
                    Fields: 'ProviderIds',
                    Limit: 30
                });
                hit = match(res.Items);
            }
            if (hit) location.hash = '#/details?id=' + hit.Id;
        } catch (e) {
            console.debug('SeerrProgress:', e);
        }
    }

    // Custom Tabs gives the tab no icon, so add one next to the tab title.
    function addTabIcon(box) {
        try {
            var panel = box.closest('[data-index]');
            var idx = panel && panel.getAttribute('data-index');
            if (idx == null) return;
            var btn = document.querySelector('.emby-tab-button[data-index="' + idx + '"]');
            if (!btn || btn.querySelector('.seerr-tab-icon')) return;
            var icon = el('span', 'material-icons seerr-tab-icon', box.getAttribute('data-icon') || 'playlist_add_check');
            icon.setAttribute('aria-hidden', 'true');
            var host = btn.querySelector('.emby-button-foreground') || btn;
            host.insertBefore(icon, host.firstChild);
        } catch (e) {
            console.debug('SeerrProgress:', e);
        }
    }

    function renderRequests(box, data) {
        box.textContent = '';
        var wrap = el('div', 'seerr-req-wrap');
        box.appendChild(wrap);

        if (data === 'error') {
            wrap.appendChild(el('div', 'seerr-msg', 'Could not load your requests right now.'));
            return;
        }
        if (!data.configured) {
            wrap.appendChild(el('div', 'seerr-msg', 'Seerr Progress is not configured yet. Ask the server admin to set the Seerr URL and API key.'));
            return;
        }
        if (!data.linked) {
            wrap.appendChild(el('div', 'seerr-msg', 'Your Jellyfin account is not linked to a Seerr user yet. Log in to Seerr once with your Jellyfin account, then reload.'));
            return;
        }
        if (!data.requests.length) {
            wrap.appendChild(el('div', 'seerr-msg', 'You have no requests yet.'));
            return;
        }

        var grid = el('div', 'seerr-req-grid');
        data.requests.forEach(function (r) {
            var card = el('div', 'seerr-card');
            if (r.state === 'available' || r.state === 'partial' || r.state === 'downloading') {
                card.className += ' seerr-click';
                card.addEventListener('click', function () { openInLibrary(r); });
            }

            var poster = el('div', 'seerr-poster');
            if (r.poster) poster.style.backgroundImage = 'url("https://image.tmdb.org/t/p/w185' + r.poster + '")';
            card.appendChild(poster);

            var body = el('div', 'seerr-body');
            body.appendChild(el('div', 'seerr-title', r.title + (r.year ? ' (' + r.year + ')' : '')));

            var sub = [r.type === 'tv' ? 'Series' : 'Movie'];
            var seasons = seasonLabel(r.seasons);
            if (seasons) sub.push(seasons);
            if (r.is4k) sub.push('4K');
            if (r.requestedAt) sub.push('requested ' + new Date(r.requestedAt).toLocaleDateString());
            body.appendChild(el('div', 'seerr-sub', sub.join(' \u00b7 ')));

            body.appendChild(el('span', 'seerr-badge seerr-st-' + r.state, STATES[r.state] || r.state));

            if (r.state === 'downloading') {
                var pct = r.percent == null ? 0 : Math.max(0, Math.min(100, r.percent));
                var track = el('div', 'seerr-track');
                var bar = el('div', 'seerr-bar');
                bar.style.width = pct + '%';
                track.appendChild(bar);
                body.appendChild(track);
                body.appendChild(el('div', 'seerr-sub',
                    (r.percent == null ? 'Starting' : Math.round(pct) + '%') +
                    (r.timeLeft ? ' \u00b7 ' + fmtTime(r.timeLeft) + ' left' : '')));
            }

            card.appendChild(body);
            grid.appendChild(card);
        });
        wrap.appendChild(grid);
    }

    async function requestsTick() {
        var box = document.getElementById('seerr-requests');
        if (box) addTabIcon(box);
        if (!box || box.offsetParent === null) return; // not on screen
        if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId()) return;

        var fresh = Date.now() - reqAt < 5000;
        if (fresh && reqData) {
            if (!box.firstChild) renderRequests(box, reqData);
            return;
        }
        if (reqBusy) return;
        reqBusy = true;
        try {
            reqData = await ApiClient.getJSON(ApiClient.getUrl('SeerrProgress/Requests'));
            reqAt = Date.now();
            renderRequests(box, reqData);
        } catch (e) {
            console.debug('SeerrProgress:', e);
            if (!box.firstChild) renderRequests(box, 'error');
        } finally {
            reqBusy = false;
        }
    }

    window.addEventListener('hashchange', function () { removePill(); pillTick(); });
    setInterval(pillTick, 5000);
    setInterval(requestsTick, 2000);
    pillTick();
    requestsTick();
})();
