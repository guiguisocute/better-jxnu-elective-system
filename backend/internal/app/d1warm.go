package app

import (
	"context"
	"sync"
	"time"
)

// The jxnu-ratings D1 database is ~380 MB, and 289 MB of that is one table:
// student_records (28,818 pre-computed JSON blobs). The review system — the only
// thing the public site reads on a hot path — is under half a megabyte.
//
// D1 evicts an idle instance and has to page it back in before answering the
// next statement, and at this size that reload costs 10–25 s, sometimes enough to
// hit D1's own 30 s max-query-duration cap. Measured from the VPS by varying the
// idle gap between two identical `SELECT COUNT(*) FROM reviews` calls:
//
//	gap 10 s → 0.21 s      gap 20 s → 0.24 s
//	gap 25 s → 9.9 s       cold     → 24 s / 30 s (capped)
//
// So the resident window is only ~20–25 s. That reload was the real cause of the
// panel's "context deadline exceeded" saves and of every D1-backed page feeling
// slow — including the public site, whose Pages Functions hit the same database.
//
// Pinging inside that window keeps the instance resident for everyone. It is a
// band-aid over a sizing problem, though: the durable fix is to move
// student_records out of this database (it is build-time output that the review
// path never reads), after which the reviews DB is small enough that a cold start
// stops mattering.
const (
	// d1WarmInterval must sit inside the measured ~20 s residency window, with
	// margin for a slow round trip. At 15 s this is 5,760 single-row reads a day,
	// negligible against D1's 5 M rows/day free allowance.
	d1WarmInterval = 15 * time.Second
	// d1WarmTimeout is generous because a ping that lands on an already-evicted
	// instance is exactly the one that must succeed to make it resident again.
	d1WarmTimeout = D1RequestTimeout
)

// reviewOpsSchema creates the trash + audit tables. Mirrors
// d1_reviews_audit_migrate.sql; every statement is IF NOT EXISTS so running it
// on every boot is free. Constant SQL with no parameters, so it can go over in a
// single multi-statement request.
const reviewOpsSchema = `
CREATE TABLE IF NOT EXISTS review_trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id  INTEGER NOT NULL,
  course_id  TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  voter_id   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  votes      TEXT,
  deleted_by TEXT NOT NULL,
  source     TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  restored_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_trash_deleted ON review_trash(deleted_at);
CREATE INDEX IF NOT EXISTS idx_review_trash_review  ON review_trash(review_id);
CREATE INDEX IF NOT EXISTS idx_review_trash_open    ON review_trash(restored_at);
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  before TEXT,
  after  TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at     ON admin_audit(at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit(action);
CREATE INDEX IF NOT EXISTS idx_reviews_updated ON reviews(updated_at DESC);
`

// d1WarmStatement is literally the review list page's own first query (page 1,
// no filter) — not `SELECT 1`, and not an approximation of it.
//
// What costs time here is not SQL. For the list query D1 reports
// sql_duration_ms = 0.8 while the HTTP request takes 26 s: the time goes into D1
// fetching the needed database pages from remote storage, and this database is
// 380 MB. So a ping only helps for the pages it actually touches:
//
//	SELECT 1                        → touches nothing; page stayed 20 s slow
//	SELECT id,course_id,… LIMIT 20  → misses the comment overflow pages; 15 s
//	the page's own `SELECT r.*` …   → 0.3 s
//
// Hence sharing reviewListStatement instead of writing a lookalike.
func d1WarmStatement() D1Statement { return reviewListStatement("", "course", "all", 0) }

// d1SchemaState tracks the one-time table creation. Kept as a struct rather than
// sync.Once so a failed attempt (expired token, D1 unreachable at boot) is
// retried instead of latched.
type d1SchemaState struct {
	mu    sync.Mutex
	ready bool
}

// EnsureReviewOpsTables creates review_trash / admin_audit if missing. Safe to
// call from any handler: it does at most one D1 round trip per process once it
// has succeeded.
func (a *AdminServer) EnsureReviewOpsTables(ctx context.Context) error {
	a.schema.mu.Lock()
	defer a.schema.mu.Unlock()
	if a.schema.ready {
		return nil
	}
	cloudflare := a.cloudflareClient()
	if !cloudflare.D1Ready() {
		return errD1NotConfigured
	}
	if err := cloudflare.D1Exec(ctx, reviewOpsSchema); err != nil {
		return err
	}
	a.schema.ready = true
	a.logger.Info("D1 回收站/操作日志表已就绪")
	return nil
}

// RunD1Warmer keeps the D1 instance resident and makes sure the trash + audit
// tables exist, so no manual migration step is needed after deploying.
func (a *AdminServer) RunD1Warmer(ctx context.Context) {
	ticker := time.NewTicker(d1WarmInterval)
	defer ticker.Stop()
	// Report only on transitions; a flapping network must not flood journald.
	lastOK := true
	for {
		if a.cloudflareClient().D1Ready() {
			ok := a.warmOnce(ctx)
			if ok != lastOK {
				if ok {
					a.logger.Info("D1 保温恢复正常")
				} else {
					a.logger.Warn("D1 保温失败，下一次仍会重试（首次访问可能要等冷启动）")
				}
				lastOK = ok
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// warmOnce touches the hot-path pages and, while it is at it, ensures the
// schema. Returns whether the ping succeeded.
func (a *AdminServer) warmOnce(parent context.Context) bool {
	ctx, cancel := context.WithTimeout(parent, d1WarmTimeout)
	defer cancel()
	warm := d1WarmStatement()
	if _, _, err := a.cloudflareClient().D1Query(ctx, warm.SQL, warm.Params); err != nil {
		return false
	}
	if err := a.EnsureReviewOpsTables(ctx); err != nil {
		a.logger.Warn("创建 D1 回收站/操作日志表失败", "error", err)
	}
	return true
}
