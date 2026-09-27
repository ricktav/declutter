import { Routes, Route, Navigate } from "react-router";
import { AskProvider } from "@/context/ask";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import InboxPage from "@/pages/Inbox";
import AreaView from "@/pages/AreaView";
import ItemDetail from "@/pages/ItemDetail";
import IdeasPage from "@/pages/Ideas";
import TasksPage from "@/pages/Tasks";
import WikiPage from "@/pages/Wiki";
import ActivityPage from "@/pages/Activity";

export default function App() {
  return (
    <AskProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/areas/:slug" element={<AreaView />} />
          <Route path="/items/:id" element={<ItemDetail />} />
          <Route path="/ideas" element={<IdeasPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/wiki" element={<WikiPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AskProvider>
  );
}
