package gatekeeper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Inference is the inference provider: models behind the platform's
// inference gateway (Envoy AI Gateway). It knows one resource kind,
// model/<name>, and one verb, invoke: a POST of an OpenAI chat completion to
// "/chat/completions". The model is the granted one, whatever the body says,
// and the gateway decides which backend serves it, so routing changes need no
// gadget changes. The platform holds the backends' keys at the gateway: users
// connect nothing, and each call tells the gateway its owner, workspace and
// Blueprint, which budgets, rate limits and metrics are kept on.
type Inference struct {
	// URL is the gateway's base URL; calls go to <URL>/v1/chat/completions.
	URL string
	// Key, if set, is sent in GatewayKeyHeader; the gateway takes calls only
	// with it.
	Key string
	// Timeout bounds each call; DefaultInferenceTimeout if zero.
	Timeout time.Duration
}

// Headers the Gatekeeper sets on every inference call. The gateway keys
// budgets on the user and workspace and labels metrics with the workspace and
// Blueprint. Envoy evaluates a budget again when the response ends, from the
// request headers as they went upstream, so the gateway cannot remove these
// before a backend sees them: they carry only opaque names, never an email
// address or a cell. The key is removed.
const (
	GatewayKeyHeader    = "X-Kodo-Gateway-Key"
	InferenceUserHeader = "X-Kodo-User"
	InferenceWSHeader   = "X-Kodo-Workspace"
	InferenceBPHeader   = "X-Kodo-Blueprint"
	// The longest a model call may take, for the agent writing a whole
	// gadget in one answer; the gateway bounds each model further, and the
	// kernel gives a gadget's calls far less.
	DefaultInferenceTimeout = 120 * time.Second
)

var inferenceModel = regexp.MustCompile(`^model/([a-z0-9](?:[a-z0-9._-]{0,62}))$`)

// chatFields are the chat completion fields a gadget may set. Others are
// refused: some backends read extra fields that pick another model or
// provider, which would leave the grant.
var chatFields = map[string]bool{
	"messages": true, "max_tokens": true, "max_completion_tokens": true, "temperature": true, "top_p": true,
	"stop": true, "seed": true, "presence_penalty": true, "frequency_penalty": true, "response_format": true,
	"tools": true, "tool_choice": true, "parallel_tool_calls": true, "reasoning_effort": true, "logprobs": true,
	"top_logprobs": true, "n": true, "stream": true, "model": true,
}

const maxPromptBytes = 1 << 20

// Usage is what one inference call consumed, as its backend reported it.
type Usage struct {
	// The backend's name for the model that answered.
	Model  string `json:"model,omitempty"`
	Input  int64  `json:"input"`
	Output int64  `json:"output"`
	Total  int64  `json:"total"`
}

func (i Inference) Prepare(ctx context.Context, c Capability, r CallRequest, _ string) (*http.Request, error) {
	m := inferenceModel.FindStringSubmatch(c.Resource)
	if m == nil {
		return nil, fmt.Errorf("inference has no resource %q; use model/<name>", c.Resource)
	}
	if c.Verb != "invoke" {
		return nil, errors.New("inference supports only the invoke verb")
	}
	if r.Method != http.MethodPost {
		return nil, fmt.Errorf("%s takes POST, not %s", c, r.Method)
	}
	if r.Path != "/chat/completions" {
		return nil, fmt.Errorf("%s serves /chat/completions, not %q", c, r.Path)
	}
	if i.URL == "" {
		return nil, errors.New("this Gatekeeper has no inference gateway")
	}
	body, err := chatRequest(m[1], r.Body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(i.URL, "/")+"/v1/chat/completions",
		bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("bad request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	return req, nil
}

// chatRequest checks a gadget's chat completion and returns it for the
// granted model.
func chatRequest(model string, raw []byte) ([]byte, error) {
	if len(raw) > maxPromptBytes {
		return nil, errors.New("request larger than 1 MiB")
	}
	var body map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&body); err != nil || body == nil {
		return nil, errors.New("body must be a chat completion: {\"messages\": [...], ...}")
	}
	if dec.More() {
		return nil, errors.New("body must be one JSON object")
	}
	var unknown []string
	for k := range body {
		if !chatFields[k] {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, fmt.Errorf("chat completions do not take %s", strings.Join(unknown, ", "))
	}
	var messages []json.RawMessage
	if json.Unmarshal(body["messages"], &messages) != nil || len(messages) == 0 {
		return nil, errors.New("messages must be a non-empty list")
	}
	if s, ok := body["stream"]; ok && string(s) != "false" {
		return nil, errors.New("streaming is not supported; leave stream unset")
	}
	if n, ok := body["n"]; ok && string(n) != "1" {
		return nil, errors.New("n must be 1")
	}
	// The grant names the model; the gateway maps it to a backend.
	body["model"], _ = json.Marshal(model)
	return json.Marshal(body)
}

// Attribute names the call's owner (the identity provider's subject),
// workspace and Blueprint to the gateway. The workspace is qualified by the
// fleet, whose workspace names are its own.
func (i Inference) Attribute(req *http.Request, fleet string, call Call) {
	req.Header.Set(InferenceUserHeader, call.Owner.User)
	req.Header.Set(InferenceWSHeader, fleet+"/"+call.Workspace)
	req.Header.Set(InferenceBPHeader, call.Blueprint)
}

func (i Inference) Authorize(req *http.Request, _ string) {
	if i.Key != "" {
		req.Header.Set(GatewayKeyHeader, i.Key)
	}
}

func (i Inference) Account(context.Context, string, string) (string, error) {
	return "", errors.New("inference needs no connection; the platform holds its keys")
}

// ResponseHeaders includes when a refusal by the gateway's budgets ends, in
// seconds.
func (i Inference) ResponseHeaders() []string {
	return []string{"Content-Type", "X-Ratelimit-Reset"}
}

func (i Inference) Describe(c Capability, r CallRequest, _ string) Summary {
	return Summary{Title: "Ask " + strings.TrimPrefix(c.Resource, "model/"), Body: string(r.Body)}
}

func (i Inference) CallTimeout() time.Duration {
	if i.Timeout > 0 {
		return i.Timeout
	}
	return DefaultInferenceTimeout
}

// Meter reads the usage from a chat completion. A refusal by the gateway's
// budgets or rate limits (a 429 with rate limit headers and no body; a
// backend's own 429 has one) gets a body that says so.
func (i Inference) Meter(a *Answer) *Usage {
	if a.Status == http.StatusTooManyRequests && len(a.Body) == 0 && a.Headers["x-ratelimit-reset"] != "" {
		a.Headers["content-type"] = "application/json"
		a.Body, _ = json.Marshal(map[string]string{
			"error": "over the inference budget or rate limit of the cell's owner or workspace; try again later",
		})
		return nil
	}
	if a.Status < 200 || a.Status > 299 {
		return nil
	}
	var res struct {
		Model string `json:"model"`
		Usage *struct {
			Prompt     int64 `json:"prompt_tokens"`
			Completion int64 `json:"completion_tokens"`
			Total      int64 `json:"total_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(a.Body, &res) != nil || res.Usage == nil {
		return nil
	}
	u := &Usage{Model: res.Model, Input: res.Usage.Prompt, Output: res.Usage.Completion, Total: res.Usage.Total}
	if u.Total == 0 {
		u.Total = u.Input + u.Output
	}
	return u
}
