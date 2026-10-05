// Command kodo is the kodo command line.
//
//	kodo publish [PROJECT] --version VERSION [--class CLASS] [--name NAME]
//
// publish takes a Durable Object class of a celld (Wrangler) project, runs
// it as a kodo gadget and publishes it as a Blueprint through the operator:
// it bundles the class, checks it, writes the gadget, its Blueprint and a
// kustomization to --out, and applies them with kubectl to the current
// context. Publishing a Blueprint is a platform admin's act, so kubectl needs
// rights on Blueprints and ConfigMaps in the fleet's namespace.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/ipedrazas/kodo/internal/celldapp"
	"github.com/ipedrazas/kodo/internal/version"
)

const usage = `usage: kodo publish [PROJECT] --version VERSION [flags]
       kodo version

publish runs a Durable Object class of a celld project as a kodo gadget and
publishes it as a Blueprint. PROJECT is a directory or Wrangler config
(default .). The class runs unchanged; it may not use env bindings, native
alarms or WebSockets, and reaches the network only through capability grants.
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "kodo:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return errors.New("no command")
	}
	switch args[0] {
	case "publish":
		return publish(args[1:])
	case "version", "--version":
		fmt.Println(version.String())
		return nil
	case "help", "-h", "--help":
		fmt.Print(usage)
		return nil
	default:
		fmt.Fprint(os.Stderr, usage)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func publish(args []string) error {
	fs := flag.NewFlagSet("publish", flag.ContinueOnError)
	class := fs.String("class", "", "the Durable Object class (default: the project's only one)")
	name := fs.String("name", "", "the Blueprint name (default: <worker name>-<class>)")
	ver := fs.String("version", "", "the Blueprint version, e.g. 0.1.0; a published version never changes (required)")
	fleet := fs.String("fleet", "kodo", "the Fleet to publish to")
	namespace := fs.String("namespace", "kodo", "the Fleet's namespace")
	kubeContext := fs.String("context", "", "the kubectl context (default: the current one)")
	out := fs.String("out", "", "where to write the gadget and its manifests (default: a temporary directory)")
	dryRun := fs.Bool("dry-run", false, "build, check and write, but do not apply")
	fs.Usage = func() {
		_, _ = fmt.Fprint(fs.Output(), usage, "\nflags:\n")
		fs.PrintDefaults()
	}
	// The project may come before or after the flags.
	project := "."
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		project, args = args[0], args[1:]
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() == 1 && project == "." {
		project = fs.Arg(0)
	} else if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments %v", fs.Args())
	}
	if *ver == "" {
		return errors.New("--version is required")
	}

	p, err := celldapp.Load(project)
	if err != nil {
		return err
	}
	c, err := p.Class(*class)
	if err != nil {
		return err
	}
	b := celldapp.Blueprint{Name: *name, Version: *ver, Fleet: *fleet, Namespace: *namespace}
	if b.Name == "" {
		b.Name = p.DefaultName(c)
	}
	if err := b.Validate(); err != nil {
		return err
	}
	bundle, err := p.Build(c)
	if err != nil {
		return err
	}
	dir := *out
	if dir == "" {
		if dir, err = os.MkdirTemp("", "kodo-publish-"); err != nil {
			return err
		}
	}
	if err := b.Write(dir, bundle); err != nil {
		return err
	}
	fmt.Printf("Built %s from %s (%d bytes) in %s\n", b.Object(), c, len(bundle), dir)
	if *dryRun {
		fmt.Printf("Publish it with: kubectl apply -k %s\n", dir)
		return nil
	}

	kubectl := func(args ...string) error {
		if *kubeContext != "" {
			args = append([]string{"--context", *kubeContext}, args...)
		}
		cmd := exec.Command("kubectl", args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		return cmd.Run()
	}
	if err := kubectl("apply", "-k", filepath.Clean(dir)); err != nil {
		return fmt.Errorf("kubectl apply: %w", err)
	}
	if err := kubectl("-n", b.Namespace, "wait", "blueprint/"+b.Object(), "--for=condition=Published", "--timeout=120s"); err != nil {
		return fmt.Errorf("waiting for %s to be published: %w", b.Object(), err)
	}
	fmt.Printf("Published Blueprint %s %s. Create a cell: POST /api/workspaces/<ws>/cells {\"blueprint\":%q}\n", b.Name, b.Version, b.Name)
	return nil
}
