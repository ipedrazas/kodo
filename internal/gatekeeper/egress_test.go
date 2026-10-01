package gatekeeper

import (
	"bufio"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEgressAllowlist(t *testing.T) {
	p := &EgressProxy{Allow: []string{"t3.storage.dev:443", "*.t3.storage.dev:443"}}
	for target, want := range map[string]bool{
		"t3.storage.dev:443":           true,
		"kodo-dev.t3.storage.dev:443":  true,
		"KODO-DEV.T3.storage.dev.:443": true,
		"t3.storage.dev:80":            false,
		"evil-t3.storage.dev:443":      false,
		"t3.storage.dev.evil.com:443":  false,
		"api.github.com:443":           false,
		"t3.storage.dev":               false,
	} {
		if got := p.Allowed(target); got != want {
			t.Errorf("%s: allowed=%v, want %v", target, got, want)
		}
	}
}

func TestEgressProxyTunnelsOnlyToAllowedHosts(t *testing.T) {
	// An upstream that echoes one line.
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = upstream.Close() }()
	go func() {
		for {
			c, err := upstream.Accept()
			if err != nil {
				return
			}
			go func() {
				line, _ := bufio.NewReader(c).ReadString('\n')
				_, _ = io.WriteString(c, "echo "+line)
				_ = c.Close()
			}()
		}
	}()
	_, port, _ := net.SplitHostPort(upstream.Addr().String())
	p := &EgressProxy{
		Allow: []string{"bucket.test:" + port},
		Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Dial: func(network, addr string) (net.Conn, error) {
			return net.Dial(network, "127.0.0.1:"+port)
		},
	}
	proxy := httptest.NewServer(p)
	defer proxy.Close()

	connect := func(target string) (string, string) {
		c, err := net.Dial("tcp", strings.TrimPrefix(proxy.URL, "http://"))
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = c.Close() }()
		_, _ = io.WriteString(c, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\n\r\nhello\n")
		r := bufio.NewReader(c)
		res, err := http.ReadResponse(r, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = res.Body.Close() }()
		if res.StatusCode != http.StatusOK {
			return res.Status, ""
		}
		line, _ := r.ReadString('\n')
		return res.Status, line
	}
	if status, line := connect("bucket.test:" + port); !strings.HasPrefix(status, "200") || line != "echo hello\n" {
		t.Errorf("allowed host: %q %q", status, line)
	}
	if status, _ := connect("api.github.com:443"); !strings.HasPrefix(status, "403") {
		t.Errorf("other host: %q", status)
	}
	res, err := http.Get(proxy.URL + "/anything")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("plain HTTP proxied: %d", res.StatusCode)
	}
}
