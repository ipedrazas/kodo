package agent

import (
	"fmt"
	"strings"
)

// Tools the agent's model may call.
var tools = []map[string]any{
	{
		"type": "function",
		"function": map[string]any{
			"name": "run_code",
			"description": "Run JavaScript in a fresh sandbox with this session's capabilities. The code is the body " +
				"of an async function: use await, and return a JSON value. Answers {ok, value, error, logs, approvals}. " +
				"Nothing survives between runs.",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"code": map[string]any{"type": "string", "description": "The body of an async JavaScript function."},
				},
				"required": []string{"code"},
			},
		},
	},
	{
		"type": "function",
		"function": map[string]any{
			"name":        "read_doc",
			"description": "Read one of the workspace's markdown documents, by its path.",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path": map[string]any{"type": "string", "description": "e.g. skills/email.md"},
				},
				"required": []string{"path"},
			},
		},
	},
}

// systemPrompt tells the model who it works for, what its code can use and
// which documents it can read.
func systemPrompt(s Session, docs []Doc, app, model string) string {
	var b strings.Builder
	fmt.Fprintf(&b, `You are the kodo agent, working for %s in the workspace %q. You answer questions and do tasks by writing JavaScript and running it with the run_code tool, then telling the user what came of it.

## Running code

run_code runs the body of an async JavaScript function in a fresh sandbox and answers {ok, value, error, logs, approvals}. Return what you need as JSON; console.log output comes back in logs. The code can use:

- grants: one object per capability below, keyed by the capability string. grants[cap].fetch(path, {method, headers, body}) makes a call within that capability and returns {status, ok, headers, text(), json()} (text and json are async). path is relative to the capability's resource; body is a string or a JSON value.
- Date, Math, JSON, URL, URLSearchParams, atob, btoa, crypto.randomUUID(), and the standard built-ins.

There is no fetch, no timers, no ArrayBuffer, typed arrays, TextEncoder or TextDecoder, and nothing reaches the network except through grants. A run may take 60 s and 2 s of CPU, and make 20 calls through grants. Nothing is kept between runs.

## Capabilities this session holds
`, ownerName(s.Owner), s.Workspace)
	reach := 0
	for _, g := range s.Grants {
		fmt.Fprintf(&b, "\n- %s\n  %s\n", g, describeGrant(g, app))
		if g != modelCapability(model) {
			reach++
		}
	}
	if reach == 0 {
		b.WriteString("\nNothing besides your own model: code can compute, but not reach anything.\n")
	}
	fmt.Fprintf(&b, `
If a task needs a capability the session does not hold, say exactly which one (for example github:repo/OWNER/REPO:read) and ask the user to grant it in this chat's settings at %s/chat/. Never pretend a call succeeded.

Calls that send, write or delete do not happen at once: they answer 202 and wait for the user's approval at %s/gatekeeper/. Tell the user what is waiting; the chat will say when it is approved or rejected.
`, app, app)
	if len(docs) > 0 {
		b.WriteString("\n## Workspace documents\n\nRead one with read_doc before relying on what it covers.\n\n")
		for _, d := range docs {
			if d.Description != "" {
				fmt.Fprintf(&b, "- %s: %s\n", d.Path, d.Description)
			} else {
				fmt.Fprintf(&b, "- %s\n", d.Path)
			}
		}
	}
	b.WriteString("\nBe brief. Give the answer, not the code, unless the user asks for the code.\n")
	return b.String()
}

// modelCapability is the grant that lets a session call a model.
func modelCapability(model string) string { return "inference:model/" + model + ":invoke" }

func ownerName(o Owner) string {
	if o.Email != "" {
		return o.Email
	}
	return "the session's owner"
}

// describeGrant says how the code uses a capability.
func describeGrant(capability, app string) string {
	provider, rest, _ := strings.Cut(capability, ":")
	verbAt := strings.LastIndex(rest, ":")
	resource, verb := rest, ""
	if verbAt >= 0 {
		resource, verb = rest[:verbAt], rest[verbAt+1:]
	}
	switch provider {
	case "github":
		return fmt.Sprintf("GET on https://api.github.com/repos/%s and anything under it, with the user's GitHub access; "+
			`e.g. fetch("/issues?state=open") or fetch("/readme", {headers: {accept: "application/vnd.github.raw+json"}}).`,
			strings.TrimPrefix(resource, "repo/"))
	case "web":
		return fmt.Sprintf(`GET on https://%s and anything under it, a public API; e.g. fetch("/search?query=x").`, resource)
	case "email":
		return `POST "" with a JSON body {to, cc, bcc, subject, text, html} to send an email from the user's address. ` +
			fmt.Sprintf("It waits for the user's approval at %s/gatekeeper/: it answers 202 with the approval's id in headers[\"x-kodo-approval\"].", app)
	case "inference":
		return fmt.Sprintf(`POST "/chat/completions" with an OpenAI chat completion body {messages, max_tokens}, to the model %q. `+
			"Answers within 20 s; keep max_tokens modest.", strings.TrimPrefix(resource, "model/"))
	}
	switch verb {
	case "read":
		return "Read calls (GET) within " + resource + "."
	case "write", "send", "delete":
		return "Calls that " + verb + " within " + resource + "; each waits for the user's approval."
	}
	return "Calls within " + resource + "."
}
