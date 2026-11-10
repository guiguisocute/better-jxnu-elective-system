export interface DataManifest {
  version: number;
  currentSemester: string | null;
  courses: string;
  courseDetails: string;
  formalSections: Record<string, string>;
}

const jsonPromises = new Map<string, Promise<unknown>>();
let manifestPromise: Promise<DataManifest> | null = null;

async function fetchJson<T>(url: string, cache: RequestCache): Promise<T> {
  const res = await fetch(url, { cache });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as T;
}

export function loadDataJson<T>(url: string): Promise<T> {
  const cached = jsonPromises.get(url);
  if (cached) return cached as Promise<T>;
  const promise = fetchJson<unknown>(url, "default");
  jsonPromises.set(url, promise);
  void promise.catch(() => {
    if (jsonPromises.get(url) === promise) jsonPromises.delete(url);
  });
  return promise as Promise<T>;
}

export function loadDataManifest(): Promise<DataManifest> {
  if (!manifestPromise) {
    manifestPromise = fetchJson<unknown>("/data_manifest.json", "no-cache").then((raw) => {
      if (!raw || typeof raw !== "object") throw new Error("数据清单格式异常");
      const value = raw as Partial<DataManifest>;
      if (
        typeof value.courses !== "string" ||
        typeof value.courseDetails !== "string" ||
        !value.formalSections || typeof value.formalSections !== "object"
      ) {
        throw new Error("数据清单格式异常");
      }
      return value as DataManifest;
    });
    void manifestPromise.catch(() => {
      manifestPromise = null;
    });
  }
  return manifestPromise;
}
