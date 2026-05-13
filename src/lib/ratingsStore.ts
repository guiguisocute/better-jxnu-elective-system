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
  const res = await fetch(`/api/ratings?courseId=${courseId}`);
  const data: TeacherRating[] = await res.json();
  setReal(courseId, data);
}

export async function fetchAllAndSet() {
  const res = await fetch("/api/ratings/all");
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
