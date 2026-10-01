package gatekeeper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// GitHub is the github provider. It knows one resource kind,
// repo/<owner>/<repo>, and one verb, read: GET and HEAD on the repository's
// REST API, https://api.github.com/repos/<owner>/<repo>[/...]. A gadget names
// the path relative to the repository, so a grant cannot reach another one.
// Writes wait for the approval queue.
type GitHub struct {
	// APIURL is the REST API's base URL; https://api.github.com if empty.
	APIURL string
	// HTTP is the client Account uses.
	HTTP *http.Client
}

var (
	githubRepo  = regexp.MustCompile(`^repo/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]{1,100})$`)
	readMethods = map[string]bool{http.MethodGet: true, http.MethodHead: true}
	// Request headers a gadget may set; everything else is dropped.
	githubRequestHeaders = []string{"Accept", "If-None-Match", "If-Modified-Since"}
)

func (g GitHub) base() string {
	if g.APIURL == "" {
		return "https://api.github.com"
	}
	return strings.TrimSuffix(g.APIURL, "/")
}

func (g GitHub) Prepare(ctx context.Context, c Capability, r CallRequest) (*http.Request, error) {
	m := githubRepo.FindStringSubmatch(c.Resource)
	if m == nil {
		return nil, fmt.Errorf("github has no resource %q; use repo/<owner>/<repo>", c.Resource)
	}
	if m[2] == "." || m[2] == ".." {
		return nil, fmt.Errorf("github has no repository %q", m[2])
	}
	if c.Verb != "read" {
		return nil, fmt.Errorf("github supports only the read verb")
	}
	if !readMethods[r.Method] {
		return nil, fmt.Errorf("%s is not a read; %s allows GET and HEAD", r.Method, c)
	}
	path, query, err := relativePath(r.Path)
	if err != nil {
		return nil, err
	}
	u := g.base() + "/repos/" + m[1] + "/" + m[2] + path
	if query != "" {
		u += "?" + query
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, u, nil)
	if err != nil {
		return nil, fmt.Errorf("bad request: %w", err)
	}
	for _, h := range githubRequestHeaders {
		if v := header(r.Headers, h); v != "" {
			req.Header.Set(h, v)
		}
	}
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "application/vnd.github+json")
	}
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "kodo-gatekeeper")
	return req, nil
}

func (g GitHub) Authorize(req *http.Request, token string) {
	req.Header.Set("Authorization", "Bearer "+token)
}

func (g GitHub) Account(ctx context.Context, token string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.base()+"/user", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "kodo-gatekeeper")
	g.Authorize(req, token)
	client := g.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github did not accept the token: %s", res.Status)
	}
	var user struct {
		Login string `json:"login"`
	}
	if err := json.NewDecoder(res.Body).Decode(&user); err != nil || user.Login == "" {
		return "", errors.New("github returned no account for the token")
	}
	return user.Login, nil
}

func (g GitHub) ResponseHeaders() []string {
	return []string{
		"Content-Type", "ETag", "Last-Modified", "Link", "Location",
		"X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset",
	}
}

// relativePath checks a path relative to a resource: empty, or starting with
// a slash, with no empty, "." or ".." segments, raw or escaped. It returns
// the path and the query string.
func relativePath(p string) (string, string, error) {
	path, query, _ := strings.Cut(p, "?")
	if path == "" {
		return "", query, nil
	}
	if !strings.HasPrefix(path, "/") {
		return "", "", fmt.Errorf("path %q must start with /", path)
	}
	unescaped, err := url.PathUnescape(path)
	if err != nil {
		return "", "", fmt.Errorf("path %q is not a valid URL path", path)
	}
	for _, candidate := range []string{path, unescaped} {
		if strings.ContainsAny(candidate, "\\\x00\r\n#") {
			return "", "", fmt.Errorf("path %q has characters that are not allowed", path)
		}
		segs := strings.Split(candidate[1:], "/")
		for i, s := range segs {
			if s == "." || s == ".." || (s == "" && i != len(segs)-1) {
				return "", "", fmt.Errorf("path %q leaves the resource", path)
			}
		}
	}
	if _, err := url.ParseQuery(query); err != nil {
		return "", "", fmt.Errorf("bad query string: %w", err)
	}
	return path, query, nil
}

func header(h map[string]string, name string) string {
	for k, v := range h {
		if strings.EqualFold(k, name) {
			return v
		}
	}
	return ""
}
