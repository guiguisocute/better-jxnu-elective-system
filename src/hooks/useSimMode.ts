import { useState, useCallback, useEffect } from "react";

// 模拟选课模式状态机：browse → onboarding → sim。
//   browse      ：与现状一致，仅多一个顶部开关
//   onboarding  ：首次进入的 3 步引导（确认方案 / 手填已修 / 确认核算）
//   sim         ：底部 dock + 课程行加车按钮 + 详情加车 CTA
export type SimMode = "browse" | "onboarding" | "sim";

const ONBOARDED_KEY = "jxnu.onboarding.done";
// 开关状态随刷新保留：与 jxnu_data_source / jxnu_filters 同机制走 sessionStorage
// （刷新保留、关标签页/重开浏览器复位）。只持久化 browse/sim，不持久化 onboarding 中间态。
const MODE_KEY = "jxnu.sim.mode";

function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return false;
  }
}

function initialMode(): SimMode {
  if (typeof window !== "undefined") {
    try {
      // 支持 ?sim=1 直接进入模拟态（便于分享链接）。
      if (new URLSearchParams(window.location.search).get("sim") === "1") return "sim";
      // 刷新恢复上次开关状态（仅 sim 才恢复，onboarding 中间态不恢复）。
      if (sessionStorage.getItem(MODE_KEY) === "sim") return "sim";
    } catch {}
  }
  return "browse";
}

export function useSimMode() {
  const [mode, setMode] = useState<SimMode>(initialMode);
  // 引导定位：openOnboarding 可带 step（默认第1步）。OnboardingModal 每次开引导都重新挂载，读它作初始步。
  const [onboardingStep, setOnboardingStep] = useState(1);
  // 取消引导后回到哪：默认 browse（保持首次引导 / 编辑已修的原行为）；
  // 从 dock「放大查看课表」临时进引导时传 "sim"，关闭后回到 dock。
  const [onboardingExit, setOnboardingExit] = useState<SimMode>("browse");

  // 持久化开关状态（onboarding 中间态不落盘，避免刷新卡在引导）。
  useEffect(() => {
    if (mode === "onboarding") return;
    try { sessionStorage.setItem(MODE_KEY, mode); } catch {}
  }, [mode]);

  // 在 sim 态下重新打开引导：默认第1步、关闭回 browse（如 dock 的「编辑已修」）；
  // 「放大查看课表」传 (5, "sim") → 定位第5步、关闭回 dock。不影响“已引导”标记。
  // step 用 typeof 守卫：onClick 直接绑定会把事件当首参传进来，须忽略。
  const openOnboarding = useCallback((step: number = 1, exitTo: SimMode = "browse") => {
    setOnboardingStep(typeof step === "number" ? step : 1);
    setOnboardingExit(exitTo);
    setMode("onboarding");
  }, []);

  // 点开关进入：引导过则直达 sim，否则先走引导（第1步）。
  const open = useCallback(() => {
    if (hasOnboarded()) setMode("sim");
    else openOnboarding();
  }, [openOnboarding]);

  const close = useCallback(() => setMode("browse"), []);

  const finishOnboarding = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {}
    setMode("sim");
  }, []);

  const cancelOnboarding = useCallback(() => setMode(onboardingExit), [onboardingExit]);

  // 直接进入 sim 态（不走 hasOnboarded gate）。是否先弹引导由调用方按「是否选了培养方案」决定。
  const goSim = useCallback(() => setMode("sim"), []);

  // 顶部开关：browse → 进入；sim → 关闭。onboarding 态点开关不动作（由弹窗按钮处理）。
  // 进引导统一走 openOnboarding（复位 step / exit），避免沿用上次「放大查看」的第5步。
  const toggle = useCallback(() => {
    if (mode === "sim") { setMode("browse"); return; }
    if (mode === "browse") {
      if (hasOnboarded()) setMode("sim");
      else openOnboarding();
    }
  }, [mode, openOnboarding]);

  return { mode, toggle, open, goSim, close, finishOnboarding, cancelOnboarding, openOnboarding, onboardingStep };
}
