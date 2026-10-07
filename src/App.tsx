import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router";
import { AskProvider } from "@/context/ask";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import InboxPage from "@/pages/Inbox";
import AreaView from "@/pages/AreaView";
import AllItems from "@/pages/AllItems";
import ItemDetail from "@/pages/ItemDetail";
import IdeasPage from "@/pages/Ideas";
import TasksPage from "@/pages/Tasks";
import ActivityPage from "@/pages/Activity";
import AnnotatePage from "@/pages/Annotate";
import RoomsPage from "@/pages/Rooms";
import PhotosPage from "@/pages/Photos";
import SettingsPage from "@/pages/Settings";
import FocusPage from "@/pages/Focus";

// Heavy, rarely-first pages: three.js, d3, leaflet and marked only load
// when their route is visited.
const RoomPlanPage = lazy(() => import("@/pages/RoomPlan"));
const GalaxyPage = lazy(() => import("@/pages/Galaxy"));
const StoragePage = lazy(() => import("@/pages/Storage"));
const MapPage = lazy(() => import("@/pages/Map"));
const WikiPage = lazy(() => import("@/pages/Wiki"));

function Loading() {
  return <div className="p-6 text-[13px] text-muted-foreground">Loading…</div>;
}

export default function App() {
  return (
    <AskProvider>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/focus" element={<FocusPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/areas/:slug" element={<AreaView />} />
            <Route path="/items" element={<AllItems />} />
            <Route path="/items/:id" element={<ItemDetail />} />
            <Route path="/photos" element={<PhotosPage />} />
            <Route path="/annotate/:photoId" element={<AnnotatePage />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/rooms" element={<RoomsPage />} />
            <Route path="/rooms/:roomId" element={<RoomPlanPage />} />
            <Route path="/galaxy" element={<GalaxyPage />} />
            <Route path="/storage" element={<StoragePage />} />
            <Route path="/ideas" element={<IdeasPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/wiki" element={<WikiPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </AskProvider>
  );
}
