package gatekeeper

import (
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// EgressProxy is the one way out of a fleet with default-deny egress: an
// HTTP CONNECT proxy that opens tunnels only to the hosts it allows, such as
// the bucket endpoint. Fleet nodes reach it through HTTPS_PROXY, which the
// operator sets. It does not proxy plain HTTP.
type EgressProxy struct {
	// Allow is a list of host:port, or *.domain:port for any subdomain.
	Allow []string
	Log   *slog.Logger
	// Dial opens the upstream connection; net.Dialer with a 10 s timeout if nil.
	Dial func(network, addr string) (net.Conn, error)
}

// Allowed reports whether a CONNECT target is on the allowlist.
func (p *EgressProxy) Allowed(target string) bool {
	host, port, err := net.SplitHostPort(target)
	if err != nil {
		return false
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, a := range p.Allow {
		ah, ap, err := net.SplitHostPort(strings.TrimSpace(a))
		if err != nil || ap != port {
			continue
		}
		ah = strings.ToLower(ah)
		if ah == host || (strings.HasPrefix(ah, "*.") && strings.HasSuffix(host, ah[1:]) && len(host) > len(ah)-1) {
			return true
		}
	}
	return false
}

func (p *EgressProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	log := p.Log
	if log == nil {
		log = slog.Default()
	}
	if r.Method != http.MethodConnect {
		http.Error(w, "only CONNECT is proxied", http.StatusMethodNotAllowed)
		return
	}
	if !p.Allowed(r.Host) {
		log.Info("egress", "decision", Denied, "target", r.Host, "from", r.RemoteAddr)
		http.Error(w, "egress to "+r.Host+" is not allowed", http.StatusForbidden)
		return
	}
	dial := p.Dial
	if dial == nil {
		dial = (&net.Dialer{Timeout: 10 * time.Second}).Dial
	}
	upstream, err := dial("tcp", r.Host)
	if err != nil {
		log.Warn("egress", "decision", "failed", "target", r.Host, "err", err)
		http.Error(w, "cannot reach "+r.Host, http.StatusBadGateway)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		_ = upstream.Close()
		http.Error(w, "tunnels not supported", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		_ = upstream.Close()
		return
	}
	_, _ = client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
	// Bytes the client sent after the CONNECT, already read into the buffer.
	if n := buffered.Reader.Buffered(); n > 0 {
		b, _ := buffered.Peek(n)
		_, _ = upstream.Write(b)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	pipe := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if c, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		} else {
			_ = dst.Close()
		}
	}
	go pipe(upstream, client)
	go pipe(client, upstream)
	wg.Wait()
	_ = upstream.Close()
	_ = client.Close()
}
