package main

import (
	"context"
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
	if len(os.Args) > 1 && os.Args[1] == "sync" {
		if err := syncRunner.Run(ctx); err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			logger.Error("同步失败", "error", err)
			os.Exit(1)
		}
		return
	}
	enrollment := app.NewEnrollmentService(store, logger)
	live := app.NewLiveStudentService(env, store, logger)
	go enrollment.Run(ctx)
	servers := app.NewServers(env, store, enrollment, live, syncRunner, logger)
	if err := servers.Run(ctx); err != nil {
		logger.Error("服务退出", "error", err)
		os.Exit(1)
	}
}
