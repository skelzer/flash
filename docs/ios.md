# Flash on iOS — Mac runbook & App Store checklist

Everything needed to take this repo from a Windows checkout to an app in the App Store.
The `ios/` directory does **not** exist yet: it gets scaffolded on the Mac (step 2) and
committed from there after the first successful build.

Verified against Capacitor **8.5.0** and `@capgo/capacitor-social-login` **8.4.1**
(August 2026).

---

## 1. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| macOS | Recent enough to run Xcode 26 | |
| Xcode | **26.0 or newer** | Hard requirement of Capacitor 8. |
| Xcode Command Line Tools | matching Xcode | `xcode-select --install` |
| Node.js | **22 LTS or newer** | Hard requirement of Capacitor 8. |
| Apple Developer Program | active enrolment ($99/yr) | Needed for Sign in with Apple and for shipping. |
| CocoaPods | **not required** | See below. |

**CocoaPods vs Swift Package Manager.** As of Capacitor 8, `npx cap add ios` scaffolds an
**SPM** project by default; CocoaPods is optional and only used if you explicitly pass
`--packagemanager CocoaPods`. CocoaPods is in maintenance mode and its Specs repo goes
read-only in December 2026, so **use the SPM default**. That means no Homebrew, no
`pod install`, no `gem install cocoapods` on this machine.

Consequence: `App.xcworkspace` does not exist in an SPM project — you open
`ios/App/App.xcodeproj` instead, and Xcode resolves Swift packages on first open (this
takes a few minutes the first time; it is downloading GoogleSignIn, the Facebook SDK and
Alamofire, which `@capgo/capacitor-social-login` declares as dependencies).

iOS deployment target is **15.0** (Capacitor 8's minimum, and also the minimum declared by
the social-login plugin's `Package.swift`).

---

## 2. First-time scaffold

```bash
git clone https://github.com/skelzer/flash.git
cd flash
npm ci

# MUST run before cap add/sync: public/importer.js and
# public/sql-wasm-browser.wasm are gitignored build outputs that a
# fresh clone does not have. cap copies public/ verbatim into the app
# bundle, so missing these means a broken .apkg importer in the binary.
npm run build

npx cap add ios          # SPM by default — do not pass --packagemanager
npx cap sync ios
npx cap open ios         # opens ios/App/App.xcodeproj in Xcode
```

`cap add ios` reads `capacitor.config.json` at the repo root (`appId`
`com.luquematte.flash`, `appName` `Flash`, `webDir` `public`), so the bundle identifier is
correct from the start.

**Commit `ios/` from the Mac** once Xcode builds and runs successfully — not before, so a
broken scaffold never lands on `main`. `.gitignore` already excludes the build artefacts
(`ios/App/Pods/`, `ios/App/build/`, `ios/App/App/public/`, `ios/DerivedData/`, `.DS_Store`).
Note `ios/App/App/public/` is ignored deliberately: it is the copy of `public/` that
`cap sync` regenerates, so it must never be tracked.

---

## 3. Xcode configuration

Open the **App** target → these tabs.

### Signing & Capabilities

1. **Team** — select the Apple Developer team. Leave "Automatically manage signing" on.
2. Confirm **Bundle Identifier** reads `com.luquematte.flash`.
3. **+ Capability → Sign in with Apple.** This creates `ios/App/App/App.entitlements`
   containing `com.apple.developer.applesignin` and registers the capability on the App ID
   in the developer portal. Without it, the native Apple sign-in sheet fails at runtime.
   If the capability is greyed out or missing, complete the *Account &
   Organizational Data Sharing* questionnaire in the Apple Developer portal first — the
   plugin docs call this out explicitly.
4. Commit `App.entitlements` — it is source, not a build artefact.

### Info.plist

Add both of these (right-click `Info.plist` → Open As → Source Code is easiest):

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>com.googleusercontent.apps.YOUR_IOS_CLIENT_ID_SUFFIX</string>
    </array>
  </dict>
</array>

<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```

- The URL scheme is the **reversed** iOS OAuth client ID from step 4 and **must start with
  `com.googleusercontent.apps.`**. The plugin's iOS Google guide requires this; note the
  package README's short summary claims no URL scheme is needed on iOS — that summary is
  wrong, follow the per-platform guide.
- `ITSAppUsesNonExemptEncryption = NO` stops App Store Connect asking about export
  compliance on every single upload. Flash only uses standard HTTPS, which is exempt.

### App icon

`npm run build` generates `public/icon-1024.png` — 1024×1024, PNG colour type 2, i.e. **no
alpha channel**, square, no rounded corners (Apple applies its own mask). Drag it into
`Assets.xcassets` → `AppIcon` → the single 1024pt "App Store" slot in the Xcode 26 single-size
icon set. Xcode derives every other size from it. No manual alpha-stripping needed.

### Social-login plugin — iOS specifics

Verified against the plugin's per-platform iOS guides:

- **Apple**: only the *Sign in with Apple* capability plus `SocialLogin.initialize({ apple:
  { clientId } })`. On iOS the `clientId` value is **not used by the operating system** — the
  plugin only reads it to know the Apple provider should be initialised. The Service ID
  matters for web, not for the native iOS flow.
- **Google**: the Info.plist URL scheme above, plus `SocialLogin.initialize({ google: {
  iOSClientId, iOSServerClientId, mode: 'online' } })`. `iOSServerClientId` (the *web*
  client ID) is only needed for offline/serverAuthCode mode.
- **No AppDelegate edits are required** for either provider.
- The plugin pulls in the Facebook iOS SDK, GoogleSignIn-iOS and Alamofire transitively via
  its `Package.swift`, even though Flash only uses Apple and Google. This is normal and
  those SDKs ship their own privacy manifests; it does not change the App Privacy answers
  in step 7 because Flash never initialises the Facebook provider.

---

## 4. Google Cloud Console — iOS OAuth client

1. Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth
   client ID**.
2. Application type **iOS**. Bundle ID: `com.luquematte.flash`. (App Store ID and Team ID
   are optional; fill them once the app exists in App Store Connect.)
3. Copy both the **client ID** and the **reversed client ID**.

The value then goes in **three** places:

| Where | What |
|---|---|
| `public/app.js` | the `GOOGLE_IOS_CLIENT_ID` constant near the top of the file |
| `wrangler.jsonc` | the `GOOGLE_IOS_CLIENT_ID` var (backend verifies tokens issued to this client) |
| `ios/App/App/Info.plist` | the **reversed** ID as a `CFBundleURLSchemes` entry (step 3) |

After editing `wrangler.jsonc`, deploy from the Windows machine or any wrangler-authenticated
checkout:

```bash
npm run deploy
```

The iOS client ID is not a secret (it ships inside the app binary), so committing it is fine.

---

## 5. Iterating on the web layer

Any change under `public/` or `src/`:

```bash
npm run ios:sync     # = npm run build && cap sync ios
```

then re-run from Xcode (⌘R). `cap sync` copies `public/` into the app bundle and updates the
native plugin list, so it is also what you run after installing or removing a Capacitor
plugin.

`cap copy ios` alone is the faster variant when only web assets changed and no plugin was
added — but `ios:sync` is always safe.

**pod install**: not applicable on the SPM default. If the project were ever converted to
CocoaPods, `cap sync` would run `pod install` automatically after any dependency change; with
SPM the equivalent is Xcode's *File → Packages → Resolve Package Versions*, which is worth
running manually if package resolution looks stale after a plugin upgrade.

---

## 6. Testing matrix

**Works in the simulator:**

- App shell launch, splash screen timing (800 ms), status-bar style
- Safe-area insets — notch/Dynamic Island top, home-indicator bottom
- Keyboard behaviour with `resize: body` (card editor and login fields must not be covered)
- `.apkg` import via the Files picker (drag a test deck into the simulator first)
- Google sign-in
- General navigation, deck CRUD, review flow

**Device-only — must be checked on real hardware:**

- **Apple sign-in.** The plugin docs are explicit: run on a *physical* device to test it.
  Simulator results are not trustworthy here.
- **German TTS.** Install a German voice first: *Settings → Accessibility → Spoken Content →
  Voices → Deutsch*. Verify the app picks a `de-DE` voice and not an English fallback.
- **Haptics.** No-op in the simulator; confirm the review buttons actually feel right.
- **Token persistence across a full reboot.** Confirm the session survives an app kill and a
  device restart (`@capacitor/preferences` → Keychain/UserDefaults), and that an expired or
  revoked token lands the user back on the sign-in screen rather than a blank state.
- Behaviour on a poor or absent connection — study data requires the network.

---

## 7. App Store Connect checklist

### Create the app record

- **Name**: `Flash — German Flashcards`
- **Primary category**: Education
- **Devices**: iPhone only for v1 (set the target's device family to iPhone in Xcode so the
  submission matches)
- **Bundle ID**: `com.luquematte.flash`
- **Age rating**: 4+ (no objectionable content, no user-generated content shared between
  users)

### URLs

- **Privacy Policy URL**: `https://flash.luquematte.com/privacy.html`
- **Support URL**: `https://flash.luquematte.com/support.html`

Both pages are in `public/` and go live with `npm run deploy`. **Deploy before submitting** —
review rejects unreachable URLs.

### App Privacy questionnaire

Data collected, all **linked to the user's identity**, none **used for tracking**:

| Type | Purpose | Linked | Tracking |
|---|---|---|---|
| Email Address (Contact Info) | App Functionality | Yes | No |
| User ID (Identifiers) | App Functionality | Yes | No |
| User Content — flashcards, decks, review history ("Other User Content") | App Functionality | Yes | No |

Answer **No** to: analytics, product personalisation, advertising, third-party advertising,
developer's advertising or marketing, and every "used for tracking" prompt. No analytics SDK
is present in the app.

### Demo account for review

Reviewers cannot use Sign in with Apple against your Apple ID, so a **password account is
mandatory**:

- Create a dedicated account (e.g. `appreview@…`) with a simple password
- Preload it with a starter German deck containing enough cards to demonstrate a review
  session
- Put the credentials in **App Review Information → Sign-In required → demo account**

### Review notes

Suggested text:

> Flash is a spaced-repetition flashcard app for learning German. A network connection is
> required: decks and review scheduling are stored server-side so they sync between the app
> and the web version at https://flash.luquematte.com.
>
> Demo credentials are provided above; the account is preloaded with a starter deck.
>
> Account deletion: sign in, then on the decks screen scroll to the footer and tap "Delete
> account". This immediately and permanently deletes the account and all associated data
> (decks, cards, review history), satisfying guideline 5.1.1(v).
>
> Both Sign in with Apple and Google sign-in use native iOS flows. Sign in with Apple is
> offered alongside Google as required by guideline 4.8.

### Export compliance

`ITSAppUsesNonExemptEncryption = NO` in Info.plist. Flash uses only standard HTTPS, which is
exempt — no CCATS or year-end self-classification report needed.

### Screenshots

App Store Connect only requires the **largest size in each device family** and downscales for
the rest. iPhone-only v1 therefore needs:

- **6.9" iPhone — 1320 × 2868 px (portrait)** — this is the one that matters
- 6.5" (1242 × 2688 or 1284 × 2778) is only required if you do *not* supply 6.9"

Up to 10 per size. Verify the current requirement in App Store Connect at upload time — Apple
adjusts the accepted set when new devices ship.

### Before hitting submit

1. `npm run deploy` — privacy + support pages must be live.
2. `npm run ios:sync`, then Archive in Xcode and upload the build.
3. **TestFlight**: install the uploaded build on a real device and run the full device-only
   matrix from step 6 against production. Do not submit a build you have only run from Xcode.
4. Confirm the demo account still works from a clean install.
5. Submit for review.

---

## Open questions for the Mac phase

- Apple sign-in returns the user's name and email **only on the very first authorisation**
  for a given Apple ID + app pair. Verify the backend persists them on first sight; to re-test
  the first-run path, revoke the app under *Settings → [your name] → Sign-In & Security →
  Sign in with Apple*.
- Whether the transitive Facebook SDK inflates the binary enough to care. If so,
  `@capgo/capacitor-social-login` may expose a build flag to exclude unused providers —
  check its current docs before optimising.
- Splash screen artwork: `capacitor.config.json` sets a flat `#0d0f16` background. If a
  logo-on-launch is wanted, generate the storyboard asset on the Mac.
