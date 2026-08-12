# Scanner Android

Offline Android document scanner designed for fast, crisp phone scanning and multi-page PDF export.

## Product flow

1. **Home** — single-page scan, multi-page scan, gallery import, recent saved scans.
2. **Camera** — rear-camera capture, live document detection, quality/stability feedback, optional auto-capture, torch, single/multi mode.
3. **Crop & Enhance** — draggable crop handles, Original, Bright/Auto Clean, Grayscale and B&W, rotation, retake/continue.
4. **Review Pages** — multi-page selection, delete, rotate, reorder, add page, create PDF.
5. **Save / Export** — rename, save with Android's document picker, share with Android's share sheet.

## Offline imaging pipeline

The installed APK does not require network access. OpenCV.js is downloaded only at build time and is packaged into the APK.

Capture and processing flow:

- live low-resolution frame analysis for document location and capture quality;
- document contour scoring using area, quadrilateral geometry and rectangularity;
- temporal stability scoring for automatic capture;
- full-resolution still capture capped to a safe working size;
- perspective correction with cubic interpolation;
- illumination-field estimation and normalization to remove broad shadows/uneven lighting;
- restrained CLAHE/local contrast enhancement;
- conservative sharpening intended to retain fine text without strong halos;
- colour-preserving Auto Clean processing in LAB colour space;
- derived Grayscale and adaptive-threshold B&W outputs;
- page output capped at 3200 px on the long edge to balance print quality and multi-page memory use;
- local PDF construction with one image per PDF page.

Manual capture always remains available even if live analysis cannot confidently detect a page.

## Privacy

- No `INTERNET` permission is declared.
- Images and PDFs are processed locally.
- Gallery import uses Android's system picker rather than broad storage permission.
- Saving uses Android's system document picker.
- Successful saves are also retained as a private app copy so Recent Scans can reopen/share them.
- Application backup is disabled because documents may be sensitive.

## Automated checks

GitHub Actions performs these checks before publishing the APK artifact:

```bash
node --check app/src/main/assets/scanner-core.js
node --check app/src/main/assets/scanner.js
node --test tests/core.test.js
node scripts/audit-ui.js
gradle :app:lintDebug
gradle :app:assembleDebug
```

The Node tests cover page order, PDF naming, document-quad scoring, image-quality decisions, navigation decisions and multi-page PDF structure. The UI audit confirms all referenced DOM controls exist, all visible buttons have handlers, all five workflow screens exist, no unfinished markers remain, no runtime script points at a CDN, and the manifest does not request internet access.

## Build artifact

The GitHub Actions workflow publishes:

`document-scanner-apk`

containing:

`app/build/outputs/apk/debug/app-debug.apk`

## Current version

`0.2.0` (`versionCode 2`)
