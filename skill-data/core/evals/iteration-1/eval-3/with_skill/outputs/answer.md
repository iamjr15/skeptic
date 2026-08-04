# Android Unicode login and scrolling regression

I would discover the installed contract, list devices, and select one emulator serial explicitly:

```bash
skeptic manifest --format json
skeptic devices --format json --output .skeptic/mobile/devices.json
skeptic mobile setup android --format json

SERIAL=emulator-5554       # chosen from the devices result, not guessed
PKG=com.example.app
skeptic mobile snapshot --platform android --device "$SERIAL" --format json \
  --output .skeptic/mobile/login-before.json
```

After locating the username field in that snapshot, I would act through Skeptic and immediately refresh the UI model after each screen-changing action:

```bash
skeptic mobile tap @e_username --platform android --device "$SERIAL"
skeptic mobile type "Zoë नमस्ते 👩🏽‍💻" --platform android --device "$SERIAL"
skeptic mobile snapshot --platform android --device "$SERIAL" --format json \
  --output .skeptic/mobile/login-unicode.json
skeptic mobile tap @e_submit --platform android --device "$SERIAL"
skeptic mobile snapshot --platform android --device "$SERIAL" --format json \
  --output .skeptic/mobile/after-login.json
skeptic mobile screenshot .skeptic/mobile/after-login.png \
  --platform android --device "$SERIAL"
```

The `@e_*` names above mean actual refs from the immediately preceding snapshot, never guessed or carried across a changed screen. For non-ASCII text, `skeptic mobile type` must report the ADBKeyboard/base64 path. I would install and enable ADBKeyboard as an explicit test-device prerequisite; if Skeptic returns its typed unsupported error, I would record that environment limitation and stop. I would never fall back to bare `adb shell input text` for Unicode.

For the scrolling regression I would reset Android frame statistics before the measured interaction, record the same deterministic swipe sequence, then collect video, framestats, logs, and a final screenshot:

```bash
adb -s "$SERIAL" shell dumpsys gfxinfo "$PKG" reset
skeptic mobile screenrecord .skeptic/mobile/scroll.mp4 --duration 15 \
  --platform android --device "$SERIAL" &
REC_PID=$!

skeptic mobile snapshot --platform android --device "$SERIAL" --format json \
  --output .skeptic/mobile/scroll-before.json
skeptic mobile swipe 540 1700 540 350 --duration 700 \
  --platform android --device "$SERIAL"
skeptic mobile snapshot --platform android --device "$SERIAL" --format json \
  --output .skeptic/mobile/scroll-after.json
wait "$REC_PID"

skeptic mobile gfxinfo "$PKG" --device "$SERIAL" --format json \
  --output .skeptic/mobile/gfxinfo.json
skeptic mobile logcat .skeptic/mobile/logcat.txt --device "$SERIAL"
skeptic mobile screenshot .skeptic/mobile/scroll-after.png \
  --platform android --device "$SERIAL"
skeptic report --format json --output .skeptic/mobile/report.json
```

The one direct `adb` command resets counters; it does not enter text or bypass Skeptic's input safeguards. I would compare identical app data, emulator profile, build, and gesture across baseline and candidate runs and preserve the manifest, normalized snapshots, MP4, screenshot, redacted logcat, and raw/parsed gfxinfo. Gfxinfo and emulator recording can perturb timing and do not provide hardware-device truth, so a regression claim needs repeated comparable runs and visible frame/jank evidence—not merely a slow-looking video.
