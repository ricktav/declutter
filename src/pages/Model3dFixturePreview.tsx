import { lazy, Suspense } from "react";
import { MODEL3D_VIEW_COPY } from "@/lib/model3dView";

const Model3dViewer = lazy(() => import("@/components/Model3dViewer"));

const CUBE = "/fixtures/model3d/cube.glb";
const AGENT = "/fixtures/model3d/agent-cube.js";

/**
 * Dev/test only. Renders the same lazy viewer the Thing page uses, against
 * the checked-in fixtures, so a test instance can try GLB + route-1 JS
 * without live inventory. Not linked from the sidebar.
 */
export default function Model3dFixturePreview() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
        Fixture preview only — not inventory. Same viewer as the Thing detail page.
      </div>
      <h1 className="text-xl font-semibold tracking-tight">3D viewer fixtures</h1>
      <section className="space-y-2">
        <h2 className="micro-label text-muted-foreground">GLB — {CUBE}</h2>
        <Viewer src={CUBE} />
      </section>
      <section className="space-y-2">
        <h2 className="micro-label text-muted-foreground">Route-1 JS — {AGENT}</h2>
        <Viewer src={AGENT} />
      </section>
      <section className="space-y-2">
        <h2 className="micro-label text-muted-foreground">Unreachable URL</h2>
        <Viewer src="https://example.invalid/missing.glb" />
      </section>
      <section className="space-y-2">
        <h2 className="micro-label text-muted-foreground">Unsupported format</h2>
        <Viewer src="/fixtures/model3d/README.md" />
      </section>
    </div>
  );
}

function Viewer({ src }: { src: string }) {
  return (
    <Suspense
      fallback={
        <div className="grid h-56 place-items-center rounded-md border border-border bg-[#f4f1ea] text-[12px] text-muted-foreground">
          {MODEL3D_VIEW_COPY.loading}
        </div>
      }
    >
      <Model3dViewer src={src} />
    </Suspense>
  );
}
