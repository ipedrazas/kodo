package gatekeeper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"strings"
)

// Email is the email provider, sending through Resend with each user's own
// API key. It knows one resource, outbox, and one verb, send: a POST of
//
//	{"to": ..., "cc": ..., "bcc": ..., "reply_to": ..., "subject": "...", "text": "...", "html": "..."}
//
// where each address field is an address or a list of them. The message is
// sent from the address the user connected with; a gadget cannot set the
// sender or any other header. Sends wait for approval like every other
// side-effecting call.
type Email struct {
	// APIURL is Resend's base URL; https://api.resend.com if empty.
	APIURL string
	// HTTP is the client Account uses.
	HTTP *http.Client
}

const (
	maxRecipients  = 50
	maxSubject     = 998
	maxMessageBody = 1 << 20
)

// emailMessage is what a gadget sends. Unknown fields are refused.
type emailMessage struct {
	To      addressList `json:"to"`
	Cc      addressList `json:"cc,omitempty"`
	Bcc     addressList `json:"bcc,omitempty"`
	ReplyTo addressList `json:"reply_to,omitempty"`
	Subject string      `json:"subject"`
	Text    string      `json:"text,omitempty"`
	HTML    string      `json:"html,omitempty"`
}

// addressList is one address or a list of them.
type addressList []string

func (l *addressList) UnmarshalJSON(b []byte) error {
	var one string
	if json.Unmarshal(b, &one) == nil {
		*l = addressList{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return errors.New("an address field must be a string or a list of strings")
	}
	*l = many
	return nil
}

func (e Email) base() string {
	if e.APIURL == "" {
		return "https://api.resend.com"
	}
	return strings.TrimSuffix(e.APIURL, "/")
}

// message checks a gadget's request and returns the message it sends.
func (e Email) message(c Capability, r CallRequest) (emailMessage, error) {
	var m emailMessage
	if c.Resource != "outbox" {
		return m, fmt.Errorf("email has no resource %q; use outbox", c.Resource)
	}
	if c.Verb != "send" {
		return m, errors.New("email supports only the send verb")
	}
	if r.Method != http.MethodPost {
		return m, fmt.Errorf("%s sends with POST, not %s", c, r.Method)
	}
	if r.Path != "" && r.Path != "/" {
		return m, fmt.Errorf("%s takes no path", c)
	}
	if len(r.Body) > maxMessageBody {
		return m, errors.New("message larger than 1 MiB")
	}
	dec := json.NewDecoder(bytes.NewReader(r.Body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return m, fmt.Errorf("body must be a message {to, cc, bcc, reply_to, subject, text, html}: %w", err)
	}
	if dec.More() {
		return m, errors.New("body must be one JSON object")
	}
	var err error
	for _, list := range []*addressList{&m.To, &m.Cc, &m.Bcc, &m.ReplyTo} {
		if *list, err = addresses(*list); err != nil {
			return m, err
		}
	}
	if len(m.To) == 0 {
		return m, errors.New("a message needs at least one address in to")
	}
	if n := len(m.To) + len(m.Cc) + len(m.Bcc); n > maxRecipients {
		return m, fmt.Errorf("%d recipients; at most %d", n, maxRecipients)
	}
	m.Subject = strings.TrimSpace(m.Subject)
	if m.Subject == "" || len(m.Subject) > maxSubject || strings.ContainsAny(m.Subject, "\r\n\x00") {
		return m, errors.New("subject must be one line of at most 998 bytes")
	}
	if m.Text == "" && m.HTML == "" {
		return m, errors.New("a message needs text or html")
	}
	return m, nil
}

// addresses checks each address and returns them in canonical form.
func addresses(list addressList) (addressList, error) {
	out := make(addressList, 0, len(list))
	for _, a := range list {
		addr, err := mail.ParseAddress(a)
		if err != nil || strings.ContainsAny(a, "\r\n") {
			return nil, fmt.Errorf("%q is not an email address", a)
		}
		out = append(out, addr.String())
	}
	return out, nil
}

func (e Email) Prepare(ctx context.Context, c Capability, r CallRequest, account string) (*http.Request, error) {
	m, err := e.message(c, r)
	if err != nil {
		return nil, err
	}
	if account == "" {
		return nil, errors.New("the email connection has no From address")
	}
	body, err := json.Marshal(struct {
		From string `json:"from"`
		emailMessage
	}{account, m})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.base()+"/emails", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "kodo-gatekeeper")
	return req, nil
}

func (e Email) Authorize(req *http.Request, token string) {
	req.Header.Set("Authorization", "Bearer "+token)
}

func (e Email) AccountPrompt() string { return "From address" }

// Account checks the API key and the From address the user chose. With a
// full-access key, the address's domain must be verified in Resend; a
// sending-only key cannot list domains, so Resend checks the address when
// it sends.
func (e Email) Account(ctx context.Context, token, requested string) (string, error) {
	from, err := mail.ParseAddress(requested)
	if err != nil || strings.ContainsAny(requested, "\r\n") {
		return "", errors.New("give the From address to send as, e.g. you@example.com")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.base()+"/domains", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "kodo-gatekeeper")
	e.Authorize(req, token)
	client := e.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var answer struct {
		Name    string `json:"name"`
		Message string `json:"message"`
		Data    []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"data"`
	}
	_ = json.Unmarshal(body, &answer)
	switch {
	case res.StatusCode == http.StatusOK:
		_, domain, _ := strings.Cut(from.Address, "@")
		domain = strings.ToLower(domain)
		verified := domain == "resend.dev"
		for _, d := range answer.Data {
			if strings.EqualFold(d.Name, domain) && d.Status == "verified" {
				verified = true
			}
		}
		if !verified {
			return "", fmt.Errorf("resend has not verified %s for this key", domain)
		}
	case res.StatusCode == http.StatusUnauthorized && answer.Name == "restricted_api_key":
		// A sending-only key: valid, but it cannot list domains.
	default:
		return "", fmt.Errorf("resend did not accept the key: %s", res.Status)
	}
	return from.String(), nil
}

func (e Email) Describe(c Capability, r CallRequest, account string) Summary {
	m, err := e.message(c, r)
	if err != nil {
		return Summary{Title: "Send an email", Body: string(r.Body)}
	}
	fields := []Field{{"From", account}, {"To", strings.Join(m.To, ", ")}}
	for _, f := range []Field{{"Cc", strings.Join(m.Cc, ", ")}, {"Bcc", strings.Join(m.Bcc, ", ")}, {"Reply-To", strings.Join(m.ReplyTo, ", ")}} {
		if f.Value != "" {
			fields = append(fields, f)
		}
	}
	fields = append(fields, Field{"Subject", m.Subject})
	body := m.Text
	if m.HTML != "" {
		if body != "" {
			body += "\n\n"
		}
		body += "HTML version:\n" + m.HTML
	}
	return Summary{Title: "Send an email", Fields: fields, Body: body}
}

func (e Email) ResponseHeaders() []string { return []string{"Content-Type"} }
