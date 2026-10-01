package gatekeeper

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ipedrazas/kodo/internal/vault"
)

const (
	testToken = "ghp_secret-token-value"
	fleetKey  = "0123456789abcdef0123456789abcdef"
	alice     = "sub-alice"
)

// fakeVault "encrypts" by tagging the plaintext with its context, and refuses
// to decrypt under another context, as transit's derived keys do.
type fakeVault struct{}

func (fakeVault) Encrypt(_ context.Context, ctx, plain []byte) (string, error) {
	return "fake:v1:" + base64.StdEncoding.EncodeToString(append(append(ctx, 0), plain...)), nil
}

func (fakeVault) Decrypt(_ context.Context, ctx []byte, ciphertext string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(ciphertext, "fake:v1:"))
	if err != nil {
		return nil, err
	}
	c, plain, _ := bytes.Cut(raw, []byte{0})
	if !bytes.Equal(c, ctx) {
		return nil, vault.ErrDenied
	}
	return plain, nil
}

type fakeUsers map[string]User

func (f fakeUsers) Identify(r *http.Request) (User, error) {
	u, ok := f[r.Header.Get(IdentityHeader)]
	if !ok {
		return User{}, errors.New("no such user")
	}
	return u, nil
}

type harness struct {
	t        *testing.T
	store    *MemStore
	srv      *Server
	internal *httptest.Server
	public   *httptest.Server
	upstream []string // requests GitHub received, "METHOD path auth"
}

func newHarness(t *testing.T) *harness {
	h := &harness{t: t, store: NewMemStore()}
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.upstream = append(h.upstream, r.Method+" "+r.URL.RequestURI()+" "+r.Header.Get("Authorization"))
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			http.Error(w, "bad credentials", http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/user" {
			_, _ = w.Write([]byte(`{"login":"octocat"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "upstream=1")
		w.Header().Set("ETag", `"abc"`)
		_, _ = w.Write([]byte(`{"path":"` + r.URL.Path + `"}`))
	}))
	t.Cleanup(github.Close)

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "kodo.prod"), []byte(fleetKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.srv = &Server{
		Trust:     Trust{Dir: dir},
		Tokens:    Tokens{Store: h.store, Vault: fakeVault{}},
		Audit:     Audit{Store: h.store},
		Providers: map[string]Provider{"github": GitHub{APIURL: github.URL}},
		Users:     fakeUsers{"alice-token": {Sub: alice, Email: "alice@test"}},
		Upstream:  NoRedirects(5 * time.Second),
		Log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	h.internal = httptest.NewServer(h.srv.Internal())
	h.public = httptest.NewServer(h.srv.Public())
	t.Cleanup(h.internal.Close)
	t.Cleanup(h.public.Close)
	return h
}

// connect stores a GitHub token for alice and returns the HTTP status.
func (h *harness) connect(token string) int {
	req, _ := http.NewRequest(http.MethodPut, h.public.URL+"/gatekeeper/api/connections/github",
		strings.NewReader(`{"token":"`+token+`"}`))
	req.Header.Set(IdentityHeader, "alice-token")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.StatusCode
}

// call signs and sends a call as fleet kodo/prod, or with the given key.
func (h *harness) call(c Call, key string) (int, Answer) {
	body, _ := json.Marshal(c)
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	req, _ := http.NewRequest(http.MethodPost, h.internal.URL+"/v1/calls", bytes.NewReader(body))
	req.Header.Set(FleetHeader, "kodo/prod")
	req.Header.Set(TimestampHeader, ts)
	req.Header.Set(SignatureHeader, SignatureFor([]byte(key), ts, body))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var a Answer
	if res.StatusCode == http.StatusOK {
		if err := json.NewDecoder(res.Body).Decode(&a); err != nil {
			h.t.Fatal(err)
		}
	}
	return res.StatusCode, a
}

func (h *harness) audit() []Record {
	keys, _ := h.store.List(context.Background(), "audit/")
	var out []Record
	for _, k := range keys {
		data, _ := h.store.Get(context.Background(), k)
		var r Record
		_ = json.Unmarshal(data, &r)
		out = append(out, r)
	}
	return out
}

func readCall(capability, method, path string, grants ...string) Call {
	return Call{
		Workspace: "team", Cell: "cabc", Blueprint: "viewer", Version: "1",
		Owner: Owner{User: alice, Email: "alice@test"}, Grants: grants, Capability: capability,
		Request: CallRequest{Method: method, Path: path},
	}
}

const granted = "github:repo/acme/api:read"

func TestCallWithinGrantReadsWithTheOwnersToken(t *testing.T) {
	h := newHarness(t)
	if status := h.connect(testToken); status != http.StatusOK {
		t.Fatalf("connect: %d", status)
	}
	status, a := h.call(readCall(granted, "GET", "/readme", granted), fleetKey)
	if status != http.StatusOK || a.Status != http.StatusOK {
		t.Fatalf("got %d %+v", status, a)
	}
	if string(a.Body) != `{"path":"/repos/acme/api/readme"}` {
		t.Errorf("body %s", a.Body)
	}
	if a.Headers["x-kodo-decision"] != Allowed || a.Headers["etag"] != `"abc"` {
		t.Errorf("headers %v", a.Headers)
	}
	if _, ok := a.Headers["set-cookie"]; ok {
		t.Errorf("upstream cookie reached the gadget")
	}
	for _, v := range a.Headers {
		if strings.Contains(v, testToken) {
			t.Fatal("token in a response header")
		}
	}
	records := h.audit()
	last := records[len(records)-1]
	if last.Decision != Allowed || last.Cell != "cabc" || last.Grant != granted || last.User != alice ||
		last.Blueprint != "viewer" || last.Fleet != "kodo/prod" || last.Workspace != "team" {
		t.Errorf("audit record %+v", last)
	}
}

func TestCallsOutsideTheGrantAreDeniedAndRecorded(t *testing.T) {
	h := newHarness(t)
	h.connect(testToken)
	before := len(h.upstream)
	for name, c := range map[string]Call{
		"another repo":     readCall("github:repo/acme/other:read", "GET", "", granted),
		"another verb":     readCall(granted, "POST", "/issues", granted),
		"write capability": readCall("github:repo/acme/api:write", "POST", "/issues", granted, "github:repo/acme/api:write"),
		"no grants":        readCall(granted, "GET", ""),
		"path escape":      readCall(granted, "GET", "/../../other/x", granted),
		"unknown provider": readCall("gmail:inbox:read", "GET", "", "gmail:inbox:read"),
	} {
		status, a := h.call(c, fleetKey)
		if status != http.StatusOK || a.Status != http.StatusForbidden || a.Headers["x-kodo-decision"] != Denied {
			t.Errorf("%s: got %d %+v", name, status, a)
		}
	}
	if len(h.upstream) != before {
		t.Errorf("denied calls reached GitHub: %v", h.upstream[before:])
	}
	denied := 0
	for _, r := range h.audit() {
		if r.Decision == Denied && r.Reason != "" && r.Cell == "cabc" {
			denied++
		}
	}
	if denied != 6 {
		t.Errorf("%d denials recorded, want 6", denied)
	}
}

func TestCallForAnOwnerWithoutAConnectionIsDenied(t *testing.T) {
	h := newHarness(t)
	_, a := h.call(readCall(granted, "GET", "", granted), fleetKey)
	if a.Status != http.StatusForbidden || !strings.Contains(string(a.Body), "not connected github") {
		t.Fatalf("got %+v", a)
	}
}

func TestUntrustedCallsAreRejected(t *testing.T) {
	h := newHarness(t)
	h.connect(testToken)
	c := readCall(granted, "GET", "", granted)
	if status, _ := h.call(c, "not the fleet key"); status != http.StatusUnauthorized {
		t.Errorf("wrong key: %d", status)
	}

	body, _ := json.Marshal(c)
	send := func(fleet, ts, sig string) int {
		req, _ := http.NewRequest(http.MethodPost, h.internal.URL+"/v1/calls", bytes.NewReader(body))
		req.Header.Set(FleetHeader, fleet)
		req.Header.Set(TimestampHeader, ts)
		req.Header.Set(SignatureHeader, sig)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		return res.StatusCode
	}
	now := strconv.FormatInt(time.Now().Unix(), 10)
	old := strconv.FormatInt(time.Now().Add(-5*time.Minute).Unix(), 10)
	cases := map[string]int{
		"unknown fleet": send("kodo/other", now, SignatureFor([]byte(fleetKey), now, body)),
		"stale":         send("kodo/prod", old, SignatureFor([]byte(fleetKey), old, body)),
		"no signature":  send("kodo/prod", now, ""),
		"bad fleet":     send("../prod", now, SignatureFor([]byte(fleetKey), now, body)),
	}
	for name, status := range cases {
		if status != http.StatusUnauthorized {
			t.Errorf("%s: %d", name, status)
		}
	}
	rejected := 0
	for _, r := range h.audit() {
		if r.Decision == Rejected {
			rejected++
		}
	}
	if rejected != 5 {
		t.Errorf("%d rejections recorded, want 5", rejected)
	}
	if len(h.upstream) != 1 { // only the /user check when connecting
		t.Errorf("untrusted calls reached GitHub: %v", h.upstream)
	}
}

func TestTokensAreStoredOnlyAsCiphertext(t *testing.T) {
	h := newHarness(t)
	h.connect(testToken)
	keys, _ := h.store.List(context.Background(), "")
	for _, k := range keys {
		data, _ := h.store.Get(context.Background(), k)
		if strings.Contains(string(data), testToken) {
			t.Errorf("%s holds the plaintext token", k)
		}
	}
	data, err := h.store.Get(context.Background(), tokenKey(alice, "github"))
	if err != nil || !strings.Contains(string(data), `"ciphertext":"fake:v1:`) {
		t.Fatalf("stored connection: %s, %v", data, err)
	}

	// A ciphertext moved to another user's key does not decrypt.
	if err := h.store.Put(context.Background(), tokenKey("sub-mallory", "github"), data); err != nil {
		t.Fatal(err)
	}
	if _, err := h.srv.Tokens.Token(context.Background(), "sub-mallory", "github"); err == nil {
		t.Error("alice's ciphertext decrypted for mallory")
	}
}

func TestConnectionsAPI(t *testing.T) {
	h := newHarness(t)
	if status := h.connect("wrong-token"); status != http.StatusBadRequest {
		t.Errorf("a token GitHub rejects was stored: %d", status)
	}
	if status := h.connect(testToken); status != http.StatusOK {
		t.Fatalf("connect: %d", status)
	}
	do := func(method, path, identity, origin string) (int, string) {
		req, _ := http.NewRequest(method, h.public.URL+path, nil)
		if identity != "" {
			req.Header.Set(IdentityHeader, identity)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = res.Body.Close() }()
		var b bytes.Buffer
		_, _ = b.ReadFrom(res.Body)
		return res.StatusCode, b.String()
	}
	status, body := do("GET", "/gatekeeper/api/connections", "alice-token", "")
	if status != http.StatusOK || !strings.Contains(body, `"account":"octocat"`) || strings.Contains(body, "ciphertext") {
		t.Errorf("list: %d %s", status, body)
	}
	if status, _ := do("GET", "/gatekeeper/api/connections", "", ""); status != http.StatusUnauthorized {
		t.Errorf("anonymous list: %d", status)
	}
	if status, _ := do("DELETE", "/gatekeeper/api/connections/github", "alice-token", "https://evil.test"); status != http.StatusForbidden {
		t.Errorf("cross-origin delete: %d", status)
	}
	if status, _ := do("DELETE", "/gatekeeper/api/connections/github", "alice-token", ""); status != http.StatusNoContent {
		t.Errorf("delete: %d", status)
	}
	if _, err := h.srv.Tokens.Token(context.Background(), alice, "github"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("token still there: %v", err)
	}
	if status, body := do("GET", "/gatekeeper/", "", ""); status != http.StatusOK || !strings.Contains(body, "<title>kodo connections") {
		t.Errorf("page: %d", status)
	}
}

func TestAuditUnavailableFailsClosed(t *testing.T) {
	h := newHarness(t)
	h.connect(testToken)
	h.srv.Audit = Audit{Store: failingStore{h.store}}
	before := len(h.upstream)
	_, a := h.call(readCall(granted, "GET", "", granted), fleetKey)
	if a.Status != http.StatusServiceUnavailable || len(h.upstream) != before {
		t.Fatalf("call made without an audit record: %+v", a)
	}
}

type failingStore struct{ Store }

func (failingStore) Create(context.Context, string, []byte) error { return errors.New("bucket down") }
