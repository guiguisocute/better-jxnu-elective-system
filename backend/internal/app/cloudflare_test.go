package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCloudflarePagesClientProjectPatchAndDeploy(t *testing.T) {
	t.Helper()
	var patched map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Fatalf("authorization = %q", got)
		}
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`{"success":true,"result":{"name":"demo","deployment_configs":{"production":{"env_vars":{"AI_MODEL":{"type":"plain_text","value":"model-a"},"AI_API_KEY":{"type":"secret_text"}}}}}}`))
		case http.MethodPatch:
			if err := json.NewDecoder(r.Body).Decode(&patched); err != nil {
				t.Fatal(err)
			}
			_, _ = w.Write([]byte(`{"success":true,"result":{"name":"demo"}}`))
		case http.MethodPost:
			_, _ = w.Write([]byte(`{"success":true,"result":{"id":"deployment-1","environment":"production"}}`))
		default:
			t.Fatalf("unexpected method %s", r.Method)
		}
	}))
	defer server.Close()

	client := &CloudflarePagesClient{
		accountID: "account", apiToken: "test-token", project: "demo",
		baseURL: server.URL, http: server.Client(),
	}
	project, err := client.GetProject(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if project.Name != "demo" || project.DeploymentConfigs.Production.EnvVars["AI_MODEL"].Value != "model-a" {
		t.Fatalf("unexpected project: %#v", project)
	}
	updates := map[string]CloudflareEnvVar{
		"AI_SYSTEM_PROMPT": {Type: "plain_text", Value: "prompt"},
		"AI_API_KEY":       {Type: "secret_text", Value: "new-secret"},
	}
	if err := client.PatchProductionEnv(context.Background(), updates); err != nil {
		t.Fatal(err)
	}
	configs := patched["deployment_configs"].(map[string]any)
	production := configs["production"].(map[string]any)
	envVars := production["env_vars"].(map[string]any)
	if len(envVars) != 2 {
		t.Fatalf("PATCH must contain only explicit updates, got %#v", envVars)
	}
	deployment, err := client.CreateProductionDeployment(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if deployment.ID != "deployment-1" || deployment.Environment != "production" {
		t.Fatalf("unexpected deployment: %#v", deployment)
	}
}

func TestCloudflareErrorIsConcise(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":10000,"message":"authentication failed"}]}`))
	}))
	defer server.Close()
	client := &CloudflarePagesClient{accountID: "a", apiToken: "hidden-token", project: "p", baseURL: server.URL, http: server.Client()}
	_, err := client.GetProject(context.Background())
	if err == nil || err.Error() != "Cloudflare API（HTTP 403）：10000: authentication failed" {
		t.Fatalf("unexpected error: %v", err)
	}
}
