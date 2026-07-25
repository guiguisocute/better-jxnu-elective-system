package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/guiguisocute/better-jxnu-elective-system/backend/internal/app"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	env := app.LoadEnvironment()
	store, err := app.OpenConfigStore(env.ConfigPath)
	if err != nil {
		logger.Error("加载配置失败", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	syncRunner := app.NewSyncRunner(env, store, logger)
	if len(os.Args) > 1 && os.Args[1] == "inspect-course" {
		if len(os.Args) != 5 {
			logger.Error("用法: jxnu-backend inspect-course <班级号> <课程号> <学期时间>")
			os.Exit(2)
		}
		inspection, inspectErr := app.NewJWCClient(env.XKUsername, env.XKPassword).InspectCourseSetting(ctx, os.Args[2], os.Args[3], os.Args[4])
		if inspectErr != nil {
			logger.Error("检查课程设置页失败", "error", inspectErr)
			os.Exit(1)
		}
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(inspection); err != nil {
			logger.Error("输出检查结果失败", "error", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "course-details" {
		result, detailErr := syncRunner.RefreshCourseDetailsOnly(ctx)
		if detailErr != nil {
			logger.Error("核查课程详情失败", "error", detailErr)
			os.Exit(1)
		}
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(result); err != nil {
			logger.Error("输出课程详情结果失败", "error", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "probe-kkap" {
		semester := store.Get().SelectionSemester
		if len(os.Args) > 2 {
			semester = os.Args[2]
		}
		result, probeErr := syncRunner.ProbeKKAP(ctx, semester)
		if probeErr != nil {
			logger.Error("探测 KKAP 目标学期失败", "error", probeErr)
			os.Exit(1)
		}
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(result); err != nil {
			logger.Error("输出 KKAP 探测结果失败", "error", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "sync" {
		scheduled := len(os.Args) > 2 && os.Args[2] == "--scheduled"
		if err := syncRunner.Run(ctx, scheduled); err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			logger.Error("同步失败", "error", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "build" {
		if err := syncRunner.BuildOnly(ctx); err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			logger.Error("离线构建失败", "error", err)
			os.Exit(1)
		}
		return
	}
	enrollment := app.NewEnrollmentService(store, logger)
	live := app.NewLiveStudentService(env, store, logger)
	go enrollment.Run(ctx)
	// 保住教务会话（省掉每次查询前的重新登录）并定期落盘按学期缓存。
	go live.RunKeepAlive(ctx)
	servers := app.NewServers(env, store, enrollment, live, syncRunner, logger)
	if err := servers.Run(ctx); err != nil {
		logger.Error("服务退出", "error", err)
		os.Exit(1)
	}
}
