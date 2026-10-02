package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Config is how the agent works.
type Config struct {
	// The model the agent thinks with: a session needs the grant
	// inference:model/<Model>:invoke, which new sessions get.
	Model string
	// Model calls per turn, at most.
	MaxSteps int
	// max_tokens of each model call.
	MaxTokens int
}

// What goes to the model from the transcript: the latest messages, and of
// each tool result only its beginning.
const (
	contextMessages = 60
	contextBytes    = 200 << 10
	toolResultBytes = 12 << 10
	docBytes        = 64 << 10
)

// saying is what the agent tells the user instead of an answer, when it
// cannot give one.
type saying string

func (s saying) Error() string { return string(s) }

func say(format string, args ...any) error { return saying(fmt.Sprintf(format, args...)) }

// turn is one turn of a session, worked through with its token.
type turn struct {
	kernel  *Kernel
	config  Config
	log     *slog.Logger
	app     string
	ws, id  string
	auth    Auth
	session Session
	docs    []Doc
}

// run works through the turn: it asks the model, runs the tools it calls,
// and repeats until the model answers without calling one, or runs out of
// steps. Every message goes to the transcript as it happens.
func (t *turn) run(ctx context.Context) {
	docs, err := t.kernel.Docs(ctx, t.auth, t.ws)
	if err != nil {
		t.log.Warn("listing docs", "session", t.id, "err", err)
	}
	t.docs = docs
	for step := 0; step < t.config.MaxSteps; step++ {
		reply, err := t.ask(ctx)
		if err != nil {
			t.say(ctx, err.Error())
			return
		}
		msg := Message{Role: "assistant", Content: reply.Content, ToolCalls: reply.ToolCalls}
		if !t.append(ctx, msg) {
			return
		}
		if len(reply.ToolCalls) == 0 {
			return
		}
		for _, call := range reply.ToolCalls {
			result, run := t.tool(ctx, call)
			if !t.append(ctx, Message{Role: "tool", ToolCallID: call.ID, Name: call.Function.Name, Content: result, Run: run}) {
				return
			}
		}
	}
	t.say(ctx, fmt.Sprintf("I stopped after %d steps without finishing. Tell me how to continue.", t.config.MaxSteps))
}

// say ends the turn with a message of the agent's own, not the model's.
func (t *turn) say(ctx context.Context, text string) {
	t.append(ctx, Message{Role: "assistant", Content: text})
}

func (t *turn) append(ctx context.Context, m Message) bool {
	saved, err := t.kernel.Append(ctx, t.auth, t.ws, t.id, m)
	if err != nil {
		t.log.Error("writing the transcript", "session", t.id, "err", err)
		return false
	}
	t.session.Messages = append(t.session.Messages, saved)
	return true
}

type chatMessage struct {
	Role       string     `json:"role"`
	Content    *string    `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type reply struct {
	Content   string
	ToolCalls []ToolCall
}

// ask calls the model with the conversation so far.
func (t *turn) ask(ctx context.Context) (reply, error) {
	system := systemPrompt(t.session, t.docs, t.app, t.config.Model)
	request := map[string]any{
		"messages":   append([]chatMessage{{Role: "system", Content: &system}}, history(t.session.Messages)...),
		"tools":      tools,
		"max_tokens": t.config.MaxTokens,
	}
	status, body, err := t.kernel.Complete(ctx, t.auth, t.ws, t.id, t.config.Model, request)
	if err != nil {
		return reply{}, say("I could not reach my model: %v", err)
	}
	if status != http.StatusOK {
		return reply{}, modelRefusal(status, body, t.config.Model, t.app)
	}
	var answer struct {
		Choices []struct {
			Message struct {
				Content   *string    `json:"content"`
				ToolCalls []ToolCall `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &answer); err != nil || len(answer.Choices) == 0 {
		return reply{}, say("My model gave an answer I could not read.")
	}
	c := answer.Choices[0]
	r := reply{ToolCalls: c.Message.ToolCalls}
	if c.Message.Content != nil {
		r.Content = strings.TrimSpace(*c.Message.Content)
	}
	for i := range r.ToolCalls {
		r.ToolCalls[i].Type = "function"
		if r.ToolCalls[i].ID == "" {
			r.ToolCalls[i].ID = fmt.Sprintf("call_%d_%d", time.Now().UnixNano(), i)
		}
	}
	if r.Content == "" && len(r.ToolCalls) == 0 {
		if c.FinishReason == "length" {
			return reply{}, say("My answer was cut off before it began. Ask me again, more narrowly.")
		}
		return reply{}, say("My model answered with nothing.")
	}
	return r, nil
}

// modelRefusal explains a model call that did not answer.
func modelRefusal(status int, body []byte, model, app string) error {
	var e struct {
		Error any `json:"error"`
	}
	detail := strings.TrimSpace(string(body))
	if json.Unmarshal(body, &e) == nil && e.Error != nil {
		switch v := e.Error.(type) {
		case string:
			detail = v
		case map[string]any:
			if m, ok := v["message"].(string); ok {
				detail = m
			}
		}
	}
	switch status {
	case http.StatusTooManyRequests:
		return say("Your model budget, or the workspace's, is used up for now, so I cannot think. Try again later.")
	case http.StatusForbidden:
		return say("This chat cannot use my model: grant it %s in the chat's settings at %s/chat/ (%s).", modelCapability(model), app, detail)
	}
	if len(detail) > 300 {
		detail = detail[:300]
	}
	return say("My model failed (%d): %s", status, detail)
}

// tool runs one tool call and returns its result for the model, and the
// run's id if it ran code.
func (t *turn) tool(ctx context.Context, call ToolCall) (string, string) {
	var args map[string]any
	if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
		return toolError("the arguments are not JSON: " + err.Error()), ""
	}
	switch call.Function.Name {
	case "run_code":
		code, _ := args["code"].(string)
		if strings.TrimSpace(code) == "" {
			return toolError("code is required"), ""
		}
		r, err := t.kernel.Run(ctx, t.auth, t.ws, t.id, code)
		if err != nil {
			return toolError("the run did not happen: " + err.Error()), ""
		}
		return runResult(r, t.app), r.ID
	case "read_gadget_guide":
		return gadgetGuide, ""
	case "write_gadget":
		name, _ := args["name"].(string)
		source, _ := args["source"].(string)
		capabilities := []string{}
		if list, ok := args["capabilities"].([]any); ok {
			for _, c := range list {
				if s, ok := c.(string); ok && s != "" {
					capabilities = append(capabilities, s)
				}
			}
		}
		checks, _ := args["checks"].([]any)
		d, err := t.kernel.Draft(ctx, t.auth, t.ws, t.id, name, source, capabilities, checks)
		if err != nil {
			return toolError("the gadget was not stored: " + err.Error()), ""
		}
		return draftResult(d), ""
	case "read_doc":
		path, _ := args["path"].(string)
		doc, err := t.kernel.Doc(ctx, t.auth, t.ws, path)
		if err != nil {
			if StatusOf(err) == http.StatusNotFound || StatusOf(err) == http.StatusBadRequest {
				return toolError("there is no document " + path), ""
			}
			return toolError(err.Error()), ""
		}
		if len(doc) > docBytes {
			doc = doc[:docBytes] + "\n[the rest of the document is cut off]"
		}
		return doc, ""
	}
	return toolError("there is no tool " + call.Function.Name), ""
}

func toolError(msg string) string {
	b, _ := json.Marshal(map[string]any{"ok": false, "error": msg})
	return string(b)
}

// draftResult is what the model, and the chat page, learn of a draft.
func draftResult(d Draft) string {
	out := map[string]any{
		"ok":           d.Check.OK,
		"name":         d.Blueprint.Name,
		"version":      d.Blueprint.Version,
		"status":       d.Blueprint.Status,
		"capabilities": d.Blueprint.Capabilities,
		"check":        d.Check,
	}
	if d.Check.OK {
		out["note"] = "Stored as a draft. The user can try it, publish it and grant its capabilities from the chat."
	} else {
		out["note"] = "Stored, but it does not work: fix it and submit it again under the same name."
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// runResult is what the model learns of a run.
func runResult(r RunResult, app string) string {
	out := map[string]any{"ok": r.OK, "logs": r.Logs}
	if r.OK {
		out["value"] = r.Value
	} else {
		out["error"] = r.Error
	}
	if len(r.Approvals) > 0 {
		out["approvals"] = r.Approvals
		out["note"] = "These calls wait for the user's approval at " + app + "/gatekeeper/; the chat reports how each ends."
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// history turns the transcript into chat messages for the model: the
// latest ones, starting at a message from the user, with long tool
// results cut down. Kernel events (an approval settled, a turn
// interrupted) become notes from the user, after any tool results they
// came between, and a tool call that never got its result gets one.
func history(messages []Message) []chatMessage {
	start := len(messages)
	size := 0
	for start > 0 && len(messages)-start < contextMessages {
		size += len(messages[start-1].Content)
		if size > contextBytes {
			break
		}
		start--
	}
	for start < len(messages) && messages[start].Role != "user" {
		start++
	}
	var out []chatMessage
	var notes []string
	// Tool calls of the last assistant message that have no result yet.
	open := map[string]bool{}
	var openOrder []string
	closeOpen := func() {
		for _, id := range openOrder {
			if open[id] {
				missing := toolError("this call was interrupted and did not run")
				out = append(out, chatMessage{Role: "tool", Content: &missing, ToolCallID: id})
			}
		}
		open, openOrder = map[string]bool{}, nil
		for _, n := range notes {
			out = append(out, chatMessage{Role: "user", Content: &n})
		}
		notes = nil
	}
	for _, m := range messages[start:] {
		content := m.Content
		switch m.Role {
		case "tool":
			if !open[m.ToolCallID] {
				continue
			}
			open[m.ToolCallID] = false
			if len(content) > toolResultBytes {
				content = content[:toolResultBytes] + "\n[cut off]"
			}
			out = append(out, chatMessage{Role: "tool", Content: &content, ToolCallID: m.ToolCallID})
			if !anyOpen(open) {
				closeOpen()
			}
		case "event":
			notes = append(notes, "[kodo] "+content)
			if !anyOpen(open) {
				closeOpen()
			}
		case "assistant":
			closeOpen()
			msg := chatMessage{Role: "assistant", ToolCalls: m.ToolCalls}
			if content != "" || len(m.ToolCalls) == 0 {
				msg.Content = &content
			}
			out = append(out, msg)
			for _, c := range m.ToolCalls {
				open[c.ID] = true
				openOrder = append(openOrder, c.ID)
			}
		default:
			closeOpen()
			out = append(out, chatMessage{Role: "user", Content: &content})
		}
	}
	closeOpen()
	return out
}

func anyOpen(open map[string]bool) bool {
	for _, o := range open {
		if o {
			return true
		}
	}
	return false
}
