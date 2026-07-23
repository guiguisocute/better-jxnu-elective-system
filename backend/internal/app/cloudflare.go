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
	"time"
)

const cloudflareAPIBase = "https://api.cloudflare.com/client/v4"

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
	accountID string
	apiToken  string
	project   string
	baseURL   string
	http      *http.Client
}

func NewCloudflarePagesClient(env Environment) *CloudflarePagesClient {
	return &CloudflarePagesClient{
		accountID: strings.TrimSpace(env.CFAccountID),
		apiToken:  strings.TrimSpace(env.CFAPIToken),
		project:   strings.TrimSpace(env.CFPagesProject),
		baseURL:   cloudflareAPIBase,
		http:      &http.Client{Timeout: 60 * time.Second},
	}
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
