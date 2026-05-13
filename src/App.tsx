import { BrowserRouter, Routes, Route } from "react-router-dom";
import { HomePage } from "./components/HomePage";
import { CourseDetailPage } from "./components/CourseDetailPage";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/course/:id" element={<CourseDetailPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
