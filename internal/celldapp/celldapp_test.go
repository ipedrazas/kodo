package celldapp

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// The kernel's tests run the gadgets built here under celld dev, from
// golden copies; go test ./internal/celldapp -update rewrites them.
var update = flag.Bool("update", false, "rewrite the golden gadgets in kernel/test/gadgets")

var golden = map[string]string{
	"Counter":  "../../kernel/test/gadgets/celld-counter.js",
	"Settings": "../../kernel/test/gadgets/celld-settings.js",
}

func load(t *testing.T) *Project {
	t.Helper()
	p, err := Load("testdata/app")
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoad(t *testing.T) {
	p := load(t)
	if p.Name != "celld-lab" || p.Main != "src/index.ts" {
		t.Errorf("name %q main %q", p.Name, p.Main)
	}
	if got, want := p.Classes(), []string{"Counter", "Settings", "Secret", "Reminder", "Tunnel"}; !slices.Equal(got, want) {
		t.Errorf("classes %v, want %v: another Worker's class is not the project's", got, want)
	}
	if _, err := Load("testdata/app/wrangler.jsonc"); err != nil {
		t.Errorf("load by config path: %v", err)
	}
	if _, err := Load("testdata/none"); err == nil {
		t.Error("loaded a project that does not exist")
	}
}

func TestClass(t *testing.T) {
	p := load(t)
	if c, err := p.Class("Counter"); err != nil || c != "Counter" {
		t.Errorf("Class(Counter) = %q, %v", c, err)
	}
	if _, err := p.Class("Remote"); err == nil {
		t.Error("picked another Worker's class")
	}
	if _, err := p.Class(""); err == nil || !strings.Contains(err.Error(), "pick one") {
		t.Errorf("no class named among several: %v", err)
	}
	if got := p.DefaultName("Counter"); got != "celld-lab-counter" {
		t.Errorf("DefaultName = %q", got)
	}
}

func TestBuild(t *testing.T) {
	p := load(t)
	for class, path := range golden {
		bundle, err := p.Build(class)
		if err != nil {
			t.Fatalf("%s: %v", class, err)
		}
		for _, want := range []string{`import { DurableObject } from "cloudflare:workers"`, "var App = class extends DurableObject", "is not available in a kodo gadget"} {
			if !bytes.Contains(bundle, []byte(want)) {
				t.Errorf("%s: bundle lacks %q", class, want)
			}
		}
		if *update {
			if err := os.WriteFile(path, bundle, 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(bundle, want) {
			t.Errorf("%s: the bundle differs from %s; run go test ./internal/celldapp -update", class, path)
		}
	}
}

func TestBuildRefuses(t *testing.T) {
	p := load(t)
	for class, want := range map[string]string{
		"Secret":   "uses env.API_KEY, env.LOADER;",
		"Reminder": "uses storage alarms",
		"Tunnel":   "imports cloudflare:sockets",
	} {
		bundle, err := p.Build(class)
		var u *Unsupported
		if !errors.As(err, &u) {
			t.Errorf("%s: err %v, want Unsupported", class, err)
			continue
		}
		if !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v, want %q", class, err, want)
		}
		if len(bundle) == 0 {
			t.Errorf("%s: no bundle with the problems", class)
		}
	}
}

func TestCheck(t *testing.T) {
	for _, tc := range []struct {
		src  string
		want int
	}{
		{"const k = process.env.NODE_ENV;", 0},
		{"const k = this.env.KEY;", 1},
		{"function f(env) { return env.KEY; }", 1},
		{"const k = env?.KEY;", 1},
		{"const k = myenv.KEY;", 0},
		{"ws.acceptWebSocket(s);", 1},
	} {
		if got := check([]byte(tc.src), ""); len(got) != tc.want {
			t.Errorf("check(%q) = %v, want %d problems", tc.src, got, tc.want)
		}
	}
}

func TestWrite(t *testing.T) {
	dir := t.TempDir()
	b := Blueprint{Name: "celld-lab-counter", Version: "0.1.0", Fleet: "kodo", Namespace: "kodo"}
	if err := b.Write(dir, []byte("export class App {}")); err != nil {
		t.Fatal(err)
	}
	manifest, _ := os.ReadFile(filepath.Join(dir, "blueprint.yaml"))
	for _, want := range []string{"name: celld-lab-counter-0.1.0", "blueprint: celld-lab-counter", `version: "0.1.0"`, "fleet: kodo"} {
		if !strings.Contains(string(manifest), want) {
			t.Errorf("blueprint.yaml lacks %q:\n%s", want, manifest)
		}
	}
	kust, _ := os.ReadFile(filepath.Join(dir, "kustomization.yaml"))
	if !strings.Contains(string(kust), "- name: celld-lab-counter-0.1.0") {
		t.Errorf("kustomization.yaml:\n%s", kust)
	}
	if src, _ := os.ReadFile(filepath.Join(dir, "gadget.js")); string(src) != "export class App {}" {
		t.Errorf("gadget.js = %q", src)
	}
}

func TestValidate(t *testing.T) {
	ok := Blueprint{Name: "counter", Version: "1.0.0-rc.1", Fleet: "kodo"}
	if err := ok.Validate(); err != nil {
		t.Error(err)
	}
	for _, b := range []Blueprint{
		{Name: "Counter", Version: "1.0.0", Fleet: "kodo"},
		{Name: "counter-", Version: "1.0.0", Fleet: "kodo"},
		{Name: "counter", Version: "1.0.0+build", Fleet: "kodo"},
		{Name: "counter", Version: "", Fleet: "kodo"},
		{Name: "counter", Version: "1.0.0"},
	} {
		if b.Validate() == nil {
			t.Errorf("%+v is valid", b)
		}
	}
}

func TestStripJSONC(t *testing.T) {
	in := `{"a": "x // y /* z */", // c
  /* block */ "b": [1, 2,], "c": "\"q\"",}`
	var got map[string]any
	if err := json.Unmarshal(stripJSONC([]byte(in)), &got); err != nil {
		t.Fatalf("%v: %s", err, stripJSONC([]byte(in)))
	}
	want := map[string]any{"a": "x // y /* z */", "b": []any{1.0, 2.0}, "c": `"q"`}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}
