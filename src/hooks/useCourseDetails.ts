import { useEffect, useState } from "react";
import type { CourseDetails } from "../types";
import { loadDataJson, loadDataManifest } from "../lib/dataClient";

const EMPTY_DETAILS: Record<string, CourseDetails> = {};

export function useCourseDetails() {
  const [details, setDetails] = useState<Record<string, CourseDetails>>(EMPTY_DETAILS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadDataManifest()
      .then((manifest) => loadDataJson<Record<string, CourseDetails>>(manifest.courseDetails))
      .then((data) => {
        if (cancelled) return;
        setDetails(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { details, loading, error };
}
