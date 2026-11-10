import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { HomePage } from "./components/HomePage";

const CourseDetailPage = lazy(() => import("./components/CourseDetailPage").then((m) => ({ default: m.CourseDetailPage })));
const RatingsPage = lazy(() => import("./components/RatingsPage").then((m) => ({ default: m.RatingsPage })));

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="min-h-screen bg-page" />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/course/:id" element={<CourseDetailPage />} />
          <Route path="/ratings" element={<RatingsPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
