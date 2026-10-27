import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { useLinks } from "@/hooks/use-links";
import {
  hasModel3dUrl,
  homebase3dThingUrl,
  MODEL3D_VIEW_COPY,
  resolveModel3dSrc,
} from "@/lib/model3dView";

const Model3dViewer = lazy(() => import("@/components/Model3dViewer"));

/** Viewer + companion link. three.js is not imported here. */
export function ItemModel3dSection({ itemId, url }: { itemId: number; url: string | null | undefined }) {
  const { homebase3dUrl } = useLinks();
  const companion = homebase3dThingUrl(homebase3dUrl, itemId);
  const src = resolveModel3dSrc(url);
  const has = hasModel3dUrl(url);

  return (
    <div className="space-y-2">
      {has && src ? (
        <ViewerBoundary resetKey={src}>
          <Suspense
            fallback={
              <div className="grid h-56 place-items-center rounded-md border border-border bg-[#f4f1ea] text-[12px] text-muted-foreground">
                {MODEL3D_VIEW_COPY.loading}
              </div>
            }
          >
            <Model3dViewer src={src} />
          </Suspense>
        </ViewerBoundary>
      ) : has ? (
        <p className="text-[12px] text-muted-foreground">{MODEL3D_VIEW_COPY.unsupported}</p>
      ) : (
        <p className="text-[11px] text-muted-foreground">{MODEL3D_VIEW_COPY.missing}</p>
      )}
      {companion && (
        <a
          href={companion}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
        >
          {MODEL3D_VIEW_COPY.openCompanion}
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

class ViewerBoundary extends Component<{ children: ReactNode; resetKey: string }, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(err: Error) {
    return { message: err.message || MODEL3D_VIEW_COPY.parse };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.warn("3D viewer", err, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.message) this.setState({ message: null });
  }

  render() {
    if (this.state.message) {
      return <p className="text-[12px] text-muted-foreground">{MODEL3D_VIEW_COPY.parse}</p>;
    }
    return this.props.children;
  }
}
