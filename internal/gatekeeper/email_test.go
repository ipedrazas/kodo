package gatekeeper

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestEmailAccountChecksKeyAndFromAddress(t *testing.T) {
	f := newFakeResend(t)
	e := Email{APIURL: f.URL}
	ctx := context.Background()
	for _, tc := range []struct{ key, from, want, err string }{
		{resendKey, "alice@acme.test", "alice@acme.test", ""},
		{resendKey, "Alice <alice@ACME.test>", `"Alice" <alice@ACME.test>`, ""},
		{resendKey, "onboarding@resend.dev", "onboarding@resend.dev", ""},
		{"re_sending_only", "alice@anything.test", "alice@anything.test", ""},
		{resendKey, "alice@pending.test", "", "not verified pending.test"},
		{resendKey, "alice@other.test", "", "not verified other.test"},
		{"re_wrong", "alice@acme.test", "", "did not accept the key"},
		{resendKey, "", "", "give the From address"},
		{resendKey, "alice@acme.test\r\nBcc: x@y.z", "", "give the From address"},
	} {
		got, err := e.Account(ctx, tc.key, tc.from)
		if tc.err == "" && (err != nil || got != tc.want) {
			t.Errorf("%s %q: got %q, %v; want %q", tc.key, tc.from, got, err, tc.want)
		}
		if tc.err != "" && (err == nil || !strings.Contains(err.Error(), strings.Fields(tc.err)[len(strings.Fields(tc.err))-1])) {
			t.Errorf("%s %q: got %q, %v; want an error about %s", tc.key, tc.from, got, err, tc.err)
		}
	}
}

func TestEmailPrepareSendsOnlyTheMessageFromTheAccount(t *testing.T) {
	c, _ := ParseCapability(send)
	req, err := Email{APIURL: "https://resend.test"}.Prepare(context.Background(), c, CallRequest{
		Method:  "POST",
		Headers: map[string]string{"authorization": "Bearer stolen", "x-entity-ref-id": "1"},
		Body:    []byte(`{"to":["Bob <bob@example.com>","carol@example.com"],"cc":"dan@example.com","subject":"  Hi  ","html":"<p>x</p>"}`),
	}, `"Alice" <alice@acme.test>`)
	if err != nil {
		t.Fatal(err)
	}
	if req.URL.String() != "https://resend.test/emails" || req.Header.Get("Authorization") != "" || req.Header.Get("X-Entity-Ref-Id") != "" {
		t.Errorf("request %s %v", req.URL, req.Header)
	}
	raw, _ := io.ReadAll(req.Body)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	if body["from"] != `"Alice" <alice@acme.test>` || body["subject"] != "Hi" || body["html"] != "<p>x</p>" ||
		len(body["to"].([]any)) != 2 || body["cc"].([]any)[0] != "dan@example.com" || body["to"].([]any)[0] != `"Bob" <bob@example.com>` {
		t.Errorf("body %s", raw)
	}
	for _, other := range []string{"email:inbox:send", "email:outbox:read"} {
		c, _ := ParseCapability(other)
		if _, err := (Email{}).Prepare(context.Background(), c, CallRequest{Method: "POST", Body: []byte(draft)}, "a@b.c"); err == nil {
			t.Errorf("%s was allowed", other)
		}
	}
}
