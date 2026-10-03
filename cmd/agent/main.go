// Command agent is the kodo agent: the chat at app.<domain>/chat/, where the
// agent plans, writes JavaScript and runs it in ephemeral cells with the
// grants the user gave the chat. It is stateless and has no authority of its
// own: sessions live in the kernel, and every call it makes is one the user,
// or the turn the user started, could make.
//
// Configuration is from the environment:
//
//	AGENT_ADDR  where it listens (default :8080)
//	KERNEL_URL  the fleet's kernel API, e.g. http://kodo.kodo.svc (required)
//
// How the agent works (its model, output limit and steps per turn) is a
// platform setting in the kernel, which platform admins change at
// app.<domain>/admin/; the kernel returns it with every turn.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ipedrazas/kodo/internal/agent"
	"github.com/ipedrazas/kodo/internal/version"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log)
	if err := run(log); err != nil {
		log.Error("agent stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	kernelURL := os.Getenv("KERNEL_URL")
	if kernelURL == "" {
		return errors.New("KERNEL_URL is required")
	}
	for _, old := range []string{"AGENT_MODEL", "AGENT_MAX_STEPS", "AGENT_MAX_TOKENS"} {
		if os.Getenv(old) != "" {
			log.Warn(old + " is ignored: the agent's settings are in the admin dashboard")
		}
	}
	s := &agent.Server{Kernel: agent.NewKernel(kernelURL), Log: log}
	srv := &http.Server{Addr: env("AGENT_ADDR", ":8080"), Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	errs := make(chan error, 1)
	go func() { errs <- srv.ListenAndServe() }()
	log.Info("agent started", "version", version.String(), "addr", srv.Addr, "kernel", kernelURL)

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	// Turns in progress are interrupted and say so before the pod goes.
	shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
	s.Shutdown(shutdown)
	log.Info("agent stopped")
	return nil
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
