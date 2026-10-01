package gatekeeper

import (
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const hn = "web:hn.algolia.com/api/v1:read"

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// webHarness has a web provider for hn.algolia.com whose calls are answered
// by a fake transport, which records them.
func webHarness(t *testing.T) (*harness, *[]*http.Request) {
	h := newHarness(t)
	var seen []*http.Request
	h.srv.Providers["web"] = Web{
		Allow: []string{"hn.algolia.com", "*.example.org"},
		HTTP: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			seen = append(seen, r)
			header := http.Header{"Content-Type": {"application/json"}, "Set-Cookie": {"a=1"}, "Etag": {`"v1"`}}
			return &http.Response{StatusCode: 200, Header: header, Body: io.NopCloser(strings.NewReader(`{"hits":[]}`))}, nil
		})},
	}
	return h, &seen
}

func TestWebReadsAnAllowedPublicAPI(t *testing.T) {
	h, seen := webHarness(t)
	c := readCall(hn, "GET", "/search?tags=front_page&hitsPerPage=30", hn)
	c.Request.Headers = map[string]string{"Accept": "application/json", "Authorization": "Bearer x", "Cookie": "s=1"}
	// No connection: there is nothing to connect.
	status, a := h.call(c, fleetKey)
	if status != http.StatusOK || a.Status != http.StatusOK || string(a.Body) != `{"hits":[]}` {
		t.Fatalf("got %d %+v", status, a)
	}
	r := (*seen)[0]
	if r.URL.String() != "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30" {
		t.Errorf("url %s", r.URL)
	}
	if r.Header.Get("Accept") != "application/json" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
		t.Errorf("request headers %v", r.Header)
	}
	for k := range r.Header {
		if strings.HasPrefix(strings.ToLower(k), "x-kodo") {
			t.Errorf("%s reached a public API", k)
		}
	}
	if _, ok := a.Headers["set-cookie"]; ok || a.Headers["etag"] != `"v1"` {
		t.Errorf("response headers %v", a.Headers)
	}
}

func TestWebRefusesWhatIsNotAPublicRead(t *testing.T) {
	h, seen := webHarness(t)
	call := func(capability, method, path string) Call { return readCall(capability, method, path, capability) }
	cases := []struct {
		name string
		call Call
		want string
	}{
		{"host not allowed", call("web:news.ycombinator.com:read", "GET", ""), "does not allow reading news.ycombinator.com"},
		{"write", call("web:api.example.org:write", "GET", ""), "no calls that wait for approval"},
		{"IP literal", call("web:10.0.0.1/x:read", "GET", ""), "DNS name"},
		{"cluster name", call("web:kodo-gatekeeper.kodo-system.svc:read", "GET", ""), "not a public host"},
		{"single label", call("web:localhost:read", "GET", ""), "DNS name"},
		{"port", call("web:hn.algolia.com:8080/x:read", "GET", ""), "with a DNS name"},
		{"POST", call(hn, "POST", "/search"), "not a read"},
		{"leaves the prefix", call(hn, "GET", "/../v2/search"), "leaves the resource"},
		{"escaped", call(hn, "GET", "/%2e%2e/v2"), "leaves the resource"},
		{"bad prefix", call("web:hn.algolia.com/api/../x:read", "GET", ""), "invalid path"},
		{"invoke", call("web:hn.algolia.com:invoke", "GET", ""), "only the read verb"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, a := h.call(tc.call, fleetKey)
			if a.Status != http.StatusForbidden || !strings.Contains(string(a.Body), tc.want) {
				t.Fatalf("got %d %s, want a denial with %q", a.Status, a.Body, tc.want)
			}
		})
	}
	withBody := call(hn, "GET", "/search")
	withBody.Request.Body = []byte("x")
	if _, a := h.call(withBody, fleetKey); a.Status != http.StatusForbidden {
		t.Errorf("a read with a body: %d", a.Status)
	}
	if len(*seen) != 0 {
		t.Errorf("%d calls were made", len(*seen))
	}
}

func TestWebIsNotAConnection(t *testing.T) {
	h, _ := webHarness(t)
	req, _ := http.NewRequest(http.MethodPut, h.public.URL+"/gatekeeper/api/connections/web", strings.NewReader(`{"token":"x"}`))
	req.Header.Set(IdentityHeader, "alice-token")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("connecting web: %d", res.StatusCode)
	}
}

func TestPublicIP(t *testing.T) {
	for addr, public := range map[string]bool{
		"1.1.1.1": true, "151.101.1.140": true, "2606:4700::1111": true,
		"127.0.0.1": false, "10.42.0.7": false, "10.43.0.10": false, "172.16.3.4": false, "192.168.2.224": false,
		"169.254.169.254": false, "100.64.1.1": false, "0.0.0.0": false, "224.0.0.1": false, "::1": false,
		"fe80::1": false, "fd00::1": false, "::ffff:127.0.0.1": false, "::ffff:10.0.0.1": false, "240.0.0.1": false,
	} {
		if got := PublicIP(net.ParseIP(addr)); got != public {
			t.Errorf("PublicIP(%s) = %v", addr, got)
		}
	}
}

func TestPublicClientConnectsOnlyToPublicAddresses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "internal")
	}))
	defer srv.Close()
	_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	// By address, and by a name that resolves to it.
	for _, u := range []string{srv.URL, "http://localhost:" + port} {
		res, err := PublicClient(0).Get(u)
		if err == nil {
			_ = res.Body.Close()
			t.Fatalf("%s: connected", u)
		}
		if !errors.Is(err, errNotPublic) {
			t.Errorf("%s: %v", u, err)
		}
	}
}
