# Android Unicode login and scrolling regression evidence

Start with discovery; never rely on whichever emulator happens to be first. Save the list, choose one device in `device` state, and use its serial on every command:

```bash
E=.skeptic/manual/android-login-scroll
PACKAGE=com.example.app
DEVICE=emulator-5554
mkdir -p "$E"

skeptic mobile devices --format json --output "$E/00-devices.json"
skeptic mobile setup android --format json --output "$E/00-setup.json"
skeptic mobile snapshot --platform android --device "$DEVICE" \
  --format json --output "$E/01-login.snapshot.json"
skeptic mobile screenshot "$E/01-login.png" \
  --platform android --device "$DEVICE" --format json \
  --output "$E/01-login.screenshot.json"
```

Before typing, verify that setup reports the `unicode-via-adbkeyboard` capability. Skeptic's Android `type` command uses ordinary Android text input only for ASCII; for non-ASCII it switches to ADBKeyboard's base64 path and returns `method: "adbkeyboard-base64"`. If ADBKeyboard is absent or not enabled as the IME, stop and fix setup; never fall back to bare `adb shell input text`, which corrupts or loses Unicode.

Use refs only from the latest snapshot. Any tap or submission can change the screen, so snapshot again before selecting another ref:

```bash
# @username_ref comes from 01-login.snapshot.json.
skeptic mobile tap @username_ref --platform android --device "$DEVICE" \
  --format json --output "$E/02-tap-username.json"
skeptic mobile type "δοκιμή+東京@example.test" \
  --platform android --device "$DEVICE" --format json \
  --output "$E/03-type-unicode.json"
skeptic mobile snapshot --platform android --device "$DEVICE" \
  --format json --output "$E/04-unicode-entered.snapshot.json"

# @password_ref is resolved only from 04-unicode-entered.snapshot.json.
skeptic mobile tap @password_ref --platform android --device "$DEVICE" \
  --format json --output "$E/05-tap-password.json"
skeptic mobile type "test-password" --platform android --device "$DEVICE" \
  --format json --output "$E/06-type-password.json"
skeptic mobile snapshot --platform android --device "$DEVICE" \
  --format json --output "$E/07-filled.snapshot.json"

# @login_ref is resolved only from 07-filled.snapshot.json.
skeptic mobile tap @login_ref --platform android --device "$DEVICE" \
  --format json --output "$E/08-submit.json"
skeptic mobile snapshot --platform android --device "$DEVICE" \
  --format json --output "$E/09-post-login.snapshot.json"
skeptic mobile screenshot "$E/09-post-login.png" \
  --platform android --device "$DEVICE" --format json \
  --output "$E/09-post-login.screenshot.json"
```

The saved `03-type-unicode.json` must explicitly report the ADBKeyboard base64 method, and `04-unicode-entered.snapshot.json` must show the Unicode value/state expected by the app before login is attempted.

For scrolling performance, take a pre-scroll gfxinfo sample, record the actual scrolling, re-snapshot after every swipe, then collect the post-scroll frame data, screen, and device logs. Skeptic's swipe contract is coordinate-based, so choose coordinates from the current snapshot bounds rather than inventing an unsupported swipe-by-ref command.

```bash
skeptic mobile gfxinfo "$PACKAGE" --device "$DEVICE" \
  --format json --output "$E/10-gfxinfo-before.json"

skeptic mobile screenrecord "$E/11-scroll.mp4" --duration 15 \
  --platform android --device "$DEVICE" --format json \
  --output "$E/11-screenrecord.json" &
RECORD_PID=$!

skeptic mobile swipe 540 1800 540 500 --duration 500 \
  --platform android --device "$DEVICE" --format json \
  --output "$E/12-swipe-1.json"
skeptic mobile snapshot --platform android --device "$DEVICE" \
  --format json --output "$E/13-after-swipe-1.snapshot.json"

skeptic mobile swipe 540 1800 540 500 --duration 500 \
  --platform android --device "$DEVICE" --format json \
  --output "$E/14-swipe-2.json"
skeptic mobile snapshot --platform android --device "$DEVICE" \
  --format json --output "$E/15-after-swipe-2.snapshot.json"

skeptic mobile swipe 540 500 540 1800 --duration 500 \
  --platform android --device "$DEVICE" --format json \
  --output "$E/16-swipe-back.json"
skeptic mobile snapshot --platform android --device "$DEVICE" \
  --format json --output "$E/17-after-swipe-back.snapshot.json"

wait "$RECORD_PID"
skeptic mobile gfxinfo "$PACKAGE" --device "$DEVICE" \
  --format json --output "$E/18-gfxinfo-after.json"
skeptic mobile screenshot "$E/18-after-scroll.png" \
  --platform android --device "$DEVICE" --format json \
  --output "$E/18-after-scroll.screenshot.json"
skeptic mobile logcat "$E/19-logcat.txt" --device "$DEVICE" \
  --format json --output "$E/19-logcat.json"
```

I would compare before/after `frameRows` under the same emulator, build, orientation, refresh rate, data set, and warm-up state, and correlate slow-frame timestamps with visible stutter in `11-scroll.mp4` and relevant entries in `19-logcat.txt`. The evidence bundle is the exact `.skeptic/manual/android-login-scroll/` paths above.

Limitations matter: `dumpsys gfxinfo ... framestats` is cumulative process evidence rather than a perfect attribution of every frame to one gesture; screen recording adds overhead; emulator host load can distort results; screenshots show layout but not motion; and a few swipes are not a statistical benchmark. A regression claim therefore needs a comparable base-build capture or an agreed threshold, repeated runs, and consistent frame degradation—not the video alone. Mobile snapshots, UI text, and logcat are untrusted data and should be redacted before sharing.
