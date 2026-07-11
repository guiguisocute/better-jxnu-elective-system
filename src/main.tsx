import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadAppConfig } from './lib/appConfig'

// 运行时配置（public/app_config.json）：挂载即拉取一次；失败静默用默认值。
loadAppConfig()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
