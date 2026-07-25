package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const cloudflareAPIBase = "https://api.cloudflare.com/client/v4"

// D1 timing constants. The jxnu-ratings database is ~380 MB (student_records
// dominates), and a D1 instance that has gone idle needs 20–25 s to page itself
// back in before it answers the first statement; warm statements answer in
// ~0.2 s. The old 30 s request budget sat right on top of that cold-start window,
// which is what produced "context deadline exceeded" in the panel. Budget well
// past the cold start, and keep the database warm (see d1warm.go) so the cold
// path is almost never taken.
const (
	// D1RequestTimeout bounds one D1 statement, cold start included.
	D1RequestTimeout = 75 * time.Second
	// cloudflareHTTPTimeout must exceed D1RequestTimeout so the context deadline
	// is what fires, giving callers the more specific error.
	cloudflareHTTPTimeout = 90 * time.Second
	// d1MaxConcurrency caps the fan-out of D1Many.
	d1MaxConcurrency = 8
)

// CloudflareEnvVar mirrors a Pages environment variable. Secret values are
// never rendered by the admin panel and are only sent when the operator enters
// a replacement explicitly.
type CloudflareEnvVar struct {
	Type  string `json:"type"`
	Value string `json:"value,omitempty"`
}

type CloudflareDeployment struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	CreatedOn   string `json:"created_on"`
	Environment string `json:"environment"`
	LatestStage struct {
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"latest_stage"`
}

type CloudflarePagesProject struct {
	Name              string                `json:"name"`
	LatestDeployment  *CloudflareDeployment `json:"latest_deployment"`
	DeploymentConfigs struct {
		Production struct {
			EnvVars map[string]CloudflareEnvVar `json:"env_vars"`
		} `json:"production"`
	} `json:"deployment_configs"`
}

type cloudflareAPIError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type cloudflareEnvelope struct {
	Success bool                 `json:"success"`
	Errors  []cloudflareAPIError `json:"errors"`
	Result  json.RawMessage      `json:"result"`
}

type CloudflarePagesClient struct {
	accountID    string
	apiToken     string
	project      string
	d1DatabaseID string
	baseURL      string
	http         *http.Client
}

func NewCloudflarePagesClient(env Environment) *CloudflarePagesClient {
	return &CloudflarePagesClient{
		accountID:    strings.TrimSpace(env.CFAccountID),
		apiToken:     strings.TrimSpace(env.CFAPIToken),
		project:      strings.TrimSpace(env.CFPagesProject),
		d1DatabaseID: strings.TrimSpace(env.CFD1DatabaseID),
		baseURL:      cloudflareAPIBase,
		http:         &http.Client{Timeout: cloudflareHTTPTimeout, Transport: cloudflareTransport()},
	}
}

// cloudflareTransport widens the idle-connection pool. http.DefaultTransport
// keeps only 2 idle connections per host, so the concurrent fan-out in D1Many
// would otherwise renegotiate TLS on most statements.
func cloudflareTransport() http.RoundTripper {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = d1MaxConcurrency * 2
	transport.MaxConnsPerHost = d1MaxConcurrency * 2
	return transport
}

// ForDatabase returns a shallow copy pointed at another D1 database, reusing the
// same credentials, HTTP client and connection pool. Needed because 学号快照 and
// 评价数据 deliberately live in separate databases.
func (c *CloudflarePagesClient) ForDatabase(databaseID string) *CloudflarePagesClient {
	if c == nil {
		return nil
	}
	clone := *c
	clone.d1DatabaseID = strings.TrimSpace(databaseID)
	return &clone
}

func (c *CloudflarePagesClient) Ready() bool {
	return c != nil && c.accountID != "" && c.apiToken != "" && c.project != ""
}

func (c *CloudflarePagesClient) ProjectName() string {
	if c == nil {
		return ""
	}
	return c.project
}

func (c *CloudflarePagesClient) GetProject(ctx context.Context) (CloudflarePagesProject, error) {
	var project CloudflarePagesProject
	err := c.do(ctx, http.MethodGet, c.projectPath(), nil, &project)
	return project, err
}

// PatchProductionEnv updates only the supplied keys. Cloudflare's PATCH
// contract preserves omitted keys; this avoids ever round-tripping redacted
// secret values returned by GET /projects/:name.
func (c *CloudflarePagesClient) PatchProductionEnv(ctx context.Context, updates map[string]CloudflareEnvVar) error {
	if len(updates) == 0 {
		return errors.New("没有需要保存的环境变量")
	}
	payload := map[string]any{
		"deployment_configs": map[string]any{
			"production": map[string]any{"env_vars": updates},
		},
	}
	var ignored CloudflarePagesProject
	return c.do(ctx, http.MethodPatch, c.projectPath(), payload, &ignored)
}

func (c *CloudflarePagesClient) CreateProductionDeployment(ctx context.Context) (CloudflareDeployment, error) {
	var deployment CloudflareDeployment
	err := c.do(ctx, http.MethodPost, c.projectPath()+"/deployments", nil, &deployment)
	return deployment, err
}

func (c *CloudflarePagesClient) projectPath() string {
	return "/accounts/" + url.PathEscape(c.accountID) + "/pages/projects/" + url.PathEscape(c.project)
}

// D1Ready reports whether the account, API token, and D1 database ID are all
// present. Querying D1 needs an API Token with Account / D1 / Edit permission.
func (c *CloudflarePagesClient) D1Ready() bool {
	return c != nil && c.accountID != "" && c.apiToken != "" && c.d1DatabaseID != ""
}

// D1Query runs a single parameterized statement against the bound D1 database
// and returns the first statement's result rows plus the number of rows it
// changed. SQL is always parameterized — never string-concatenated. The D1
// /query endpoint returns result as an array of per-statement objects.
func (c *CloudflarePagesClient) D1Query(ctx context.Context, sql string, params []any) ([]map[string]any, int, error) {
	if !c.D1Ready() {
		return nil, 0, errors.New("Cloudflare D1 凭据未配置")
	}
	if params == nil {
		params = []any{}
	}
	payload := map[string]any{"sql": sql, "params": params}
	var result []struct {
		Results []map[string]any `json:"results"`
		Success bool             `json:"success"`
		Meta    struct {
			Changes int `json:"changes"`
		} `json:"meta"`
	}
	path := "/accounts/" + url.PathEscape(c.accountID) + "/d1/database/" + url.PathEscape(c.d1DatabaseID) + "/query"
	if err := c.do(ctx, http.MethodPost, path, payload, &result); err != nil {
		return nil, 0, err
	}
	if len(result) == 0 {
		return nil, 0, nil
	}
	for _, item := range result {
		if !item.Success {
			return nil, 0, errors.New("D1 查询未成功执行")
		}
	}
	return result[0].Results, result[0].Meta.Changes, nil
}

// D1Statement is one parameterized statement handed to D1Many.
type D1Statement struct {
	SQL    string
	Params []any
}

// D1Result carries one statement's outcome. Err is per-statement: a failure in
// one entry never hides the results of the others.
type D1Result struct {
	Rows    []map[string]any
	Changes int
	Err     error
}

// Rows returns the requested statement's rows, or nil when the index is out of
// range or that statement failed. Lets render code stay linear.
func d1Rows(results []D1Result, index int) []map[string]any {
	if index < 0 || index >= len(results) || results[index].Err != nil {
		return nil
	}
	return results[index].Rows
}

// D1Many runs independent statements concurrently and returns their results
// positionally.
//
// Cloudflare's /query endpoint does accept several `;`-separated statements, but
// only without bound parameters ("params with multiple statements is not
// supported"), and this codebase never string-concatenates SQL. So the way to
// stop per-statement round trips from stacking up is concurrency, not batching:
// a page that issued seven sequential statements paid seven round trips.
//
// Statements must not depend on one another's effects — ordering is undefined.
// Use D1Query in sequence for read-then-write flows.
func (c *CloudflarePagesClient) D1Many(ctx context.Context, statements []D1Statement) []D1Result {
	results := make([]D1Result, len(statements))
	if len(statements) == 0 {
		return results
	}
	gate := make(chan struct{}, d1MaxConcurrency)
	var wg sync.WaitGroup
	for i, statement := range statements {
		wg.Add(1)
		go func(i int, statement D1Statement) {
			defer wg.Done()
			gate <- struct{}{}
			defer func() { <-gate }()
			rows, changes, err := c.D1Query(ctx, statement.SQL, statement.Params)
			results[i] = D1Result{Rows: rows, Changes: changes, Err: err}
		}(i, statement)
	}
	wg.Wait()
	return results
}

// firstD1Error returns the first per-statement error, so callers that need
// all-or-nothing semantics can bail with one check.
func firstD1Error(results []D1Result) error {
	for _, result := range results {
		if result.Err != nil {
			return result.Err
		}
	}
	return nil
}

// D1Exec runs parameter-free statements in a single request. Only for SQL that
// is a compile-time constant in this repository (schema DDL) — anything carrying
// user input must go through D1Query/D1Many so it stays parameterized.
func (c *CloudflarePagesClient) D1Exec(ctx context.Context, sql string) error {
	_, _, err := c.D1Query(ctx, sql, nil)
	return err
}

func (c *CloudflarePagesClient) do(ctx context.Context, method, path string, payload any, out any) error {
	if !c.Ready() {
		return errors.New("Cloudflare Pages API 凭据未配置")
	}
	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("编码 Cloudflare 请求: %w", err)
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.baseURL, "/")+path, body)
	if err != nil {
		return fmt.Errorf("创建 Cloudflare 请求: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiToken)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("请求 Cloudflare Pages API: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return fmt.Errorf("读取 Cloudflare 响应: %w", err)
	}
	var envelope cloudflareEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("Cloudflare 返回非 JSON（HTTP %d）", resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !envelope.Success {
		return fmt.Errorf("Cloudflare API（HTTP %d）：%s", resp.StatusCode, cloudflareErrorText(envelope.Errors))
	}
	if out != nil && len(envelope.Result) > 0 && string(envelope.Result) != "null" {
		if err := json.Unmarshal(envelope.Result, out); err != nil {
			return fmt.Errorf("解析 Cloudflare 响应: %w", err)
		}
	}
	return nil
}

func cloudflareErrorText(items []cloudflareAPIError) string {
	if len(items) == 0 {
		return "请求失败"
	}
	parts := make([]string, 0, len(items))
	for _, item := range items {
		message := strings.TrimSpace(item.Message)
		if len(message) > 240 {
			message = message[:240]
		}
		if item.Code != 0 {
			message = fmt.Sprintf("%d: %s", item.Code, message)
		}
		parts = append(parts, message)
	}
	return strings.Join(parts, "；")
}
