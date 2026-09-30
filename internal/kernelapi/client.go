// Package kernelapi calls a fleet's kernel API through the Kubernetes API
// server's service proxy, so the operator reaches it the same way in and out
// of the cluster, and the fleet needs no other ingress for it.
package kernelapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"k8s.io/client-go/rest"
)

// Client calls the kernel API of fleets.
type Client struct {
	rest rest.Interface
}

// New returns a client that uses the given core/v1 REST client.
func New(restClient rest.Interface) *Client {
	return &Client{rest: restClient}
}

// Response is a kernel API answer.
type Response struct {
	Status int
	Body   []byte
}

// OK reports a 2xx status.
func (r Response) OK() bool { return r.Status >= 200 && r.Status < 300 }

// Error returns the kernel's {"error": ...} message, or the raw body.
func (r Response) Error() string {
	var body struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(r.Body, &body) == nil && body.Error != "" {
		return body.Error
	}
	return strings.TrimSpace(string(r.Body))
}

// Decode unmarshals the body into v.
func (r Response) Decode(v any) error { return json.Unmarshal(r.Body, v) }

// Target is a fleet's kernel API: the fleet's Service and the admin token
// the kernel accepts from the operator.
type Target struct {
	Namespace  string
	Service    string
	AdminToken string
}

// Do calls METHOD /api/PATH on the target fleet. A body that is not []byte is
// sent as JSON. A transport failure, including the fleet not answering, is an
// error; any HTTP answer is a Response.
func (c *Client) Do(ctx context.Context, t Target, method, path string, body any) (Response, error) {
	req := c.rest.Verb(method).
		Namespace(t.Namespace).
		Resource("services").
		Name(fmt.Sprintf("http:%s:http", t.Service)).
		SubResource("proxy").
		Suffix("api", strings.TrimPrefix(path, "/")).
		SetHeader("x-kodo-admin-token", t.AdminToken)
	switch b := body.(type) {
	case nil:
	case []byte:
		req = req.SetHeader("Content-Type", "text/javascript").Body(b)
	default:
		data, err := json.Marshal(b)
		if err != nil {
			return Response{}, err
		}
		req = req.SetHeader("Content-Type", "application/json").Body(data)
	}

	result := req.Do(ctx)
	var status int
	result.StatusCode(&status)
	raw, err := result.Raw()
	if status == 0 {
		return Response{}, fmt.Errorf("kernel API %s %s: %w", method, path, err)
	}
	// The API server answers 503 itself when no endpoint is ready.
	if status == http.StatusServiceUnavailable && len(raw) > 0 && strings.Contains(string(raw), `"kind":"Status"`) {
		return Response{}, fmt.Errorf("kernel API %s %s: fleet not ready", method, path)
	}
	return Response{Status: status, Body: raw}, nil
}
