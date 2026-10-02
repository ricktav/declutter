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
import WikiPage from "@/pages/Wiki";
import ActivityPage from "@/pages/Activity";
import AnnotatePage from "@/pages/Annotate";
import MapPage from "@/pages/Map";
import RoomsPage from "@/pages/Rooms";
import RoomPlanPage from "@/pages/RoomPlan";
import PhotosPage from "@/pages/Photos";
import SettingsPage from "@/pages/Settings";
import SessieOverzicht from "@/pages/SessieOverzicht";
import GalaxyPage from "@/pages/Galaxy";

export default function App() {
  return (
    <AskProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/snap" element={<Navigate to="/inbox" replace />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/areas/:slug" element={<AreaView />} />
          <Route path="/items" element={<AllItems />} />
          <Route path="/items/:id" element={<ItemDetail />} />
          <Route path="/photos" element={<PhotosPage />} />
          <Route path="/annotate/:attachmentId" element={<AnnotatePage />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/rooms" element={<RoomsPage />} />
          <Route path="/rooms/:roomId" element={<RoomPlanPage />} />
          <Route path="/galaxy" element={<GalaxyPage />} />
          <Route path="/ideas" element={<IdeasPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/wiki" element={<WikiPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/sessie-overzicht" element={<SessieOverzicht />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AskProvider>
  );
}
