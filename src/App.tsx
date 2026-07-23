import { BrowserRouter, Routes, Route } from "react-router-dom";
import { HomePage } from "./components/HomePage";
import { CourseDetailPage } from "./components/CourseDetailPage";
import { RatingsPage } from "./components/RatingsPage";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/course/:id" element={<CourseDetailPage />} />
        <Route path="/ratings" element={<RatingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
