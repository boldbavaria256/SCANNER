# Document Scanner Android

Android packaging for the LTECH document-scanner prototype.

## What is offline in the installed APK

- OpenCV.js 4.13.0 is packaged inside `assets/` during the build.
- Document detection, perspective correction and enhancement run on the device.
- PDF construction runs on the device.
- Saving uses Android's system "Save As" document picker.
- No server upload is required for scanning or PDF generation.

## Build in Android Studio

1. Open this folder as an Android project.
2. Allow Gradle to sync. Internet is required only for build dependencies and the one-time OpenCV.js vendoring step.
3. Build > Build APK(s).
4. The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`.

The Gradle `vendorOpenCv` task downloads OpenCV.js before `preBuild` if it is not already present. The resulting APK contains the file locally.

## Build with GitHub Actions

Push the project to a GitHub repository. The included workflow `.github/workflows/build-apk.yml` builds the APK and publishes it as an Actions artifact named `document-scanner-apk`.

## Permissions

The only runtime permission requested by the prototype is CAMERA.
