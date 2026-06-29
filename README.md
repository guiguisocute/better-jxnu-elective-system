<div align="center">

# 🐢 JXNU 选课 PLUS

**江西师范大学选课系统增强版** — 致力于减少每位江师大 er 的选课折磨

<br />

[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vite.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)

[![React Router](https://img.shields.io/badge/React_Router-7-CA4245?style=for-the-badge&logo=reactrouter&logoColor=white)](https://reactrouter.com/)
[![Apache ECharts](https://img.shields.io/badge/Apache_ECharts-6-AA344D?style=for-the-badge&logo=apacheecharts&logoColor=white)](https://echarts.apache.org/)
[![ESLint](https://img.shields.io/badge/ESLint-10-4B32C3?style=for-the-badge&logo=eslint&logoColor=white)](https://eslint.org/)
[![Python](https://img.shields.io/badge/Python-Data_Pipeline-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)

[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare_Pages-Hosting-F38020?style=for-the-badge&logo=cloudflarepages&logoColor=white)](https://pages.cloudflare.com/)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare_D1-Database-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)

<br />

![JXNU 选课 PLUS 预览](https://r2.guiguisocute.cloud/PicGo/2026/06/29/b9d18798b753df840733c2fa60114fab.png)

</div>

## 功能

- **三阶段课程视图** — 预选 / 正选 / 补退选一键切换，支持多学期浏览
- **多维筛选** — 课程类型 / 学分 / 开课单位 / 标签 / 教师 / 教室，包含与排除双模式
- **课表时段筛选** — 周课表网格点选「仅看 / 排除」某时段，含多时段冲突提醒
- **培养方案归属** — 按「年级-专业」过滤课程，标签随方案动态收敛，学位课高亮
- **模拟选课 & 毕业核算** — 待选清单、周课表排班、必修/选修学分实时清算（ECharts 环图）
- **学号一键导入** — 去标识化拉取已修档案，自动回填学期/学分/已修限选并校对本学期课表
- **方案分享码** — 无需后端，压缩编码即可分享整套模拟选课方案
- **教师评分** — 匿名打分，挑课不靠运气
- **响应式布局** — 桌面端三栏 / 移动端单栏自适应，支持浅色 / 深色主题

## 开发

```bash
npm install
npm run dev        # 启动开发服务器 (port 5173，host 开放，局域网可访问)
npm run build      # tsc -b 类型检查 + Vite 构建
npm run lint       # ESLint 检查
```

## 数据更新

课程数据由 build-time Python 流水线生成：

```bash
python build_data.py   # 由 data/master_raw + data/semesters/<sem>/raw 生成 public/*.json
```

完整的每学期更新 SOP 与字段优先级表见 [`data/ARCHITECTURE.md`](data/ARCHITECTURE.md)。

## 部署

前端托管于 **Cloudflare Pages**（从 `main` 分支自动部署）；教师评分与学号档案存于 **Cloudflare D1**，通过 Pages Functions（`functions/api/`）读写。

## 技术栈

React 19 · TypeScript 6 · Vite 8 · Tailwind CSS 4 · React Router 7 · Apache ECharts 6 · ESLint 10 · Cloudflare Pages Functions + D1 · Python 数据流水线
