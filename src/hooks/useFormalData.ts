import { useCallback, useEffect, useState } from "react";
import type { FormalSection } from "../types";
import { loadDataJson, loadDataManifest } from "../lib/dataClient";

export function useFormalData(selectedSemester?: string) {
  const [sections, setSections] = useState<FormalSection[]>([]);
  const [allSemesters, setAllSemesters] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadDataManifest()
      .then((manifest) => {
        if (cancelled) return Promise.resolve([] as FormalSection[]);
        const semesters = Object.keys(manifest.formalSections).sort((a, b) => b.localeCompare(a));
        setAllSemesters(semesters);
        const semester = selectedSemester && manifest.formalSections[selectedSemester]
          ? selectedSemester
          : manifest.currentSemester && manifest.formalSections[manifest.currentSemester]
            ? manifest.currentSemester
            : semesters[0];
        return semester ? loadDataJson<FormalSection[]>(manifest.formalSections[semester]) : Promise.resolve([]);
      })
      .then((data) => {
        if (cancelled) return;
        setSections(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedSemester, nonce]);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  const available = !loading && !error && sections.length > 0;
  return { sections, loading, error, reload, available, allSemesters };
}
