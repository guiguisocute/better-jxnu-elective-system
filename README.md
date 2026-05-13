# JXNU选课PLUS

江西师范大学选课系统增强版 — 提供更好的课程浏览、搜索和筛选体验。

## 功能

- 课程搜索与多维筛选（课程类型、学分、开课单位、标签、教师）
- 支持包含/排除双模式筛选
- 课程详情查看（学分、先修要求、简介、教师信息）
- 教师评分系统（半星步长，五颗星展示，支持修改评分）
- 直达教务系统选课链接
- 桌面端三栏布局 / 移动端单栏自适应

## 开发

```bash
npm install
npm run dev        # 启动开发服务器 (port 5173)
npm run build      # 类型检查 + 构建
npm run lint       # ESLint 检查
```

## 数据更新

将教务系统导出的 JSON 文件放入项目根目录，修改 `build_data.py` 中的文件名常量，然后运行：

```bash
python build_data.py
```

## 技术栈

React 19 · TypeScript 6 · Vite 8 · Tailwind CSS 4 · React Router 7 · Cloudflare Pages Functions + D1
