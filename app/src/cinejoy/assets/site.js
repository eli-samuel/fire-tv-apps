// Open show details separately so Svelte cannot unmount the infinite-scroll catalog.
(function () {
  var site = '__SITE_DOMAIN__', host = location.hostname.toLowerCase();
  if (window !== window.top || (host !== site && host.slice(-site.length - 1) !== '.' + site)) return;
  if (window.__cjtvKeepCatalog) return;
  window.__cjtvKeepCatalog = true;

  function isShow(path) { return /^\/(movie|series)\/[^/]+\/?$/.test(path); }
  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (isShow(location.pathname) || location.pathname.indexOf('/watch/') === 0) return;
    var link = event.target;
    while (link && link.tagName !== 'A') link = link.parentElement;
    if (!link || !link.href || link.hasAttribute('download')) return;
    var url;
    try { url = new URL(link.href); } catch (e) { return; }
    if (url.origin !== location.origin || !isShow(url.pathname)) return;

    // A real remote/touch click supplies the user gesture required by onCreateWindow.
    // MainActivity keeps the loaded catalog and opens this same-site URL in a second WebView.
    event.preventDefault();
    event.stopImmediatePropagation();
    window.open(url.href, '_blank');
  }, true);
})();
