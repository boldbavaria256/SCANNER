# Validation status — Scanner 0.2.0

## Passed locally

- `scanner-core.js` syntax check.
- `scanner.js` syntax check.
- 6/6 Node core tests.
- UI/static integration audit:
  - 84 unique HTML ids found;
  - 76 JavaScript element references resolved;
  - 43/43 visible buttons have bound handlers;
  - all five workflow screens present;
  - no unfinished TODO/placeholder markers in scanner logic;
  - no remote runtime script URLs;
  - Android manifest does not request `INTERNET`.

## Imaging algorithm stress test

The Auto Clean parameter set was mirrored in OpenCV 4.13 and exercised against a synthetic text-heavy document subjected to four controlled degradations: broad shadow, severe low light, bright uneven light and mixed warm/cool illumination.

Measured background standard deviation (lower is more uniform) and text/background luminance separation (higher is clearer):

| Condition | Background std before | Background std after | Text separation before | Text separation after |
|---|---:|---:|---:|---:|
| Shadow | 36.37 | 5.61 | 113.09 | 165.28 |
| Low light | 13.89 | 10.28 | 66.57 | 161.06 |
| Bright uneven light | 9.86 | 1.26 | 158.54 | 165.95 |
| Mixed light | 32.08 | 3.65 | 127.44 | 161.20 |

These synthetic tests validate the direction and parameter safety of the illumination-normalisation pipeline; they do not replace real-device photography tests.

## Required CI/device validation

The GitHub workflow is configured to run Android lint and compile the debug APK after the local tests. This exact 0.2.0 source has not yet completed that CI build because the connected GitHub integration currently returns HTTP 403 on all repository write operations.

After upload/push, the required final gates are:

1. GitHub `Validate scanner logic` passes.
2. `:app:lintDebug` passes.
3. `:app:assembleDebug` passes.
4. APK installs on a physical Android phone.
5. Single-page capture -> crop -> enhance -> save -> reopen works.
6. Multi-page capture -> add -> reorder -> rotate/delete -> create PDF -> save -> reopen works.
7. Airplane-mode test confirms camera, processing, PDF creation, save and share remain functional.
8. Test set includes daylight, low indoor light, broad shadow, mixed light, white-on-white background and dark background.
