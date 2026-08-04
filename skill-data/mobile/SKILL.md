---
name: mobile
description: Drive Android devices and iOS Simulators with Skeptic. Use for native app snapshots, gestures, input, screenshots, logs, frame evidence, or mobile setup diagnosis.
---

# Skeptic mobile

Start with `skeptic devices --format json`. Choose an explicit device when more
than one is available.

Android uses ADB directly:

```bash
skeptic mobile setup android
skeptic --session app open com.example.app --platform android --device emulator-5554
skeptic --session app snapshot --format json
skeptic --session app click @e1
skeptic --session app snapshot --format json
skeptic mobile swipe 200 700 200 250 --duration 300 --device emulator-5554
skeptic mobile screenshot .skeptic/manual/android.png --device emulator-5554
skeptic mobile screenrecord .skeptic/manual/android.mp4 --duration 10 --device emulator-5554
skeptic mobile gfxinfo com.example.app --device emulator-5554
skeptic mobile logcat .skeptic/manual/logcat.txt --device emulator-5554
skeptic --session app close
```

Non-ASCII Android text requires ADBKeyboard. Skeptic never sends Unicode
through bare `adb input text`.

iOS is Simulator-only and uses AXe for accessibility/HID plus simctl for media:

```bash
skeptic mobile setup ios
skeptic mobile setup ios --install
skeptic --session app open com.example.app --platform ios-sim --device <UDID>
skeptic --session app snapshot --format json
skeptic --session app click @e1
skeptic mobile screenshot .skeptic/manual/ios.png --platform ios-sim --device <UDID>
skeptic mobile screenrecord .skeptic/manual/ios.mp4 --duration 10 --platform ios-sim --device <UDID>
skeptic mobile xctrace .skeptic/manual/ios.trace --duration 10 --device <UDID>
skeptic --session app close
```

`--install` downloads AXe 1.7.1 and verifies the pinned archive hash. AXe text
input is US-ASCII only. Real iOS devices are not supported in 2.0.

Accessibility audit helpers are opt-in because they run project/device code:

```bash
skeptic mobile audit --platform android --apk atf-probe.apk --runner com.example.test/androidx.test.runner.AndroidJUnitRunner --allow-install
skeptic mobile audit --platform ios-sim --project App.xcodeproj --scheme AppUITests --test-target AppUITests/AccessibilityTests --device <UDID>
```

Re-snapshot after screen/activity/window changes. Resolve a ref to its current
center coordinates; never reuse old coordinates after rotation or navigation.
