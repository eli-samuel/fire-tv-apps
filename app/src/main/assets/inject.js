// Injected at document start into every frame (top page and iframes).
(function () {
  if (window.__cjtv) return;
  window.__cjtv = true;

  // Filled in by MainActivity with the wrapped site's domain.
  var SITE = '__SITE_DOMAIN__';
  var host = location.hostname.toLowerCase();
  var firstParty = host === SITE || host.slice(-SITE.length - 1) === '.' + SITE;
  var isTop = window === window.top;

  // Third-party frames (embedded players, ad iframes) never get to open popups.
  if (!firstParty) {
    try { window.open = function () { return null; }; } catch (e) {}
  }

  // --- Strict mode: invisible layers that catch clicks to open ads stop catching clicks ---
  var STRICT = __STRICT__;
  var clearAt = function () {};
  var isOverlay = function () { return false; };
  if (STRICT) {
    var clear = function (c) {
      var m = /rgba\([^)]*,\s*([\d.]+)\)/.exec(c);
      return c === 'transparent' || (m && parseFloat(m[1]) < 0.1);
    };
    // A layer positioned above the page that shows nothing itself: fully see-through, or an empty
    // transparent box (no text, media or controls).
    isOverlay = function (el) {
      if (!el || el === document.body || el === document.documentElement || el.__cjtvOverlay) return false;
      var s = getComputedStyle(el);
      if (s.position !== 'fixed' && s.position !== 'absolute') return false;
      if (!(parseInt(s.zIndex, 10) >= 1000)) return false;
      if (parseFloat(s.opacity) < 0.1) return true;
      if (!clear(s.backgroundColor) || s.backgroundImage !== 'none') return false;
      if ((el.innerText || '').trim()) return false;
      return !el.querySelector('video,iframe,canvas,svg,img,input,select,textarea,button');
    };
    // Lets clicks at (x, y) pass through any overlays there, without removing them from the page.
    // `keep` is the element about to be clicked; it and its ancestors are never touched.
    clearAt = function (x, y, keep) {
      for (var i = 0; i < 6; i++) {
        var hit = null;
        for (var e = document.elementFromPoint(x, y), d = 0; e && d < 5; e = e.parentElement, d++) {
          if (keep && (keep === e || keep.contains(e) || e.contains(keep))) break;
          if (isOverlay(e)) { hit = e; break; }
        }
        if (!hit) return;
        hit.__cjtvOverlay = true;
        hit.style.setProperty('pointer-events', 'none', 'important');
      }
    };
    // Overlays are often added late or re-added, so check a grid of points regularly.
    setInterval(function () {
      if (!document.body) return;
      [0.2, 0.5, 0.8].forEach(function (fx) {
        [0.25, 0.5, 0.75].forEach(function (fy) { clearAt(innerWidth * fx, innerHeight * fy); });
      });
    }, 1500);

    // Stream players refuse to play inside a sandboxed iframe ("remove the sandbox attribute").
    // The app already blocks popups and off-site navigation itself, so the sandbox is dropped.
    var unsandbox = function (f) {
      if (!f.hasAttribute || !f.hasAttribute('sandbox')) return;
      f.removeAttribute('sandbox');
      var src = f.getAttribute('src');
      if (!src || !f.isConnected) return;
      // Sandbox flags are fixed when the frame navigates, so a frame that already started loading
      // is loaded again. Going via about:blank makes it a full load even when the URL has a #hash.
      f.addEventListener('load', function again() {
        try { if (f.contentWindow.location.href !== 'about:blank') return; } catch (e) { return; }
        f.removeEventListener('load', again);
        f.setAttribute('src', src);
      });
      f.setAttribute('src', 'about:blank');
    };
    // Block the ways scripts add a sandbox before the frame loads: setAttribute, the `sandbox`
    // property and its token list (which then belongs to a spare frame that is never shown).
    var setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name) {
      if (this instanceof HTMLIFrameElement && String(name).toLowerCase() === 'sandbox') return;
      return setAttr.apply(this, arguments);
    };
    try {
      var spareList = document.createElement('iframe').sandbox;
      Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {
        configurable: true,
        get: function () { return spareList; },
        set: function () {},
      });
    } catch (e) {}
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        if (r.type === 'attributes') { unsandbox(r.target); return; }
        r.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.tagName === 'IFRAME') unsandbox(n);
          else if (n.querySelectorAll) [].forEach.call(n.querySelectorAll('iframe[sandbox]'), unsandbox);
        });
      });
    }).observe(document.documentElement || document, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['sandbox'],
    });
  }

  // --- Remote control of <video> elements, relayed into cross-origin frames ---
  function pickVideo() {
    var v = document.querySelectorAll('video'), i;
    for (i = 0; i < v.length; i++) if (!v[i].paused) return v[i];
    for (i = 0; i < v.length; i++) if (v[i].readyState > 0) return v[i];
    return null;
  }
  function handle(m) {
    var v = pickVideo();
    if (!v) return;
    var play = function () { var p = v.play(); if (p && p.catch) p.catch(function () {}); };
    switch (m.cjtv) {
      case 'toggle': v.paused ? play() : v.pause(); break;
      case 'play': play(); break;
      case 'pause': v.pause(); break;
      case 'seek': v.currentTime = Math.max(0, v.currentTime + (m.v || 0)); break;
    }
  }
  function forward(m) {
    for (var i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage(m, '*'); } catch (e) {}
    }
  }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m && typeof m === 'object' && m.cjtv && e.source === window.parent && !isTop) {
      handle(m);
      forward(m);
    }
  });

  if (!isTop) return;

  window.__cjtvBroadcast = function (m) { handle(m); forward(m); };

  // Scroll whatever is under the cursor (inner scroll containers, carousels), else the page.
  window.__cjtvScroll = function (fx, fy, dx, dy) {
    if (window.__cjtvCancelScrollRestore) window.__cjtvCancelScrollRestore();
    var px = dx * window.innerWidth, py = dy * window.innerHeight;
    var el = document.elementFromPoint(fx * window.innerWidth, fy * window.innerHeight);
    while (el && el !== document.body && el !== document.documentElement) {
      var s = getComputedStyle(el);
      var canY = py && /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight;
      var canX = px && /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth;
      if (canY || canX) { el.scrollBy(canX ? px : 0, canY ? py : 0); return; }
      el = el.parentElement;
    }
    window.scrollBy(px, py);
  };

  // --- TV-style focus navigation: the D-pad jumps between clickable elements ---
  var SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,video,iframe,' +
    '[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[onclick],' +
    '[tabindex]:not([tabindex="-1"])';
  var current = null, cache = null, dirty = true;

  new MutationObserver(function () { dirty = true; })
    .observe(document.documentElement || document, { childList: true, subtree: true });

  function rect(e) { return e.getBoundingClientRect(); }

  function visible(e) {
    var r = rect(e);
    if (r.width < 6 || r.height < 6) return false;
    var s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0.05 && !isOverlay(e);
  }

  // Clickable elements, including JS-driven cards that only advertise themselves via cursor:pointer.
  function collect() {
    if (!dirty && cache) return cache;
    var list = [].slice.call(document.querySelectorAll(SEL));
    var extra = document.querySelectorAll('div,li,span,img,article,section');
    if (extra.length < 5000) {
      for (var i = 0; i < extra.length; i++) {
        var e = extra[i], p = e.parentElement;
        // Children of known controls cannot be separate focus targets. Avoid resolving thousands
        // of inherited cursor styles in poster grids just to discard those children later.
        if (e.closest(SEL)) continue;
        // cursor is inherited, so only take the outermost element of a pointer subtree.
        if (getComputedStyle(e).cursor === 'pointer' && !(p && getComputedStyle(p).cursor === 'pointer')) list.push(e);
      }
    }
    var all = new Set(list);
    cache = list.filter(function (e) {
      for (var p = e.parentElement; p; p = p.parentElement) if (all.has(p)) return false;
      return true;
    });
    dirty = false;
    return cache;
  }

  function mark(e, restoring) {
    if (current) current.classList.remove('cjtv-focus');
    current = e;
    e.classList.add('cjtv-focus');
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)) {
      try { e.focus({ preventScroll: true }); } catch (x) {}
    }
    if (restoring) return;
    e.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    var r = rect(e);
    if (r.top < innerHeight * 0.12 || r.bottom > innerHeight * 0.88 || r.left < 0 || r.right > innerWidth) {
      e.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
  }

  // Restore the remote highlight without scrolling or triggering hover menus.
  window.__cjtvRestoreFocus = function (saved) {
    var e = document.querySelector(saved.selector);
    if (saved.href && (!e || e.getAttribute('href') !== saved.href)) {
      e = [].slice.call(document.querySelectorAll('a[href]')).filter(function (link) {
        return link.getAttribute('href') === saved.href && visible(link);
      })[0];
    }
    if (e && (e !== current || !e.classList.contains('cjtv-focus')) && visible(e)) mark(e, true);
  };

  function gap(a1, a2, b1, b2) { return b2 < a1 ? a1 - b2 : (b1 > a2 ? b1 - a2 : 0); }

  window.__cjtvNav = function (dir) {
    if (window.__cjtvCancelScrollRestore) window.__cjtvCancelScrollRestore();
    var list = collect().filter(visible), best = null, bestScore = Infinity;
    if (!current || !current.isConnected || !visible(current)) {
      // Nothing selected yet: start with the top-left item on screen.
      list.forEach(function (e) {
        var r = rect(e);
        if (r.bottom < 0 || r.top > innerHeight) return;
        var s = r.top * 2 + r.left;
        if (s < bestScore) { bestScore = s; best = e; }
      });
    } else {
      var r = rect(current);
      list.forEach(function (e) {
        if (e === current || e.contains(current) || current.contains(e)) return;
        var c = rect(e), main, side;
        if (dir === 'down') {
          if (c.top < r.bottom - r.height * 0.25) return;
          main = c.top - r.bottom; side = gap(r.left, r.right, c.left, c.right);
        } else if (dir === 'up') {
          if (c.bottom > r.top + r.height * 0.25) return;
          main = r.top - c.bottom; side = gap(r.left, r.right, c.left, c.right);
        } else if (dir === 'right') {
          if (c.left < r.right - r.width * 0.25) return;
          main = c.left - r.right; side = gap(r.top, r.bottom, c.top, c.bottom);
        } else {
          if (c.right > r.left + r.width * 0.25) return;
          main = r.left - c.right; side = gap(r.top, r.bottom, c.top, c.bottom);
        }
        var s = Math.max(0, main) + side * 4;
        if (s < bestScore) { bestScore = s; best = e; }
      });
    }
    if (best) { mark(best); return 'moved'; }
    // Nothing further that way: scroll so lazy-loaded content can appear.
    if (dir === 'down') window.scrollBy(0, innerHeight * 0.4);
    if (dir === 'up') window.scrollBy(0, -innerHeight * 0.4);
    dirty = true;
    return 'scrolled';
  };

  // Centre of the selected element in CSS pixels, plus viewport width for scaling.
  // In strict mode, overlays covering that point are cleared first so the tap reaches the element.
  window.__cjtvTarget = function () {
    if (window.__cjtvCancelScrollRestore) window.__cjtvCancelScrollRestore();
    if (!current || !current.isConnected) return null;
    var r = rect(current);
    var x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    var y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    clearAt(x, y, current);
    return [x, y, innerWidth];
  };

  // Light cosmetic filtering for common ad containers.
  // Focus style: soft white ring + lift, similar to native TV launchers.
  var css = '.cjtv-focus{outline:2px solid rgba(255,255,255,.85)!important;outline-offset:3px!important;' +
    'border-radius:8px;box-shadow:0 0 0 7px rgba(255,255,255,.14),0 10px 28px rgba(0,0,0,.55)!important;' +
    'filter:brightness(1.12);transition:outline-offset .15s ease,box-shadow .15s ease,filter .15s ease}' + [
    'ins.adsbygoogle', '[id^="google_ads_"]', '[id^="div-gpt-ad"]',
    'iframe[src*="doubleclick.net"]', 'iframe[src*="googlesyndication"]',
    '[id*="ScriptRoot"]', '[class*="popunder"]', '[id*="popunder"]',
    'a[href*="//ad."][target="_blank"] > img'
  ].join(',') + '{display:none!important}';
  function addStyle() {
    var st = document.createElement('style');
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }
  if (document.documentElement) addStyle();
  else document.addEventListener('DOMContentLoaded', addStyle);
})();
