# 3D viewer fixtures

Dev / test samples only. Not live inventory. Served by Vite at
`/fixtures/model3d/…` so a Workbench on another port can load them.

| File | What it is |
| --- | --- |
| `cube.glb` | 20 cm moss-green cube (Meshy / Object Capture stand-in) |
| `agent-cube.js` | Route-1 `export function build(THREE)` module |

`items.setModel3d` only stores `/uploads/…`, `local/…`, or an http(s) URL, so
point a test Thing at the absolute fixture URL, e.g.

```
http://127.0.0.1:3002/fixtures/model3d/cube.glb
http://127.0.0.1:3002/fixtures/model3d/agent-cube.js
```

Do not write these URLs into the live database.
