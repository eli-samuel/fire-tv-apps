// Keep browse positions across full page loads and client-side history navigation.
(function () {
  var site = '__SITE_DOMAIN__', host = location.hostname.toLowerCase();
  if (window !== window.top || (host !== site && host.slice(-site.length - 1) !== '.' + site)) return;
  if (window.__cjtvScrollState) return;
  window.__cjtvScrollState = true;

  var FIELD = '__cjtvScrollEntry', STORE = '__cjtvScrollPositions';
  var push = history.pushState, replace = history.replaceState;
  var positions = {}, scrollers = [], timer = null, saveTimer = null, restoring = false;
  function readPositions() {
    try { positions = JSON.parse(sessionStorage.getItem(STORE)) || positions; } catch (e) {}
  }
  readPositions();

  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
  // Preserve router state. Sites using primitive/array state fall back to a URL key.
  function tagged(state, id) {
    if (state != null && Object.prototype.toString.call(state) !== '[object Object]') return state;
    var copy = {};
    if (state) Object.keys(state).forEach(function (key) { copy[key] = state[key]; });
    copy[FIELD] = id;
    return copy;
  }
  function key() { return history.state && history.state[FIELD] || 'url:' + location.href; }
  try { replace.call(history, tagged(history.state, key().indexOf('url:') === 0 ? newId() : key()), ''); } catch (e) {}
  var entry = key();

  function selector(el) {
    var parts = [];
    while (el && el.nodeType === 1) {
      var index = 1;
      for (var sibling = el.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === el.tagName) index++;
      }
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
      el = el.parentElement;
    }
    return parts.join('>');
  }
  function remember(el) {
    if (!el || el === document || el === document.body || el === document.documentElement) return;
    if (scrollers.indexOf(el) < 0) scrollers.push(el);
  }
  function save() {
    if (restoring) return;
    var focused = document.querySelector('.cjtv-focus');
    scrollers = scrollers.filter(function (el) { return el.isConnected; });
    positions[entry] = {
      x: window.scrollX, y: window.scrollY, time: Date.now(),
      containers: scrollers.map(function (el) { return { selector: selector(el), x: el.scrollLeft, y: el.scrollTop }; }),
      focus: focused ? { selector: selector(focused), href: focused.getAttribute('href') } : null,
    };
    // Bound session storage even when the user browses many shows.
    var keys = Object.keys(positions).sort(function (a, b) { return positions[b].time - positions[a].time; });
    keys.slice(80).forEach(function (k) { delete positions[k]; });
    try { sessionStorage.setItem(STORE, JSON.stringify(positions)); } catch (e) {}
  }
  function capture() {
    // A router may navigate in the same task as a scroll, before its scroll event fires.
    // Scan only at navigation boundaries; regular scrolling uses the tracked containers.
    if (!restoring) {
      [].forEach.call(document.querySelectorAll('*'), function (el) {
        if (el.scrollLeft || el.scrollTop) remember(el);
      });
    }
    save();
  }
  window.__cjtvSaveScroll = capture;
  function stop() {
    clearInterval(timer);
    timer = null;
    restoring = false;
  }
  window.__cjtvCancelScrollRestore = stop;

  function restore() {
    stop();
    clearTimeout(saveTimer);
    var saved = positions[entry];
    if (!saved) return;
    restoring = true;
    var started = Date.now();
    // Reapply briefly while images/cards load or a router resets scroll after rendering.
    // Real remote/touch input cancels this immediately so it cannot fight the user.
    function apply() {
      window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' });
      saved.containers.forEach(function (item) {
        var el = document.querySelector(item.selector);
        if (!el) return;
        remember(el);
        el.scrollLeft = item.x;
        el.scrollTop = item.y;
      });
      if (saved.focus && window.__cjtvRestoreFocus) window.__cjtvRestoreFocus(saved.focus);
      if (Date.now() - started >= 5000) stop();
    }
    apply();
    timer = setInterval(apply, 100);
  }

  // Do not let early load-time scroll events overwrite the saved destination.
  restoring = !!positions[entry];
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  document.addEventListener('scroll', function (event) {
    if (restoring) return;
    remember(event.target);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 100);
  }, true);
  document.addEventListener('click', capture, true);
  ['touchstart', 'pointerdown', 'keydown', 'wheel'].forEach(function (name) {
    document.addEventListener(name, stop, true);
  });
  window.addEventListener('pagehide', capture);
  window.addEventListener('beforeunload', capture);
  window.addEventListener('pageshow', function () {
    // A cached document may have an older copy than pages visited after it.
    readPositions();
    entry = key();
    restore();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restore);
  else restore(); // Fallback for older WebViews that inject after loading.

  history.pushState = function (state, title, url) {
    capture();
    var result = push.call(history, tagged(state, newId()), title, url);
    stop();
    clearTimeout(saveTimer);
    entry = key();
    scrollers = [];
    return result;
  };
  history.replaceState = function (state, title, url) {
    var result = replace.call(history, tagged(state, entry), title, url);
    var next = key();
    if (next !== entry && positions[entry]) positions[next] = positions[entry];
    entry = next;
    return result;
  };
  window.addEventListener('popstate', function () {
    entry = key();
    scrollers = [];
    restore();
  });
})();
