// Command gatekeeper makes the external calls kodo gadgets are granted, with
// their owners' tokens from the vault, and records every decision. It also
// runs the egress proxy that is the only way out of a fleet with default-deny
// egress. It runs outside every fleet and holds no state of its own: tokens
// (as ciphertext) and the audit log are objects in its bucket.
//
// Configuration is from the environment:
//
//	GATEKEEPER_PUBLIC_ADDR    users, behind the gateway (default :8080)
//	GATEKEEPER_INTERNAL_ADDR  kernels (default :8081)
//	GATEKEEPER_EGRESS_ADDR    the fleets' egress proxy (default :8082)
//	GATEKEEPER_EGRESS_ALLOW   hosts it tunnels to: host:port or *.domain:port, comma-separated
//	GATEKEEPER_TRUST_DIR      one key file per trusted fleet (default /etc/kodo/fleets)
//	GATEKEEPER_BUCKET         bucket[/prefix] for vault/ and audit/
//	S3_ENDPOINT, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//	OIDC_ISSUER, OIDC_AUDIENCE, OIDC_JWKS_URL   who users are
//	OPENBAO_ADDR              OpenBao, for its transit engine
//	OPENBAO_TRANSIT_MOUNT     default transit
//	OPENBAO_TRANSIT_KEY       default kodo-gatekeeper
//	OPENBAO_AUTH              approle (default), kubernetes or token
//	OPENBAO_AUTH_MOUNT        the auth method's mount; default its name
//	OPENBAO_ROLE_ID and OPENBAO_SECRET_ID or OPENBAO_SECRET_ID_FILE   approle
//	OPENBAO_ROLE              kubernetes
//	OPENBAO_TOKEN             token (development only)
//	GITHUB_API_URL            default https://api.github.com
//	RESEND_API_URL            the email provider's API; default https://api.resend.com
//	GATEKEEPER_WEB_ALLOW      hosts gadgets may read public APIs of (the web provider): host,
//	                          *.domain or *, comma-separated; without it there is no web provider
//	INFERENCE_URL             the inference gateway, e.g. http://kodo-inference.envoy-gateway-system.svc;
//	                          without it there is no inference provider
//	INFERENCE_KEY_FILE        a file holding the key the inference gateway requires, read once at
//	                          start; if it does not exist, no key is sent
//	INFERENCE_TIMEOUT         how long a model call may take (default 20s)
//	GATEKEEPER_APPROVAL_TTL   how long a call waits for approval (default 168h)
//	GATEKEEPER_APPROVAL_STALE how long an approval may be executing before it
//	                          is reported failed (default 1m; keep it well above
//	                          the 15 s upstream timeout)
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/ipedrazas/kodo/internal/gatekeeper"
	"github.com/ipedrazas/kodo/internal/vault"
	"github.com/ipedrazas/kodo/internal/version"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log)
	if err := run(log); err != nil {
		log.Error("gatekeeper stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	bucket := os.Getenv("GATEKEEPER_BUCKET")
	if bucket == "" {
		return errors.New("GATEKEEPER_BUCKET is required")
	}
	store := gatekeeper.NewS3Store(gatekeeper.S3Config{
		Bucket:    bucket,
		Endpoint:  os.Getenv("S3_ENDPOINT"),
		Region:    os.Getenv("AWS_REGION"),
		AccessKey: os.Getenv("AWS_ACCESS_KEY_ID"),
		SecretKey: os.Getenv("AWS_SECRET_ACCESS_KEY"),
	})
	transit, err := openBao()
	if err != nil {
		return err
	}

	var users gatekeeper.Users
	if issuer := os.Getenv("OIDC_ISSUER"); issuer != "" {
		jwks := env("OIDC_JWKS_URL", strings.TrimSuffix(issuer, "/")+"/keys")
		users = gatekeeper.NewOIDCUsers(ctx, issuer, os.Getenv("OIDC_AUDIENCE"), jwks)
	} else {
		log.Warn("OIDC_ISSUER is not set: users cannot connect accounts")
	}

	ttl, err := duration("GATEKEEPER_APPROVAL_TTL", gatekeeper.DefaultApprovalTTL)
	if err != nil {
		return err
	}
	stale, err := duration("GATEKEEPER_APPROVAL_STALE", gatekeeper.DefaultApprovalStale)
	if err != nil {
		return err
	}

	client := &http.Client{Timeout: 15 * time.Second}
	providers := map[string]gatekeeper.Provider{
		"github": gatekeeper.GitHub{APIURL: os.Getenv("GITHUB_API_URL"), HTTP: client},
		"email":  gatekeeper.Email{APIURL: os.Getenv("RESEND_API_URL"), HTTP: client},
	}
	inference, err := inferenceProvider()
	if err != nil {
		return err
	}
	if inference.URL != "" {
		providers["inference"] = inference
	}
	webAllow := list(os.Getenv("GATEKEEPER_WEB_ALLOW"))
	if len(webAllow) > 0 {
		providers["web"] = gatekeeper.Web{Allow: webAllow, HTTP: gatekeeper.PublicClient(time.Minute)}
	}
	srv := &gatekeeper.Server{
		Trust:     gatekeeper.Trust{Dir: env("GATEKEEPER_TRUST_DIR", "/etc/kodo/fleets")},
		Tokens:    gatekeeper.Tokens{Store: store, Vault: transit},
		Audit:     gatekeeper.Audit{Store: store},
		Approvals: gatekeeper.Approvals{Store: store, TTL: ttl, Stale: stale},
		Providers: providers,
		Users:     users,
		Upstream:  gatekeeper.NoRedirects(time.Minute),
		Log:       log,
	}

	allow := list(os.Getenv("GATEKEEPER_EGRESS_ALLOW"))
	egress := &gatekeeper.EgressProxy{Allow: allow, Log: log}

	servers := []*http.Server{
		{Addr: env("GATEKEEPER_PUBLIC_ADDR", ":8080"), Handler: srv.Public(), ReadHeaderTimeout: 10 * time.Second},
		{Addr: env("GATEKEEPER_INTERNAL_ADDR", ":8081"), Handler: srv.Internal(), ReadHeaderTimeout: 10 * time.Second},
		{Addr: env("GATEKEEPER_EGRESS_ADDR", ":8082"), Handler: egress, ReadHeaderTimeout: 10 * time.Second},
	}
	errs := make(chan error, len(servers))
	for _, s := range servers {
		go func() { errs <- s.ListenAndServe() }()
	}
	log.Info("gatekeeper serving", "version", version.String(), "public", servers[0].Addr, "internal", servers[1].Addr,
		"egress", servers[2].Addr, "egress_allow", allow, "bucket", bucket, "openbao", transit.Addr,
		"approval_ttl", ttl.String(), "approval_stale", stale.String(), "inference", inference.URL, "web_allow", webAllow)

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(shutdown)
	}
	return nil
}

func inferenceProvider() (gatekeeper.Inference, error) {
	timeout, err := duration("INFERENCE_TIMEOUT", gatekeeper.DefaultInferenceTimeout)
	if err != nil {
		return gatekeeper.Inference{}, err
	}
	i := gatekeeper.Inference{URL: os.Getenv("INFERENCE_URL"), Timeout: timeout}
	// A missing file means the gateway needs no key.
	if file := os.Getenv("INFERENCE_KEY_FILE"); file != "" {
		key, err := os.ReadFile(file)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return i, fmt.Errorf("INFERENCE_KEY_FILE: %w", err)
		}
		i.Key = strings.TrimSpace(string(key))
	}
	return i, nil
}

func openBao() (*vault.Transit, error) {
	addr := os.Getenv("OPENBAO_ADDR")
	if addr == "" {
		return nil, errors.New("OPENBAO_ADDR is required")
	}
	t := &vault.Transit{
		Addr:  addr,
		Mount: env("OPENBAO_TRANSIT_MOUNT", "transit"),
		Key:   env("OPENBAO_TRANSIT_KEY", "kodo-gatekeeper"),
		HTTP:  &http.Client{Timeout: 10 * time.Second},
	}
	mount := os.Getenv("OPENBAO_AUTH_MOUNT")
	switch method := env("OPENBAO_AUTH", "approle"); method {
	case "approle":
		a := vault.AppRole{
			Mount:        mount,
			RoleID:       os.Getenv("OPENBAO_ROLE_ID"),
			SecretID:     os.Getenv("OPENBAO_SECRET_ID"),
			SecretIDFile: os.Getenv("OPENBAO_SECRET_ID_FILE"),
		}
		if a.RoleID == "" || (a.SecretID == "" && a.SecretIDFile == "") {
			return nil, errors.New("approle needs OPENBAO_ROLE_ID and OPENBAO_SECRET_ID or OPENBAO_SECRET_ID_FILE")
		}
		t.Login = a
	case "kubernetes":
		role := os.Getenv("OPENBAO_ROLE")
		if role == "" {
			return nil, errors.New("kubernetes auth needs OPENBAO_ROLE")
		}
		t.Login = vault.Kubernetes{Mount: mount, Role: role}
	case "token":
		t.Login = vault.StaticToken(os.Getenv("OPENBAO_TOKEN"))
	default:
		return nil, fmt.Errorf("unknown OPENBAO_AUTH %q", method)
	}
	return t, nil
}

// list splits a comma-separated setting.
func list(v string) []string {
	var out []string
	for _, a := range strings.Split(v, ",") {
		if a = strings.TrimSpace(a); a != "" {
			out = append(out, a)
		}
	}
	return out
}

func duration(name string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(name)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("%s: %q is not a positive duration", name, v)
	}
	return d, nil
}

func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}
