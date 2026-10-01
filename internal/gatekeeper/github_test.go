package gatekeeper

import (
	"context"
	"testing"
)

func TestParseCapability(t *testing.T) {
	c, err := ParseCapability("github:repo/acme/api:read")
	if err != nil || c != (Capability{"github", "repo/acme/api", "read"}) {
		t.Fatalf("got %+v, %v", c, err)
	}
	c, err = ParseCapability("x:a:b:write")
	if err != nil || c.Resource != "a:b" || c.Verb != "write" {
		t.Fatalf("resource with a colon: %+v, %v", c, err)
	}
	for _, bad := range []string{"", "github", "github:repo", ":r:v", "github:r:", "github:repo/acme/*:read", "a: b:c"} {
		if _, err := ParseCapability(bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestGitHubScope(t *testing.T) {
	g := GitHub{APIURL: "https://api.test"}
	read := func(capability, method, path string) (string, error) {
		c, err := ParseCapability(capability)
		if err != nil {
			t.Fatal(err)
		}
		req, err := g.Prepare(context.Background(), c, CallRequest{Method: method, Path: path})
		if err != nil {
			return "", err
		}
		return req.URL.String(), nil
	}

	for path, want := range map[string]string{
		"":                       "https://api.test/repos/acme/api",
		"/readme":                "https://api.test/repos/acme/api/readme",
		"/contents/src/a.go":     "https://api.test/repos/acme/api/contents/src/a.go",
		"/contents/docs/":        "https://api.test/repos/acme/api/contents/docs/",
		"/commits?per_page=5":    "https://api.test/repos/acme/api/commits?per_page=5",
		"?ref=main":              "https://api.test/repos/acme/api?ref=main",
		"/contents/a%20file.txt": "https://api.test/repos/acme/api/contents/a%20file.txt",
	} {
		got, err := read("github:repo/acme/api:read", "GET", path)
		if err != nil || got != want {
			t.Errorf("GET %q: got %q, %v; want %q", path, got, err, want)
		}
	}

	for _, tc := range []struct{ capability, method, path string }{
		{"github:repo/acme/api:read", "POST", "/issues"},
		{"github:repo/acme/api:read", "DELETE", ""},
		{"github:repo/acme/api:write", "GET", ""},
		{"github:repo/acme/api:read", "GET", "/../../other/repo"},
		{"github:repo/acme/api:read", "GET", "/%2e%2e/%2e%2e/other/repo"},
		{"github:repo/acme/api:read", "GET", "/a/../../x"},
		{"github:repo/acme/api:read", "GET", "//evil.test/x"},
		{"github:repo/acme/api:read", "GET", "readme"},
		{"github:repo/acme/api:read", "GET", "/x#frag"},
		{"github:repo/acme/api:read", "GET", "/x%0d%0aHost:evil"},
		{"github:org/acme:read", "GET", ""},
		{"github:repo/acme:read", "GET", ""},
		{"github:repo/acme/api/extra:read", "GET", ""},
		{"github:repo/acme/..:read", "GET", ""},
	} {
		if got, err := read(tc.capability, tc.method, tc.path); err == nil {
			t.Errorf("%s %s %q was allowed: %s", tc.capability, tc.method, tc.path, got)
		}
	}
}

func TestGitHubPassesOnlySafeHeaders(t *testing.T) {
	c, _ := ParseCapability("github:repo/acme/api:read")
	req, err := GitHub{}.Prepare(context.Background(), c, CallRequest{
		Method:  "GET",
		Headers: map[string]string{"accept": "application/vnd.github.raw", "authorization": "Bearer stolen", "host": "evil"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("Authorization") != "" || req.Host != req.URL.Host {
		t.Errorf("gadget headers reached upstream: %v host=%q", req.Header, req.Host)
	}
	if req.Header.Get("Accept") != "application/vnd.github.raw" {
		t.Errorf("accept header lost: %v", req.Header)
	}
	if req.URL.Host != "api.github.com" {
		t.Errorf("default API host is %s", req.URL.Host)
	}
}
