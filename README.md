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
[![Go](https://img.shields.io/badge/Go-VPS_Backend-00ADD8?style=for-the-badge&logo=go&logoColor=white)](https://go.dev/)

[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare_Pages-Hosting-F38020?style=for-the-badge&logo=cloudflarepages&logoColor=white)](https://pages.cloudflare.com/)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare_D1-Database-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)

<br />

![JXNU 选课 PLUS 预览](https://r2.guiguisocute.cloud/PicGo/2026/06/29/b9d18798b753df840733c2fa60114fab.png)

</div>

## 功能

- **两入口课程视图** — 预选 / 正选与补退选（共用课表）一键切换，支持多学期浏览
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

VPS 上的实时人数、学号实时课表、管理面板和自动同步由单个 Go 后端提供。完整部署说明见 [`deploy/README.md`](deploy/README.md)。

### 进入 VPS 管理面板

在本机运行并保持终端打开：

```bash
ssh -L 8790:127.0.0.1:8790 29HK
```

然后访问 [http://127.0.0.1:8790](http://127.0.0.1:8790)，输入安装时生成或从旧面板迁移的管理密码。面板的“日常设置”可直接选择：

- 网站默认显示预选或正选/补退选；
- 预选与正选/补退选各自的数据目标学期；
- 正选切补退选时使用的容量嗅探 URL；
- 学号实时课表自动跟随或指定的教务学期（支持直接输入新增学期）。

这些设置热更新，不需要手改多个 env 或逐个重启服务。面板只监听 VPS 的 `127.0.0.1`，不能从公网直接访问。

## 技术栈

React 19 · TypeScript 6 · Vite 8 · Tailwind CSS 4 · React Router 7 · Apache ECharts 6 · ESLint 10 · Go VPS 后端 · Cloudflare Pages Functions + D1 · Python 构建期数据流水线
