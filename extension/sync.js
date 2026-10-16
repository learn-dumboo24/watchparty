// WatchTogether: sync.js
// Content script that runs on every page. Two jobs:
//   1. On the call page: read the room and remember it (chrome.storage).
//   2. On a video page: after you click "Sync this tab", keep play/pause/seek in sync.

(() => {
  if (window.__watchTogether) return; // never run twice in the same frame
  window.__watchTogether = true;

  const IS_NETFLIX = /(^|\.)netflix\.com$/.test(location.hostname);
  const IS_YOUTUBE = /(^|\.)youtube\.com$/.test(location.hostname);
  const MIN_VIDEO_AREA = 100000;   // ignore previews smaller than about 420x240
  const SEEK_THRESHOLD = 0.5;      // seconds apart before we bother seeking
  const DRIFT_THRESHOLD = 1;       // seconds behind (while playing) before catching up
  const EVENTS = ['play', 'pause', 'seeked'];

  let cfg = null;                  // { server, room, user } from the call page
  let active = readActive();       // did you click "Sync this tab" in this tab?
  let ws = null, joined = false, everJoined = false, retryTimer = null;
  let video = null;
  let applyingRemote = false, noteTimer = null;   // the "note" that stops echoes
  let partner = { online: false, sync: 0 };
  let needsClick = false, full = false;
  let badge = null, flashTimer = null, dimTimer = null;
  let isHub = false;

  // ---------- Small helpers ----------
  function readActive() {
    try { return sessionStorage.getItem('wt-active') === '1'; } catch { return false; }
  }
  function setActive(on) {
    active = on;
    try { on ? sessionStorage.setItem('wt-active', '1') : sessionStorage.removeItem('wt-active'); } catch {}
  }
  function storageGet() {
    return new Promise((resolve) => {
      try { chrome.storage.local.get('wt', (r) => resolve((r && r.wt) || null)); } catch { resolve(null); }
    });
  }
  function storageSet(value) {
    try { chrome.storage.local.set({ wt: value }); } catch {}
  }
  function sameCfg(a, b) {
    return !!a && !!b && a.server === b.server && a.room === b.room && a.user === b.user;
  }

  // Which title is playing. Used to ignore your partner when you're on different
  // episodes. Only Netflix and YouTube have reliable IDs in the URL.
  function contentId() {
    if (IS_NETFLIX) {
      const m = location.pathname.match(/\/watch\/(\d+)/);
      return m ? 'nf:' + m[1] : null;
    }
    if (IS_YOUTUBE) {
      const v = new URLSearchParams(location.search).get('v');
      return v ? 'yt:' + v : null;
    }
    return null;
  }
  function sameContent(msg) {
    const mine = contentId();
    return !msg.id || !mine || msg.id === mine;
  }

  // During YouTube ads, currentTime is the ad's time, so sync pauses itself.
  function isAd() {
    return IS_YOUTUBE && !!document.querySelector('.html5-video-player.ad-showing');
  }

  // ---------- 1. The call page ("hub") ----------
  function hubCheck() {
    if (!/^\/r\/[a-z0-9]+\/?$/.test(location.pathname)) return false;
    const hub = document.getElementById('wt-hub');
    if (!hub || !hub.dataset.room) return false;
    hub.dataset.extension = 'ready'; // lets the call page show "Extension: detected"
    const next = { server: hub.dataset.server, room: hub.dataset.room, user: hub.dataset.user };
    if (!sameCfg(cfg, next)) {
      cfg = next;
      storageSet(next);
    }
    return true;
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.wt) return;
      const next = changes.wt.newValue || null;
      const changed = !sameCfg(cfg, next);
      cfg = next;
      if (changed && active && !isHub) connect(); // new room: switch to it
      updateStatus();
    });
  } catch {}

  // ---------- 2. Find the main video ----------
  function findVideo() {
    let best = null, bestArea = MIN_VIDEO_AREA;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  function attach(v) {
    if (video) EVENTS.forEach((ev) => video.removeEventListener(ev, onLocalEvent));
    video = v;
    EVENTS.forEach((ev) => video.addEventListener(ev, onLocalEvent));
    showBadge();
  }

  // ---------- 3. Reporter: tell partner what YOU did ----------
  function onLocalEvent(e) {
    if (applyingRemote || !active || isAd()) return; // note is ON: this was the Obeyer
    if (e.type === 'play') needsClick = false;
    send({ type: e.type === 'seeked' ? 'seek' : e.type, t: video.currentTime });
  }

  // ---------- 4. Obeyer: do what PARTNER did ----------
  function seekTo(t) {
    if (IS_NETFLIX) {
      document.dispatchEvent(new CustomEvent('wt-netflix', { detail: JSON.stringify({ action: 'seek', t }) }));
    } else {
      video.currentTime = t;
    }
  }

  function noteOn() {
    applyingRemote = true;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (applyingRemote = false), 500);
  }

  function applyRemote(msg) {
    if (!video || isAd()) return;
    if (!sameContent(msg)) {
      flash('⚠ Partner is on a different video');
      return;
    }
    noteOn();
    if (typeof msg.t === 'number' && Math.abs(video.currentTime - msg.t) > SEEK_THRESHOLD) seekTo(msg.t);
    if (msg.type === 'play' && video.paused) {
      video.play().then(() => {
        needsClick = false;
        updateStatus();
      }).catch(() => {
        needsClick = true; // browser blocked autoplay: one click on the badge fixes it
        updateStatus();
      });
    }
    if (msg.type === 'pause' && !video.paused) video.pause();
    flash({ play: '▶ Partner pressed play', pause: '⏸ Partner paused', seek: '⏩ Partner jumped' }[msg.type]);
  }

  // Drift fix: every 5s the playing side shares its time. Only the side that is
  // BEHIND catches up, so the two never fight each other.
  function onTick(msg) {
    if (!video || video.paused || video.seeking || video.readyState < 3 || isAd() || !sameContent(msg)) return;
    if (msg.t - video.currentTime > DRIFT_THRESHOLD) {
      noteOn();
      seekTo(msg.t + 0.2);
    }
  }

  setInterval(() => {
    if (active && joined && video && !video.paused && !isAd()) send({ type: 'tick', t: video.currentTime });
  }, 5000);

  function sendState() {
    if (!video || isAd()) return;
    send({ type: video.paused ? 'pause' : 'play', t: video.currentTime });
  }

  // ---------- 5. Server connection ----------
  function send(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (msg.type !== 'join') msg.id = contentId();
    ws.send(JSON.stringify(msg));
  }

  function connect() {
    disconnect();
    if (!active || !cfg) return updateStatus();
    const sock = new WebSocket(cfg.server);
    ws = sock;
    updateStatus();

    sock.onopen = () => send({ type: 'join', room: cfg.room, user: cfg.user, role: 'sync' });
    sock.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.type) {
        case 'joined':
          joined = everJoined = true;
          break;
        case 'presence':
          partner = msg.partner;
          break;
        case 'peer-joined':      // partner just synced a tab: bring them to where we are
          sendState();
          break;
        case 'full':
          full = true;
          setActive(false);
          disconnect();
          break;
        case 'play':
        case 'pause':
        case 'seek':
          applyRemote(msg);
          break;
        case 'tick':
          onTick(msg);
          break;
      }
      updateStatus();
    };
    sock.onclose = () => {
      if (ws !== sock) return;  // an old socket we already replaced
      ws = null;
      joined = false;
      if (active) retryTimer = setTimeout(connect, 3000);
      updateStatus();
    };
  }

  function disconnect() {
    clearTimeout(retryTimer);
    if (ws) {
      const old = ws;
      ws = null;
      old.onclose = null;
      old.close();
    }
    joined = false;
  }

  // Keeps a free Render server awake when nobody touches the video for a while.
  setInterval(() => send({ type: 'ping' }), 4 * 60 * 1000);

  // ---------- 6. The floating button ----------
  function showBadge() {
    if (badge) return;
    badge = document.createElement('div');
    Object.assign(badge.style, {
      position: 'fixed', right: '16px', top: '30%', zIndex: '2147483647',
      padding: '8px 14px', borderRadius: '999px', background: 'rgba(18,19,24,.9)',
      color: '#fff', font: '600 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif',
      cursor: 'pointer', userSelect: 'none', boxShadow: '0 4px 16px rgba(0,0,0,.35)',
      border: '1px solid rgba(255,255,255,.15)', transition: 'opacity .3s', opacity: '1',
    });
    // Stop clicks reaching the site (Netflix would treat them as play/pause).
    for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'dblclick']) {
      badge.addEventListener(ev, (e) => e.stopPropagation());
    }
    badge.addEventListener('click', onBadgeClick);
    badge.addEventListener('mouseenter', () => { clearTimeout(dimTimer); badge.style.opacity = '1'; });
    badge.addEventListener('mouseleave', scheduleDim);
    document.addEventListener('fullscreenchange', mountBadge);
    mountBadge();
    updateStatus();
  }

  // In fullscreen only the fullscreen element is visible, so move the badge inside it.
  function mountBadge() {
    if (!badge) return;
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : (document.body || document.documentElement);
    if (badge.parentNode !== parent) parent.appendChild(badge);
  }

  function computeStatus() {
    if (needsClick) return 'needs-click';
    if (full) return 'full';
    if (!active) return 'idle';
    if (!joined) return everJoined ? 'offline' : 'connecting';
    if (!partner.online) return 'waiting';
    if (!partner.sync) return 'partner-no-tab';
    return 'synced';
  }

  const LABELS = {
    'idle': '👥 Sync this tab',
    'connecting': '🔄 Connecting…',
    'offline': '🔌 Reconnecting…',
    'waiting': '⏳ Waiting for partner',
    'partner-no-tab': "⏳ Partner hasn't synced their tab",
    'synced': '💚 Synced',
    'full': '⛔ Room is full',
    'needs-click': '▶ Partner pressed play: click here',
  };

  function updateStatus() {
    if (!badge || flashTimer) return;
    const s = computeStatus();
    badge.textContent = LABELS[s];
    if (s === 'synced' || s === 'idle') scheduleDim();
    else { clearTimeout(dimTimer); badge.style.opacity = '1'; }
  }

  function scheduleDim() {
    clearTimeout(dimTimer);
    dimTimer = setTimeout(() => { if (badge) badge.style.opacity = '0.4'; }, 3000);
  }

  function flash(text) {
    if (!badge || !text) return;
    clearTimeout(flashTimer);
    badge.textContent = text;
    badge.style.opacity = '1';
    flashTimer = setTimeout(() => { flashTimer = null; updateStatus(); }, 2000);
  }

  function onBadgeClick(e) {
    e.stopPropagation();
    e.preventDefault();

    if (needsClick && video) {
      needsClick = false;
      noteOn();
      video.play().catch(() => {});
      return updateStatus();
    }
    if (!active) {
      if (!cfg) {
        alert('WatchTogether: open your watch party link in Chrome first (the page with the cameras). Then click this button again.');
        return;
      }
      full = false;
      setActive(true);
      connect();
      return;
    }
    if (confirm('Stop syncing this tab?')) {
      setActive(false);
      disconnect();
      updateStatus();
    }
  }

  // ---------- 7. Start ----------
  function loop() {
    if (isHub || hubCheck()) { isHub = true; return; }
    const v = findVideo();
    if (v && v !== video) attach(v); // handles late players and next episode
  }

  storageGet().then((stored) => {
    if (!cfg) cfg = stored;
    loop();
    if (active && !isHub) connect(); // rejoin automatically after a reload
    setInterval(loop, 1000);
  });
})();
