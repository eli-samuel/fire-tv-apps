package com.cinejoytv.app

import android.app.Activity
import android.app.AlertDialog
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.os.SystemClock
import android.text.InputType
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.IOException
import kotlin.concurrent.thread
import kotlin.math.min
import kotlin.math.sign

class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var cursor: CursorView
    private lateinit var prefs: SharedPreferences
    private lateinit var blocker: AdBlocker
    private lateinit var updater: Updater
    private lateinit var injectJs: String
    private var documentStartScript: ScriptHandler? = null

    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    private var cursorEnabled = true
    private var touchDownTime = 0L
    private var lastBackPress = 0L
    private var lastToast = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        prefs = getSharedPreferences("cinejoy", MODE_PRIVATE)
        cursorEnabled = prefs.getBoolean("pointer", false)
        blocker = AdBlocker(this)
        blocker.enabled = prefs.getBoolean("adblock", true)
        blocker.init()
        Site.load(prefs)
        updater = Updater(this)

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        webView = WebView(this)
        cursor = CursorView(this)
        root.addView(webView, MATCH)
        root.addView(cursor, MATCH)
        setContentView(root)
        updateCursorVisibility()

        setupWebView()
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(startUrl())
            updater.check(manual = false)
        }
        webView.requestFocus()
    }

    private fun setupWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = userAgent()
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }
        webView.setBackgroundColor(Color.BLACK)
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true

        installScript()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (!request.isForMainFrame && (blocker.shouldBlock(request.url) || siteBlocked(request.url))) {
                    blocker.emptyResponse()
                } else {
                    null
                }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.isForMainFrame && blockNavigation(request.url)

            @Deprecated("Used on API < 24")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                blockNavigation(Uri.parse(url))

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (documentStartScript == null) view.evaluateJavascript(injectJs, null)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (documentStartScript == null) view.evaluateJavascript(injectJs, null)
                CookieManager.getInstance().flush()
                saveLastUrl()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) { callback.onCustomViewHidden(); return }
                customView = view
                customCallback = callback
                view.setBackgroundColor(Color.BLACK)
                root.addView(view, MATCH)
                cursor.visibility = View.GONE
                enterImmersive()
            }

            override fun onHideCustomView() = hideCustomView()

            // Popups: only user-initiated windows pointing at the site itself are allowed,
            // and they open in the main WebView instead of a new window.
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                if (!isUserGesture) { notifyBlocked("popup"); return false }
                val probe = WebView(this@MainActivity)
                probe.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest) =
                        handlePopup(v, request.url)

                    @Deprecated("Used on API < 24")
                    override fun shouldOverrideUrlLoading(v: WebView, url: String) = handlePopup(v, Uri.parse(url))
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = probe
                resultMsg.sendToTarget()
                return true
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                // Allow DRM-protected playback; deny camera/mic.
                if (PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID in request.resources) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID))
                } else {
                    request.deny()
                }
            }

            // Avoids the grey "play" placeholder some WebViews draw before a video starts.
            override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
        }
    }

    /**
     * (Re)builds inject.js for the current site and registers it to run at document start.
     * A flavor can add site-specific tweaks in src/<flavor>/assets/site.js.
     */
    private fun installScript() {
        val siteJs = try {
            assets.open("site.js").bufferedReader().use { it.readText() }
        } catch (e: IOException) {
            ""
        }
        injectJs = (assets.open("scroll-state.js").bufferedReader().use { it.readText() } + "\n" +
            assets.open("inject.js").bufferedReader().use { it.readText() } + "\n" + siteJs)
            .replace("__SITE_DOMAIN__", Site.domain)
            .replace("__STRICT__", BuildConfig.STRICT_NAV.toString())
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            documentStartScript?.remove()
            documentStartScript = WebViewCompat.addDocumentStartJavaScript(webView, injectJs, setOf("*"))
        }
    }

    private fun siteBlocked(uri: Uri): Boolean {
        val host = uri.host?.lowercase() ?: return false
        return AdBlocker.matches(host, SITE_BLOCKLIST)
    }

    private fun handlePopup(probe: WebView, uri: Uri): Boolean {
        val host = uri.host?.lowercase()
        if (host != null && Site.isFirstParty(host)) webView.loadUrl(uri.toString()) else notifyBlocked("popup")
        probe.post { probe.destroy() }
        return true
    }

    /**
     * Returns true to cancel a top-level navigation (ad redirects, app-store / intent links).
     * In strict mode nothing may leave the site, not even clicked links, and the ad blocker switch
     * doesn't change that.
     */
    private fun blockNavigation(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase()
        if (scheme == "about" || scheme == "data" || scheme == "blob") return false
        if (scheme != "http" && scheme != "https") { notifyBlocked("redirect"); return true }
        val host = uri.host?.lowercase() ?: return true
        if (Site.isFirstParty(host)) return false
        if (BuildConfig.STRICT_NAV) { notifyBlocked("redirect"); return true }
        if (!blocker.enabled) return false
        if (blocker.isBlockedHost(host) || BuildConfig.NAV_ALLOWLIST.none { AdBlocker.matches(host, setOf(it)) }) {
            notifyBlocked("redirect")
            return true
        }
        return false
    }

    private fun notifyBlocked(what: String) {
        val now = SystemClock.uptimeMillis()
        if (now - lastToast < 3000) return
        lastToast = now
        runOnUiThread { Toast.makeText(this, "Blocked $what", Toast.LENGTH_SHORT).show() }
    }

    // ---------------------------------------------------------------- fullscreen

    private fun hideCustomView() {
        val view = customView ?: return
        root.removeView(view)
        customView = null
        customCallback?.onCustomViewHidden()
        customCallback = null
        updateCursorVisibility()
        webView.requestFocus()
    }

    private fun enterImmersive() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }

    // ---------------------------------------------------------------- remote control

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val down = event.action == KeyEvent.ACTION_DOWN
        val first = down && event.repeatCount == 0

        when (event.keyCode) {
            KeyEvent.KEYCODE_MENU -> { if (first) showMenu(); return true }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> { if (first) media("toggle"); return true }
            KeyEvent.KEYCODE_MEDIA_PLAY -> { if (first) media("play"); return true }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> { if (first) media("pause"); return true }
            KeyEvent.KEYCODE_MEDIA_REWIND -> { if (down) media("seek", -10); return true }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { if (down) media("seek", 10); return true }
        }

        if (customView != null) {
            // Fullscreen video: centre = play/pause, left/right = seek.
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                    if (first) media("toggle"); return true
                }
                KeyEvent.KEYCODE_DPAD_LEFT -> { if (down) media("seek", -10); return true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { if (down) media("seek", 10); return true }
            }
            return super.dispatchKeyEvent(event)
        }

        if (cursorEnabled) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> {
                    if (down) moveCursor(event)
                    return true
                }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                    if (first) sendTouch(MotionEvent.ACTION_DOWN, cursor.cx, cursor.cy)
                    else if (event.action == KeyEvent.ACTION_UP) sendTouch(MotionEvent.ACTION_UP, cursor.cx, cursor.cy)
                    return true
                }
            }
        } else {
            // Focus navigation: the D-pad moves a highlight between clickable items.
            val dir = when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> "left"
                KeyEvent.KEYCODE_DPAD_RIGHT -> "right"
                KeyEvent.KEYCODE_DPAD_UP -> "up"
                KeyEvent.KEYCODE_DPAD_DOWN -> "down"
                else -> null
            }
            if (dir != null) {
                if (down) webView.evaluateJavascript("window.__cjtvNav&&__cjtvNav('$dir')", null)
                return true
            }
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                    if (first) clickFocused()
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /** Taps the centre of the highlighted element with a real touch, so it counts as a user gesture. */
    private fun clickFocused() {
        webView.evaluateJavascript("window.__cjtvTarget?__cjtvTarget():null") { result ->
            val parts = result?.trim('[', ']')?.split(',')?.mapNotNull { it.trim().toFloatOrNull() }
            if (parts == null || parts.size != 3 || parts[2] <= 0f) return@evaluateJavascript
            val scale = webView.width / parts[2]
            val x = parts[0] * scale
            val y = parts[1] * scale
            sendTouch(MotionEvent.ACTION_DOWN, x, y)
            sendTouch(MotionEvent.ACTION_UP, x, y)
        }
    }

    private fun moveCursor(event: KeyEvent) {
        val step = resources.displayMetrics.density * 10 * (1 + min(event.repeatCount, 16) * 0.4f)
        var dx = 0f
        var dy = 0f
        when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT -> dx = -step
            KeyEvent.KEYCODE_DPAD_RIGHT -> dx = step
            KeyEvent.KEYCODE_DPAD_UP -> dy = -step
            KeyEvent.KEYCODE_DPAD_DOWN -> dy = step
        }
        val (ox, oy) = cursor.moveBy(dx, dy)
        if (ox != 0f || oy != 0f) {
            val fx = cursor.cx / cursor.width
            val fy = cursor.cy / cursor.height
            webView.evaluateJavascript(
                "window.__cjtvScroll&&__cjtvScroll($fx,$fy,${ox.sign * 0.2f},${oy.sign * 0.2f})", null
            )
        }
    }

    private fun sendTouch(action: Int, x: Float, y: Float) {
        val now = SystemClock.uptimeMillis()
        if (action == MotionEvent.ACTION_DOWN) touchDownTime = now
        val ev = MotionEvent.obtain(touchDownTime, now, action, x, y, 0)
        ev.source = InputDevice.SOURCE_TOUCHSCREEN
        webView.dispatchTouchEvent(ev)
        ev.recycle()
        if (cursorEnabled) cursor.wake()
    }

    private fun media(cmd: String, value: Int = 0) {
        webView.evaluateJavascript("window.__cjtvBroadcast&&__cjtvBroadcast({cjtv:'$cmd',v:$value})", null)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            customView != null -> {
                webView.evaluateJavascript("document.exitFullscreen&&document.exitFullscreen()", null)
                hideCustomView()
            }
            webView.canGoBack() -> {
                // Capture before history changes, including routes within the same document.
                webView.evaluateJavascript("window.__cjtvSaveScroll&&__cjtvSaveScroll()") {
                    webView.goBack()
                }
            }
            SystemClock.uptimeMillis() - lastBackPress < 2000 -> finish()
            else -> {
                lastBackPress = SystemClock.uptimeMillis()
                Toast.makeText(this, "Press back again to exit", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ---------------------------------------------------------------- menu

    private fun showMenu() {
        val onOff = { b: Boolean -> if (b) "On" else "Off" }
        val desktop = prefs.getBoolean("desktop", false)
        val items = arrayOf(
            "Home",
            "Reload",
            "Navigation: ${if (cursorEnabled) "Pointer" else "Focus"}",
            "Ad blocker: ${onOff(blocker.enabled)} (${blocker.ruleCount} domains)",
            "Desktop site: ${onOff(desktop)}",
            "Site address: ${Site.domain}",
            "Update filter lists",
            "Clear cache (keeps login)",
            "Check for updates (build ${BuildConfig.VERSION_CODE})",
            "Exit",
        )
        AlertDialog.Builder(this)
            .setTitle(R.string.app_name)
            .setItems(items) { _, which ->
                when (which) {
                    0 -> webView.loadUrl(Site.home)
                    1 -> webView.reload()
                    2 -> {
                        cursorEnabled = !cursorEnabled
                        prefs.edit().putBoolean("pointer", cursorEnabled).apply()
                        updateCursorVisibility()
                    }
                    3 -> {
                        blocker.enabled = !blocker.enabled
                        prefs.edit().putBoolean("adblock", blocker.enabled).apply()
                        webView.reload()
                    }
                    4 -> {
                        prefs.edit().putBoolean("desktop", !desktop).apply()
                        webView.settings.userAgentString = userAgent()
                        webView.reload()
                    }
                    5 -> editSiteAddress()
                    6 -> {
                        Toast.makeText(this, "Updating filter lists…", Toast.LENGTH_SHORT).show()
                        thread {
                            val ok = blocker.update()
                            runOnUiThread {
                                val msg = if (ok) "Filters updated: ${blocker.ruleCount} domains" else "Update failed"
                                Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
                            }
                        }
                    }
                    7 -> { webView.clearCache(true); webView.reload() }
                    8 -> updater.check(manual = true)
                    9 -> finish()
                }
            }
            .show()
    }

    /** Lets the user point the app at a new address when the site moves domains. */
    private fun editSiteAddress() {
        val input = EditText(this).apply {
            setText(Site.home)
            setSelection(text.length)
            setSingleLine()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        val pad = (20 * resources.displayMetrics.density).toInt()
        val box = FrameLayout(this).apply {
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle("Site address")
            .setMessage("If the site moves to a new address, enter it here.\nDefault: ${BuildConfig.HOME_URL}")
            .setView(box)
            .setPositiveButton("Save") { _, _ -> changeSite(input.text.toString()) }
            .setNeutralButton("Default") { _, _ -> changeSite(BuildConfig.HOME_URL) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun changeSite(address: String) {
        if (!Site.change(prefs, address)) {
            Toast.makeText(this, "Not a valid address", Toast.LENGTH_LONG).show()
            return
        }
        prefs.edit().remove("lastUrl").apply()
        installScript()
        webView.loadUrl(Site.home)
    }

    private fun updateCursorVisibility() {
        cursor.visibility = if (cursorEnabled && customView == null) View.VISIBLE else View.GONE
        if (cursorEnabled) cursor.wake()
    }

    private fun userAgent(): String =
        if (prefs.getBoolean("desktop", false)) DESKTOP_UA
        // Drop the WebView markers so the site serves its normal Chrome experience.
        else WebSettings.getDefaultUserAgent(this).replace("; wv", "").replace(Regex("Version/\\S+ "), "")

    // ---------------------------------------------------------------- state

    private fun startUrl(): String {
        val last = prefs.getString("lastUrl", null) ?: return Site.home
        val host = Uri.parse(last).host?.lowercase() ?: return Site.home
        return if (Site.isFirstParty(host)) last else Site.home
    }

    private fun saveLastUrl() {
        val url = webView.url ?: return
        val host = Uri.parse(url).host?.lowercase() ?: return
        if (Site.isFirstParty(host)) prefs.edit().putString("lastUrl", url).apply()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        saveLastUrl()
        CookieManager.getInstance().flush()
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        root.removeAllViews()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private val SITE_BLOCKLIST = BuildConfig.SITE_BLOCKLIST.toSet()
        private val MATCH = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        private const val DESKTOP_UA =
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    }
}
