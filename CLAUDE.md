# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

JXNU选课PLUS — a single-page React application for browsing Jiangxi Normal University (江西师范大学) course catalog. The UI is entirely in Chinese (zh-CN). Course data is static (build-time Python pipeline), but teacher ratings use Cloudflare D1 via Pages Functions.

## Commands

- `npm run dev` — Start Vite dev server (port 5173)
- `npm run build` — Type-check with `tsc -b` then build with Vite
- `npm run lint` — Run ESLint
- `npm run preview` — Preview production build locally
- `python build_data.py` — Regenerate `public/courses.json` from raw university data files

## Architecture

**Data pipeline**: Raw university JSON exports (`JXNU课程数据_*.json`, `JXNU开课安排_*.json`) are processed by `build_data.py` into `public/courses.json`. The Python script normalizes Chinese field names to English, classifies courses by type (公选课/公共必修课/专业课) using course ID prefixes and schedule data, and builds a `_search` index field.

**Client-side SPA**: The React app fetches `courses.json` on mount and performs all filtering/sorting/pagination entirely client-side.

**Rating system**: Cloudflare Pages Functions (`functions/api/`) backed by D1 database. Schema in `d1_schema.sql`. Binding name: `DB`. Endpoints:
- `GET /api/ratings?courseId=xxx` — teacher averages for one course
- `GET /api/ratings/all` — all ratings (used by table view)
- `GET /api/ratings/check?teacherId=xxx&voterId=xxx` — check if user rated
- `POST /api/ratings` — submit rating (courseId, teacherId, rating, voterId)

Voter deduplication uses localStorage UUID (`src/lib/voter.ts`). D1 binding configured in CF Dashboard.

**Component layout**:
- Desktop: 3-column layout — `FilterBar` (left), `CourseTable` (center), `CourseDetail` (right sidebar)
- Mobile: Single-column — course list with slide-out filter drawer, navigates to `CourseDetailPage` for full-page detail
- Responsive breakpoint at `md:` (768px)

**Routes** (defined in `App.tsx`):
- `/` → `HomePage` (main browsing)
- `/course/:id` → `CourseDetailPage` (mobile detail view)

**State management**: No external library. Custom hooks:
- `useCourseData` — fetches `courses.json`, computes filter options
- `useCourseFilter` — filtering, sorting, pagination with `sessionStorage` persistence
- `useRatings` — per-course teacher ratings from D1
- `useAllRatings` — bulk ratings for table view

**Filter system**: Tri-state cycle: default → include → exclude → default. Each filter dimension (type, credits, dept, tags, teacher) supports both inclusion and exclusion.

## Key Type Definitions (`src/types.ts`)

- `Course` — `{ id, name, credits, dept, semester, prereqId, prereqDesc, desc, tags, teachers, _search }`
- `Teacher` — `{ dept, id, name, gender }`
- `Filters` — search string + arrays for credits/dept/type/tag with separate `*Exclude` arrays, plus teacher string

## Tech Stack Versions

React 19, TypeScript 6, Vite 8, Tailwind CSS 4 (via `@tailwindcss/vite` plugin — no tailwind.config, uses `@import "tailwindcss"` in CSS), React Router DOM 7, ESLint 10 with flat config.

## Data Update Workflow

When new university data files are provided:
1. Place the raw JSON files in the project root
2. Update the `COURSE_FILE` and `SCHEDULE_FILE` constants in `build_data.py`
3. Run `python build_data.py`
4. The output goes to `public/courses.json` (also copied to `dist/` on build)
