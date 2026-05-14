export interface TeacherRating {
  teacher_id: string;
  avg_rating: number;
  count: number;
}

export type CourseRatings = Record<string, Record<string, { avg: number; count: number }>>;

type Listener = () => void;

const real = new Map<string, Map<string, TeacherRating>>();
const optimistic = new Map<string, Map<string, number>>();
const listeners = new Set<Listener>();

function notify() {
  for (const fn of listeners) fn();
}

export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getSnapshot() {
  return { real, optimistic };
}

export function applyOptimistic(courseId: string, teacherId: string, rating: number) {
  let course = optimistic.get(courseId);
  if (!course) { course = new Map(); optimistic.set(courseId, course); }
  course.set(teacherId, rating);
  notify();
}

export function setReal(courseId: string, data: TeacherRating[]) {
  const map = new Map<string, TeacherRating>();
  for (const r of data) map.set(r.teacher_id, r);
  real.set(courseId, map);
  // Clear only optimistic values confirmed by server
  const opt = optimistic.get(courseId);
  if (opt) {
    for (const [tid, val] of opt) {
      const server = map.get(tid);
      if (server && Math.abs(server.avg_rating - val) < 0.01) opt.delete(tid);
    }
    if (opt.size === 0) optimistic.delete(courseId);
  }
  notify();
}

export async function fetchAndSet(courseId: string) {
  const res = await fetch(`/api/ratings?courseId=${courseId}`, { cache: "no-cache" });
  const data: TeacherRating[] = await res.json();
  setReal(courseId, data);
}

export async function fetchAllAndSet() {
  const res = await fetch("/api/ratings/all", { cache: "no-cache" });
  const all: CourseRatings = await res.json();
  for (const [cid, teachers] of Object.entries(all)) {
    const data: TeacherRating[] = Object.entries(teachers).map(([tid, v]) => ({
      teacher_id: tid,
      avg_rating: v.avg,
      count: v.count,
    }));
    setReal(cid, data);
  }
}

/** Check if the current voter has already rated a specific teacher for a specific course */
export async function checkMyRating(
  courseId: string,
  teacherId: string,
  voterId: string
): Promise<{ rated: boolean; rating: number | null }> {
  const res = await fetch(
    `/api/ratings/check?courseId=${encodeURIComponent(courseId)}&teacherId=${encodeURIComponent(teacherId)}&voterId=${encodeURIComponent(voterId)}`,
    { cache: "no-cache" }
  );
  return res.json();
}

/** Remove optimistic state for a specific teacher */
export function removeOptimistic(courseId: string, teacherId: string) {
  const opt = optimistic.get(courseId);
  if (opt) {
    opt.delete(teacherId);
    if (opt.size === 0) optimistic.delete(courseId);
  }
  notify();
}

/** Delete the current voter's rating for a specific teacher/course */
export async function deleteMyRating(
  courseId: string,
  teacherId: string,
  voterId: string
): Promise<{ ok: boolean }> {
  const res = await fetch("/api/ratings", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ courseId, teacherId, voterId }),
  });
  return res.json();
}
