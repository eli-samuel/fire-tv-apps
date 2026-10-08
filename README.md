# Fire TV Apps

Lightweight Android / Fire TV wrappers for websites, with built-in ad and tracker blocking. One codebase builds one app per site:

| App | Site | APK |
|---|---|---|
| **CineJoy TV** | https://cinejoy.pk/ | `cinejoy-tv.apk` |
| **NHL TV** | https://nhlstreams.io/ | `nhl-tv.apk` |

Each app has its own name, icon and app ID, so they install side by side.

## Features

- Full-screen WebView with JavaScript, cookies, localStorage and IndexedDB enabled.
- HTML5 fullscreen video, with DRM (protected media) allowed.
- Fire TV remote support:
  - **D-pad** moves a soft white highlight between clickable items (cards, buttons, menus, search box), like a TV app. **Select** opens the highlighted item. When nothing is left in that direction, the page scrolls so more content can load.
  - Menu > **Navigation: Pointer** switches to an on-screen pointer instead, for controls the highlight can't reach, such as buttons inside an embedded video player.
  - In fullscreen video: **Select** / **Play-Pause** toggles playback, **Left/Right** and **Rewind/Fast-forward** seek 10 s.
  - **Back** exits fullscreen, then goes back in history, restoring the previous page's scroll position and highlighted item. Press it twice on the first page to exit.
  - **CineJoy browsing:** opening a show keeps the browse page loaded during the app session. Back returns to its already-loaded sections, scroll position and highlight, so infinite scrolling can continue.
  - **Menu (≡)** opens options: Home, Reload, navigation mode (focus highlight or pointer), ad blocker on/off, desktop site, site address, update filter lists, clear cache, check for updates, exit.
- Login and session are kept (cookies are flushed to disk), and the app reopens the last page of the site you had open.
- **Site address:** if the site moves to a new domain, enter the new address in Menu > Site address. No new build is needed. **Default** goes back to the built-in address.
- **In-app updates:** on launch, the app checks this repo's latest GitHub release. If there's a newer build, it offers to install it. Menu > Check for updates does the same on demand.

## Ad and popup blocking

- Uses uBlock Origin filters, EasyList, EasyPrivacy and Peter Lowe's list. They're downloaded on first run and refreshed every 3 days. A built-in list covers the time before the first download.
- Blocks requests to ad and tracker domains, while honouring the lists' `@@` exception rules. Requests to the site itself are never blocked.
- Popups are blocked. Only user-clicked links to the site itself open, and they open in the same view. Embedded third-party players can't call `window.open`.
- Adds light cosmetic hiding for common ad containers.

Leaving the site works differently per app:

- **CineJoy TV (normal mode):** redirects that take the whole page away from the site (to ad domains, other sites, or `intent://` / app-store links) are cancelled. Google, Facebook and Apple sign-in are allowed.
- **NHL TV (strict mode):** nothing may leave the site, not even links you click, and turning the ad blocker off doesn't change that. Invisible click-catching layers placed over the page (used to open ads on the first click) are made click-through, and the focus highlight skips them. Embedded players still load inside the page. The `sandbox` attribute is removed from iframes, because some stream players refuse to play in a sandboxed frame ("remove the sandbox attribute"), and the app already blocks what the sandbox would.

## Signing key (one-time setup)

Every build is signed with the same release key, so new versions install over the old ones. The key lives in GitHub Secrets and never in the repo. The build fails until it's set up.

1. On your PC, run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\create-signing-key.ps1
   ```
   It asks for a password and saves the key to `%USERPROFILE%\fire-tv-apps-release.jks`. It also copies the key, as text, to the clipboard.
2. On GitHub, go to the repo > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**, and add:
   - `KEYSTORE_BASE64`: paste from the clipboard.
   - `KEYSTORE_PASSWORD`: the password you chose.
3. Back up the `.jks` file and the password. Without them, future builds can't update the installed apps. Every app would have to be uninstalled and installed again.

Builds signed with the old debug key can't be updated to the new key. Uninstall the old CineJoy TV once before installing the first build signed with the new key.

## Build

The project has no Gradle wrapper, and the SDK isn't needed on your PC.

**Option A: GitHub Actions (no local tools)**
- Every push builds both APKs. On other branches, that only checks that the build works (the APKs are attached to the run as artifacts).
- A push to `main` also publishes both APKs as a GitHub release named `build-N`. That's what the apps' updater installs from.
- The latest APKs are always at:
  - `https://github.com/eli-samuel/fire-tv-apps/releases/latest/download/cinejoy-tv.apk`
  - `https://github.com/eli-samuel/fire-tv-apps/releases/latest/download/nhl-tv.apk`

**Option B: Android Studio**
Open the folder in Android Studio, pick the flavor in Build Variants (`cinejoyRelease` or `nhlRelease`), then choose Build > Build APK(s). If Android Studio asks, let it create the Gradle wrapper. Local builds use the debug key and build number 1, so they can't update a CI-built app.

## Install on Fire TV (no laptop)

1. On the Fire TV, go to Settings > My Fire TV > Developer Options. Enable **Install unknown apps** for **Downloader**. (If Developer Options is hidden, go to Settings > My Fire TV > About and click the device name 7 times.)
2. Install **Downloader** (by AFTVnews) from the Amazon Appstore.
3. In Downloader, enter one of the APK URLs above and install it. Repeat for the other app.
4. Open the app from Your Apps.

After that, updates come through the app itself. On the first update, Fire TV asks you to allow **Install unknown apps** for that app. If it doesn't, turn it on in the same Developer Options screen as for Downloader.

A push to `main` releases both apps together, so both offer an update even if only one of them changed.

## Adding another site

1. In `app/build.gradle.kts`, add a flavor under `productFlavors`. Give it an `applicationId`, `HOME_URL`, `NAV_ALLOWLIST`, `STRICT_NAV` and `APK_NAME`.
2. Add `app/src/<flavor>/res/` with `values/strings.xml` (`app_name`), `values/colors.xml` (`accent`), `mipmap-*/ic_launcher.png` and `drawable-xhdpi/banner.png` (640×360). The banner is also the Fire TV home screen tile: for sideloaded apps, Fire TV ignores `android:banner` and uses the icon, so the manifest's TV entry (`.TvLauncher`) uses the banner as its icon.
3. In `.github/workflows/build.yml`, copy the new APK and add it to the release files.
4. Optional: site-specific tweaks go in `app/src/<flavor>/assets/site.js`, which runs at document start on every page. NHL TV uses it to start in the site's dark theme (the site's own theme toggle still switches back to light, and that choice is kept) and to remove the stream chat. The chat's domain (`chatango.com`) is also blocked through the flavor's `SITE_BLOCKLIST` in `app/build.gradle.kts`, so it never loads.

## Notes

- If a video won't play, open Menu and turn the ad blocker off to check whether blocking is the cause.
- In normal mode, to allow another sign-in or video domain for top-level navigation, add it to the flavor's `NAV_ALLOWLIST` in `app/build.gradle.kts`.
