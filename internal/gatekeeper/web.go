package gatekeeper

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// Web is the web provider: reads of public HTTPS APIs that need no
// credentials, such as hn.algolia.com. It knows one resource kind,
// <host>[/<path>], and one verb, read: GET and HEAD on
// https://<host>/<path> and everything under it. It is a platform provider
// with nothing to connect and no credentials to add, and only for the hosts
// the platform allows. Calls go only to public addresses, checked when the
// connection is made, so a grant cannot reach the cluster or the Gatekeeper's
// own network, whatever the name resolves to.
type Web struct {
	// Allow lists the hosts gadgets may read: a host, *.domain for any
	// subdomain, or * for any public host. Empty allows none.
	Allow []string
	// HTTP makes the calls; PublicClient if nil. Tests set it.
	HTTP *http.Client
}

var (
	webHost = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`)
	// Names that are not public, whatever they resolve to.
	privateSuffixes = []string{".local", ".localhost", ".internal", ".svc", ".cluster.local", ".lan", ".home.arpa"}
	// Request headers a gadget may set; everything else is dropped.
	webRequestHeaders = []string{"Accept", "Accept-Language", "If-None-Match", "If-Modified-Since"}
)

// webResource splits a web resource into its host and path prefix.
func webResource(resource string) (string, string, error) {
	host, path, _ := strings.Cut(resource, "/")
	if !webHost.MatchString(host) {
		return "", "", fmt.Errorf("web has no resource %q; use <host>[/<path>] with a DNS name", resource)
	}
	for _, s := range privateSuffixes {
		if strings.HasSuffix(host, s) {
			return "", "", fmt.Errorf("%s is not a public host", host)
		}
	}
	if path != "" {
		prefix, query, err := relativePath("/" + path)
		if err != nil || query != "" || strings.HasSuffix(prefix, "/") {
			return "", "", fmt.Errorf("web resource %q has an invalid path", resource)
		}
		path = prefix
	}
	return host, path, nil
}

// Allowed reports whether the platform allows reads of a host.
func (w Web) Allowed(host string) bool {
	for _, a := range w.Allow {
		a = strings.ToLower(strings.TrimSpace(a))
		if a == "*" || a == host || (strings.HasPrefix(a, "*.") && strings.HasSuffix(host, a[1:])) {
			return true
		}
	}
	return false
}

func (w Web) Prepare(ctx context.Context, c Capability, r CallRequest, _ string) (*http.Request, error) {
	host, prefix, err := webResource(c.Resource)
	if err != nil {
		return nil, err
	}
	if !w.Allowed(host) {
		return nil, fmt.Errorf("this platform does not allow reading %s", host)
	}
	if c.Verb != "read" {
		return nil, errors.New("web supports only the read verb")
	}
	if !readMethods[r.Method] {
		return nil, fmt.Errorf("%s is not a read; %s allows GET and HEAD", r.Method, c)
	}
	path, query, err := relativePath(r.Path)
	if err != nil {
		return nil, err
	}
	u := "https://" + host + prefix + path
	if query != "" {
		u += "?" + query
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, u, nil)
	if err != nil {
		return nil, fmt.Errorf("bad request: %w", err)
	}
	for _, h := range webRequestHeaders {
		if v := header(r.Headers, h); v != "" {
			req.Header.Set(h, v)
		}
	}
	req.Header.Set("User-Agent", "kodo-gatekeeper")
	return req, nil
}

// Attribute adds nothing: a public API learns nothing about who reads it.
func (w Web) Attribute(*http.Request, string, Call) {}

func (w Web) Authorize(*http.Request, string) {}

func (w Web) Account(context.Context, string, string) (string, error) {
	return "", errors.New("web needs no connection")
}

func (w Web) ResponseHeaders() []string {
	return []string{"Content-Type", "ETag", "Last-Modified", "Cache-Control", "Location"}
}

func (w Web) Describe(c Capability, r CallRequest, _ string) Summary {
	return Summary{Title: r.Method + " https://" + c.Resource + r.Path}
}

// Client is the client that makes the provider's calls.
func (w Web) Client() *http.Client {
	if w.HTTP != nil {
		return w.HTTP
	}
	return PublicClient(15 * time.Second)
}

// PublicClient is a client that connects only to public addresses, with no
// proxy, and returns redirects, which could leave the granted resource,
// instead of following them.
func PublicClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, Control: publicOnly}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:               nil,
			DialContext:         dialer.DialContext,
			TLSHandshakeTimeout: 10 * time.Second,
			MaxIdleConns:        20,
			IdleConnTimeout:     90 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

var errNotPublic = errors.New("not a public address")

// publicOnly refuses a connection to an address that is not public. It runs
// with the address actually dialled, after name resolution.
func publicOnly(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || !PublicIP(ip) {
		return fmt.Errorf("%s: %w", host, errNotPublic)
	}
	return nil
}

var nonPublicNets = func() []*net.IPNet {
	var nets []*net.IPNet
	for _, cidr := range []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15",
		"198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "64:ff9b::/96", "100::/64", "2001:db8::/32",
	} {
		_, n, _ := net.ParseCIDR(cidr)
		nets = append(nets, n)
	}
	return nets
}()

// PublicIP reports whether an address is on the public internet: not
// loopback, private, link-local, multicast, shared (CGNAT), reserved or
// documentation space.
func PublicIP(ip net.IP) bool {
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, n := range nonPublicNets {
		if n.Contains(ip) {
			return false
		}
	}
	return true
}
