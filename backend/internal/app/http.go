package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

type Servers struct {
	env        Environment
	config     *ConfigStore
	enrollment *EnrollmentService
	live       *LiveStudentService
	sync       *SyncRunner
	logger     *slog.Logger
	admin      *AdminServer
	finalize   *FinalizeService
	freshman   *FreshmanService
}

func NewServers(env Environment, config *ConfigStore, enrollment *EnrollmentService, live *LiveStudentService, syncRunner *SyncRunner, logger *slog.Logger) *Servers {
	servers := &Servers{env: env, config: config, enrollment: enrollment, live: live, sync: syncRunner, logger: logger}
	servers.admin = NewAdminServer(env, config, enrollment, live, syncRunner, logger)
	servers.finalize = NewFinalizeService(env, config, live, logger, servers.admin.cloudflareClient)
	servers.admin.finalize = servers.finalize
	servers.freshman = NewFreshmanService(env, config, live, logger, servers.admin.cloudflareClient)
	servers.admin.freshman = servers.freshman
	return servers
}

func (s *Servers) Run(ctx context.Context) error {
	public := configuredHTTPServer(s.env.PublicAddr, s.publicHandler())
	live := configuredHTTPServer(s.env.LiveAddr, s.liveHandler())
	admin := configuredHTTPServer(s.env.AdminAddr, s.admin.Handler())
	// 面板的 D1 请求预算是 75s（见 D1RequestTimeout），写超时必须留在它之后，
	// 否则连接会先被服务端掐断，操作者只看到空白页而不是真正的错误。
	admin.WriteTimeout = D1RequestTimeout + 45*time.Second
	// 让 D1 保持热态：这个库有 380MB，闲置后首个查询要 20–25s。
	go s.admin.RunD1Warmer(ctx)
	// 新生嗅探：低频守候，只做检查不写库（写库是面板上的手动动作）。
	go s.freshman.Run(ctx)
	type result struct {
		name string
		err  error
	}
	results := make(chan result, 3)
	for name, server := range map[string]*http.Server{"public": public, "live": live, "admin": admin} {
		go func(name string, server *http.Server) {
			s.logger.Info("HTTP 服务启动", "name", name, "addr", server.Addr)
			err := server.ListenAndServe()
			if errors.Is(err, http.ErrServerClosed) {
				err = nil
			}
			results <- result{name, err}
		}(name, server)
	}
	select {
	case <-ctx.Done():
	case item := <-results:
		if item.err != nil {
			return fmt.Errorf("%s HTTP 服务: %w", item.name, item.err)
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for _, server := range []*http.Server{public, live, admin} {
		_ = server.Shutdown(shutdownCtx)
	}
	// 同步落盘，不能交给 RunKeepAlive 的 ctx.Done 分支——那是和进程退出赛跑。
	s.live.FlushTermCache()
	return nil
}

func configuredHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 90 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20}
}

func (s *Servers) publicHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if !methodAllowed(w, r, http.MethodGet) {
			return
		}
		_, health, ok := s.enrollment.Responses()
		status := http.StatusOK
		if !ok {
			status = http.StatusServiceUnavailable
		}
		s.writeEncoded(w, r, health, status, true)
	})
	mux.HandleFunc("/api/enrollments", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			s.writeCORSPreflight(w, r)
			return
		}
		if !methodAllowed(w, r, http.MethodGet) {
			return
		}
		full, _, ok := s.enrollment.Responses()
		status := http.StatusOK
		if !ok {
			status = http.StatusServiceUnavailable
		}
		s.writeEncoded(w, r, full, status, true)
	})
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			s.writeCORSPreflight(w, r)
			return
		}
		if !methodAllowed(w, r, http.MethodGet) {
			return
		}
		cfg := s.config.Get()
		profile := cfg.ActiveAcquisitionProfile()
		writeJSON(w, map[string]any{
			"version": cfg.Version, "defaultDataSource": cfg.DefaultDataSource,
			"liveEnrollmentSemester": cfg.LiveEnrollmentTarget(),
			"activeAcquisitionStage": profile.DataSource, "activeAcquisitionSemester": profile.Semester,
			"activeAcquisitionAcademicTerm": academicTermLabel(profile.Semester),
			"phaseSemesters":                map[string]string{"pre": cfg.PreselectSemester, "formal": cfg.SelectionSemester},
			"studentScheduleTerm":           nullableString(cfg.StudentScheduleTerm),
			"studentScheduleTermMode":       map[bool]string{true: "auto", false: "fixed"}[cfg.StudentScheduleTerm == ""],
		}, http.StatusOK, s.corsOrigin(r))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if !methodAllowed(w, r, http.MethodGet) {
			return
		}
		writeJSON(w, map[string]any{"service": "jxnu-backend", "version": 2, "endpoints": []string{"/healthz", "/api/enrollments", "/api/config"}}, http.StatusOK, "")
	})
	return recoverMiddleware(s.logger, mux)
}

func (s *Servers) liveHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if !methodAllowed(w, r, http.MethodGet) {
			return
		}
		writeJSON(w, s.live.Health(), http.StatusOK, "")
	})
	mux.HandleFunc("/student-record", func(w http.ResponseWriter, r *http.Request) {
		if !methodAllowed(w, r, http.MethodGet) {
			return
		}
		if !s.live.CheckSecret(r.Header.Get("X-Live-Secret")) {
			writeJSON(w, map[string]any{"error": "forbidden"}, http.StatusForbidden, "")
			return
		}
		sid := strings.TrimSpace(r.URL.Query().Get("sid"))
		requestCtx, cancel := context.WithTimeout(r.Context(), 75*time.Second)
		defer cancel()
		payload, err := s.live.GetRecord(requestCtx, sid)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()}, http.StatusBadGateway, "")
			return
		}
		writeJSON(w, payload, http.StatusOK, "")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"service": "jxnu-live", "endpoints": []string{"/healthz", "/student-record?sid="}}, http.StatusNotFound, "")
	})
	return recoverMiddleware(s.logger, mux)
}

func (s *Servers) corsOrigin(r *http.Request) string {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return ""
	}
	for _, allowed := range s.config.Get().AllowedOrigins {
		if origin == allowed {
			return origin
		}
	}
	return ""
}
func (s *Servers) writeCORSPreflight(w http.ResponseWriter, r *http.Request) {
	origin := s.corsOrigin(r)
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Vary", "Origin")
	}
	w.WriteHeader(http.StatusNoContent)
}
func (s *Servers) writeEncoded(w http.ResponseWriter, r *http.Request, response encodedResponse, status int, cors bool) {
	if response.raw == nil {
		response = encodeResponse(map[string]any{"ok": false, "error": "服务正在初始化"})
	}
	origin := ""
	if cors {
		origin = s.corsOrigin(r)
	}
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
	w.Header().Set("Vary", "Origin, Accept-Encoding")
	w.Header().Set("Cache-Control", "no-cache, max-age=0")
	w.Header().Set("ETag", response.etag)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Header.Get("If-None-Match") == response.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	body := response.raw
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		body = response.gzip
		w.Header().Set("Content-Encoding", "gzip")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func methodAllowed(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method != method {
		w.Header().Set("Allow", method)
		writeJSON(w, map[string]any{"error": "method not allowed"}, http.StatusMethodNotAllowed, "")
		return false
	}
	return true
}
func writeJSON(w http.ResponseWriter, value any, status int, cors string) {
	raw, err := json.Marshal(value)
	if err != nil {
		http.Error(w, "json encode error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if cors != "" {
		w.Header().Set("Access-Control-Allow-Origin", cors)
		w.Header().Set("Vary", "Origin")
	}
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
func recoverMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.Error("HTTP panic", "panic", recovered, "path", r.URL.Path)
				writeJSON(w, map[string]any{"error": "internal server error"}, http.StatusInternalServerError, "")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
