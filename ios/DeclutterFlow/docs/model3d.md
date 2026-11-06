# 3D models on iOS

When a Thing has a `model3dUrl` (`items.listAll` / `items.get`), Find → Thing shows an inline orbit viewer. The same panel appears on a Thing opened from a Place plan. Failures stay in the panel.

This matches the Workbench viewer (`src/components/Model3dViewer.tsx`) where practical: metres, Y-up, no rescale, product lighting, 45° camera, 1.7× fit.

## Formats

| URL | How the app shows it |
| --- | --- |
| `.usdz` | SceneKit (`SCNScene(url:)`). Orbit / pinch-zoom. |
| `.glb` / `.gltf` | [GLTFKit2](https://github.com/warrenm/GLTFKit2) (MIT) → SceneKit. Xcode resolves the package on first build. |
| `.js` (route 1) | Bundled three.js r186 (`three.module.js` + `three.core.js`, MIT, **no CDN**) in a WKWebView. Same `export function build(THREE)` contract as the Workbench. |

`local/…` and `/uploads/…` are fetched from the Settings server base URL with the app token. Remote `http(s)` URLs are downloaded the same way.

## Try it (test instance, not live :3001)

Point the app at a test HomeBase (Settings → Server base URL), e.g. `http://10.50.0.102:3004`.

1. On that instance, give a test Thing a fixture URL (`items.setModel3d` — do **not** write these into the live database):

```
http://10.50.0.102:3004/fixtures/model3d/cube.glb
http://10.50.0.102:3004/fixtures/model3d/agent-cube.js
http://10.50.0.102:3004/fixtures/model3d/real/35.js
```

The checked-in fixtures are `cube.glb` (20 cm moss cube) and `agent-cube.js` (`build(THREE)`). `real/35.js` is a route-1 module on the test instance only.

2. In the app: **Find** → open that Thing. The 3D panel is under the Photos. Drag to orbit, pinch/scroll to zoom, tap the expand icon for full screen.

3. Fallbacks (panel only, the sheet stays up):

```
http://10.50.0.102:3004/fixtures/model3d/README.md     → unsupported
https://example.invalid/missing.glb                    → could not be reached
```

A list row with a model shows a green **3D** badge (same idea as the Workbench All Things pill).

## What this agent could not run

This change was written on Linux. `xcodebuild` is not available here. First Mac build: open `ios/DeclutterFlow/DeclutterFlow.xcodeproj`, let Xcode resolve **GLTFKit2**, then build for Simulator or a device. Do not change the bundle id or signing team.
