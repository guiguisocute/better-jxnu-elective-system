# 数据架构

> **状态：已实施**（2026-05-21 完成迁移）。
> 当前状态见 §2 目录树；如要新建学期，按 §7 SOP 走。

## 1. 总体思路

数据流分三层：

```
学校教务系统 (爬虫/油猴)
        │  抓取
        ▼
   data/semesters/<sem>/raw/*.json       ← 每学期重抓的快照（5 份）
   data/master_raw/training_plan.json    ← 跨学期累积的培养方案
        │
        │  python build_data.py (覆盖式重算，零状态)
        ▼
   data/master/*.json                    ← 跨学期持久化派生数据（4 份）
        │
        │  同一 build 顺手输出
        ▼
   public/*.json                          ← 前端 fetch 的产物
```

**核心设计原则：**

1. **覆盖式 build** —— `python build_data.py` 每次从 raw 全量重算 master + public。零状态、幂等、可回滚（删了 master 重跑就回来）。
2. **课程定义和师课绑定解耦** —— master 里的课程是稳定定义（学分/性质/培养方案归属），师课绑定属于"某学期某 section"，不进 master。
3. **学期作为顶层维度** —— `data/semesters/<sem>/raw/` 是每学期独立目录，永不混淆。
4. **stage-based 稳定文件名** —— raw 文件名按选课阶段（preselect / formal / addDrop）命名，build 脚本路径常量永远不变。学校原文件名带日期是抓取层的事，入库即改名。

---

## 2. 目录结构

```
better-jxnu-elective-system/
├── data/
│   ├── ARCHITECTURE.md                    ← 本文件
│   │
│   ├── master_raw/                        ← 跨学期 raw（仅培养方案）
│   │   └── training_plan.json             ← 一份累积大文件，年级×专业 全集
│   │
│   ├── master/                            ← build 产物，跨学期持久化（committed）
│   │   ├── courses.json                   ← cid → 课程定义（不含 teachers）
│   │   ├── teachers.json                  ← teacherId → 教师档案（跨学期累积）
│   │   └── major_requirements.json        ← 各 (年级×专业) 毕业学分要求
│   │
│   ├── semesters/                         ← 每学期一份目录（目录名 = 学期 key = YYYY-MM）
│   │   ├── 2025-09/
│   │   │   ├── meta.json                  ← 学期元信息（label="YYYY-MM"、起止日期、抓取时间戳）
│   │   │   └── raw/                       ← 5 份学期级 raw
│   │   │       ├── preselect_catalog.json ← 预选界面所有课（cid + 候选 teachers）
│   │   │       ├── formal_schedule.json   ← 正选开课安排（section 级：班级/教师/教室/时间）
│   │   │       ├── formal_actual.json     ← 正选时选课系统实际可选（暂无）
│   │   │       ├── addDrop_schedule.json  ← 补退选开课安排（裁剪版）
│   │   │       └── addDrop_actual.json    ← 补退选实际可选（暂无）
│   │   └── 2026-03/
│   │       └── ...
│   │
│   └── archive/                           ← 弃用数据（不进 build）
│       └── v5_legacy/training_plan.json   ← 当前还在这
│
└── public/                                ← 前端 fetch 产物（committed）
    ├── courses.json                       ← 当前学期预选视图（catalog only）
    ├── formal_sections.json               ← 全部已抓学期的 sections（前端按 semester 过滤）
    └── major_requirements.json            ← master/major_requirements.json 的拷贝
```

---

## 3. Raw 文件清单和职责

### 3.1 跨学期 raw（master_raw/）

| 文件 | 来源 | 频率 | 内容要点 |
|------|------|------|---------|
| `training_plan.json` | 教务系统培养方案界面 | 一年一次（新生入学时补抓本届） | 顶层 = (年级×专业)，嵌套 `课程[]`、`毕业最低学分`、`专业限选最低学分`、`按性质汇总` |

**累积策略**：新一届入学时把新爬的并入现有 JSON（年级唯一即可去重）。**不删旧年级**——2022级 数据在 2026 仍要查询。

### 3.2 学期级 raw（semesters/<sem>/raw/）

| 文件 | 阶段 | 来源 | 抓取时机 | 备注 |
|------|------|------|----------|------|
| `preselect_catalog.json` | 预选 | 预选课目录界面（油猴） | 预选进行中 | 全集（学校把所有可能开的课列出来，含大量实际不开班的） |
| `formal_schedule.json` | 正选 | 开课安排公告（油猴） | 正选开始前夕 | section 级，含教师/班级/教室/时间 |
| `formal_actual.json` | 正选 | 选课系统 | 正选进行中 | 与 schedule 对照可看到正选阶段又被裁掉的课。暂可空。 |
| `addDrop_schedule.json` | 补退选 | 开课安排公告 | 补退选开始前夕 | 课程范围比 formal_schedule 更小、时间跨度更长 |
| `addDrop_actual.json` | 补退选 | 选课系统 | 补退选进行中 | 暂可空。 |
| `openclass_status.json` | 正选(替代) | 选课开班界面（`tools/crawl_courses.py` + `tools/cas_login.py` 爬取） | 开班阶段 | 真实开班：课程号/老师(必修带教号)/容量/班级名称/选课人数；**无星期/节次/教室**。某学期若有此文件，其 formal sections 由它生成（`build_sections_from_openclass`），**跳过** formal_schedule/addDrop_schedule。用于真实 formal 时段数据未发布前先上真实课程集与师资/容量。 |

**注**：当前 `data/raw/course_schedule.json` 实际是 `formal_schedule` 角色。迁移时按学期归类。

---

## 4. 字段真值优先级（merge 规则）

每个字段单独定真值。build_data.py 按这张表 merge：

| 字段 | 来源优先级 | 备注 |
|------|----------|------|
| 课程号 cid | 任何 raw 出现即收录 | 主键 |
| 课程名 | training_plan > preselect_catalog > formal_schedule | training_plan 命名最规范 |
| 学分 | training_plan > preselect_catalog | catalog 偶有 0 值，已知补全场景 |
| 课程性质（专业主干/限选 等） | **仅** training_plan | 其他 raw 没这字段 |
| 学位课 isDegree | **仅** training_plan（`学位课程` 字段非空） | 同上 |
| 开课学院 dept | preselect_catalog > formal_schedule.单位名称 | training_plan 无此字段 |
| 简介 desc / 先修说明 | **仅** preselect_catalog | 培养方案有简版 `先修课程说明`，但 catalog 的更完整 |
| 标签 公选课 / 公共必修课 | **派生**（cid 前缀规则） | 不依赖 raw |
| 师课绑定（teachers per course） | formal_schedule（actual）> preselect_catalog（candidates） | catalog 列的是候选；schedule 是真实授课 |
| 师课绑定（per section） | **仅** formal_schedule / addDrop_schedule | section 是单 teacher 粒度 |
| 班级/教室/上课时间 | **仅** formal_schedule / addDrop_schedule | |
| 毕业学分要求 / 按性质汇总 | **仅** training_plan 顶层 | |
| 教师姓名/性别/教号/单位 | preselect_catalog 内嵌的 `教师[]` 数组 | 累积进 master/teachers.json |
| **学期标签 section.semester** | `data/semesters/<sem>/meta.json` 的 `label` | 目录名是权威源；raw 内 `学期` 字段不参与（已知会出错，见 §8） |

---

## 5. Master 库 schema

### 5.1 `data/master/courses.json`

```ts
type MasterCourse = {
  id: string;                  // 课程号
  name: string;
  credits: number;
  dept: string;                // 开课学院
  desc: string;                // 简介
  prereqId: string;
  prereqDesc: string;
  isDegreeCourse: boolean;
  tags: string[];              // 前缀派生 + nature tags（不含通用 学位课，由 isDegreeCourse 控）
  plans: CoursePlan[];         // 培养方案归属（年级×专业×方向×性质）
  // 不含 teachers — 师课绑定移到 section 层
};
```

**收录策略**：所有出现在 training_plan + preselect_catalog（任一学期）+ schedule（任一学期）里的 cid 全部入库。当前 catalog 没有但 plan/schedule 有的合成课（如 052030）也进 master。

### 5.2 `data/master/teachers.json`

```ts
type MasterTeacher = {
  id: string;                  // 教号
  name: string;
  gender: string;
  depts: string[];             // 历史所属单位（一般只有 1 个，跨单位转岗时累积）
  firstSeenSem: string;        // 2025-09
  lastSeenSem: string;
};
```

**收录策略**：从所有学期的 preselect_catalog.教师 + schedule.任课教师 累积。

### 5.3 `data/master/major_requirements.json`

不变，沿用现在的 schema：

```ts
type MajorRequirement = {
  year: string;
  major: string;
  directions: string[];
  minTotal: number;
  minMajorElective: number;
  byNature: Record<string, { count: number; sumXf: number }>;
};
```

---

## 6. Public 产物 schema（前端 fetch）

### 6.1 `public/courses.json`
**含义切换**：不再是"全部 master 课程"，而是**当前学期预选可选课程**。
即只包含 当前学期 `preselect_catalog` 的 cid 集合，从 master 取定义，再叠上当学期师课绑定。

→ "当前学期"通过 `data/semesters/_latest` 指向（或 build 脚本读 `meta.json` 找最新）。

```ts
type Course = MasterCourse & {
  teachers: Teacher[];   // 来自当前学期 preselect_catalog 的候选教师
  semester: string;      // 学校在 catalog 里写的"开课学期"字符串
  _search: string;
};
```

### 6.2 `public/formal_sections.json`
**多学期合并**：包含所有已抓学期的 formal + addDrop sections，前端按 `semester` 字段过滤。
等总大小到 10MB 再考虑按学期拆 URL。

### 6.3 `public/major_requirements.json`
master/major_requirements.json 的副本（前端可 fetch）。

---

## 7. 每学期入库 SOP

```bash
# 1. 抓取（油猴/爬虫，本仓库外）
#    → 拿到 5 份学期 raw + （新生入学时）培养方案

# 2. 落盘（目录名 = label = 学期 key，YYYY-MM 形态：秋=09 / 春=03）
mkdir -p data/semesters/2026-09/raw
cp <downloaded>/preselect_catalog_*.json   data/semesters/2026-09/raw/preselect_catalog.json
cp <downloaded>/formal_schedule_*.json     data/semesters/2026-09/raw/formal_schedule.json
# ... 其余三份按需

# 3. 维护 meta.json（手填）
cat > data/semesters/2026-09/meta.json <<'JSON'
{
  "label": "2026-09",
  "startDate": "2026-09-01",
  "endDate": "2027-01-15",
  "fetchedAt": "2026-07-15",
  "isCurrent": true
}
JSON

# 4.（仅当有新届入学）合并培养方案
#    把新爬到的 training_plan_2026级 append 进 master_raw/training_plan.json
#    （工具脚本待写：scripts/merge_plan.py）

# 5. 标记前一学期为非 current
#    把上一学期 meta.json 的 isCurrent 改成 false

# 6. 重 build
python build_data.py

# 7. 验证
npm run dev   # 抽查 预选/正选/补退选 三个 tab
```

---

## 8. 迁移历史

**2026-06-22** 2026-09 正选改用真实开班数据 + 借用数据归位：
- 新增 raw stage `openclass_status`（`tools/crawl_courses.py` 爬选课开班界面）；`data/semesters/2026-09/raw/openclass_status.json` = 真实 2026 开班（2046 行 / 1941 课程号；含老师/容量/班级名称，无星期节次教室）。
- `build_data.py`：新增 `iter_openclass_rows` + `build_sections_from_openclass`；某学期有 openclass 则 formal sections 由它生成（schedule/classroom 空，capacity 填真实值），跳过 formal_schedule/addDrop；openclass 课程号/老师并入 master。
- **借用的 2025秋 formal 归位**：`data/semesters/2026-09/raw/formal_schedule.json` → `data/semesters/2025-09/raw/formal_schedule.json` + 新建 `2025-09/meta.json`。2025-09 成为带完整周课表的真实历史学期。
- `MIRROR_SEMESTERS` 置空 `{}`（不再镜像）。`TEST_SEMESTERS` 仍含 `2026-09`（缺时段，UI 续标「（测试）」）。
- 产物：`master/courses.json` 7696、`teachers.json` 2240、`public/courses.json` 6213、`public/formal_sections.json` 12855（2026-09 openclass 7783 无时段 + 2025-09 真实 5072 带时段）。

**2026-05-21** 一次性完成迁移：
- `data/raw/course_catalog.json` → `data/semesters/2026-03/raw/preselect_catalog.json`
- `data/raw/course_schedule.json` → `data/semesters/2026-03/raw/formal_schedule.json`
- `data/raw/training_plan.json` → `data/master_raw/training_plan.json`
- 新建 `data/semesters/2026-03/meta.json`（`isCurrent: true`，label 即学期标识）
- `build_data.py` 重写为两段式：`build_master()` + `build_public()`
- 师课绑定从 master courses 移除；教师抽出到独立 `master/teachers.json`（1967 条）
- 课程合成（052030 类）入 master，前端 public/courses.json 仅含当前学期 catalog 命中的 cid（5928 门）

**2026-05-26** 学期 key 全量改 `YYYY-MM`：
- 目录、`meta.label`、`formal_sections.semester`、`courses.semester`、`termToCalLabel` 输出统一 `YYYY-09`（秋）/`YYYY-03`（春）
- 旧形态 `YYYY-春/秋` 完全淘汰；`formatSemesterLabel` 退化为仅按需追加「（测试）」后缀
- `data/semesters/2026-秋` → `data/semesters/2026-09`（git mv）
- `build_data.py:format_semester()` 输出 `YYYY-09/03`；`MIRROR_SEMESTERS = {"2026-09": ["2025-09"]}`
- 前端：`HomePage.currentSemester()` / `sortSemesters()` / `preSemesters` 正则同步对齐
- **section.semester 权威源切换**：原先用 `format_semester(开课安排.学期 字段)`（启发式），改为直接取学期目录的 `meta.label`。原因：这批数据 raw 里 学期 字段写的是 `2025/9/1`，与实际学期不符——目录名才是 ground truth。

迁移前后产物体量对照：

| 文件 | 数量 | 备注 |
|---|---|---|
| `data/master/courses.json` | 7676 | catalog 5928 + 培养方案/开课安排独有 1748 |
| `data/master/teachers.json` | 1967 | 跨学期累积 |
| `data/master/major_requirements.json` | 1152 | (年级×专业) |
| `public/courses.json` | 6210 | 当前学期 (2026-09) catalog 5928 + formal-backfill 282（前端预选侧过滤 inPre=false） |
| `public/formal_sections.json` | 10144 | 2026-09 真实 5072 + 2025-09 镜像 5072 |
| `public/major_requirements.json` | 1152 | master 副本 |

---

## 9. 未决项 / 将来再说

- **真实 2026 秋 formal 时段数据**：`2026-09` 正选/补退选现已改用真实 `openclass_status.json`（真实课程/老师/容量/班级名称），但**仍缺星期/节次/教室**（周课表网格为空）。因数据已为真实，`term.ts:TEST_SEMESTERS` 已置空（不再显示「（测试）」后缀与提示横幅）。原借用的 2025秋 formal 已归位为真实 `2025-09` 学期（带完整周课表）。**待真实带时段的 formal 数据到位**：落 `data/semesters/2026-09/raw/formal_schedule.json` 并让 build 优先用它（或在 `build_sections_from_openclass` 里并入时段）。
- **学期下拉排序**：`useFormalData.allSemesters` 与 `HomePage.preSemesters` 均按 YYYY-MM **降序**（最近学期排最上 = 下拉首项）。
- **正选 vs 补退选 数据分裂**：现在 addDrop 复用 formal 数据。等真实补退选 JSON 到位后，会分两份独立 schedule。
- **教师跨课程聚合**：master/teachers.json 是否带 `taughtCourses: cid[]`？需要算但便于"教师所授课程"查询。暂不加，等真实需求出现。
